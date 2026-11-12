/**
 * The team's server, for one host. Which server, and who this person is on it, is one file in
 * the person's lattice home, shared by the host of every repository: this follows it, so joining
 * or leaving in one terminal takes effect in all of them.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkPort } from "@pi-lattice/host";
import type { WorkRequest, WorkResult, WorkSession, WorkState } from "@pi-lattice/protocol";
import { joinServer, type ServerAccount, WorkClient } from "@pi-lattice/server";

export const SERVER_FILE = "server.json";

/** Which server this person has joined, if any. */
export function readAccount(home: string): ServerAccount | undefined {
	try {
		const value = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as Partial<ServerAccount>;
		return typeof value.url === "string" && typeof value.name === "string" && typeof value.token === "string" ? { url: value.url, name: value.name, token: value.token } : undefined;
	} catch {
		return undefined;
	}
}

/** Join a server and remember it for every repository on this machine. */
export async function joinAndSave(home: string, address: string, name: string): Promise<ServerAccount> {
	const account = await joinServer(address, name);
	mkdirSync(home, { recursive: true });
	const file = join(home, SERVER_FILE);
	// The token is this person on the server: nobody else on the machine should read it.
	writeFileSync(file, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return account;
}

export interface WorkOptions {
	home: string;
	/** Tells this host apart from the same person's hosts for other repositories. */
	hostId: string;
	/** What the repository is called, for teammates. */
	repo: string;
	/** The name to join under when none is given. */
	name: () => string;
	/** How often what this host runs is said again, so the server does not forget it. */
	beatMs?: number;
}

export class Work implements WorkPort {
	private readonly options: WorkOptions;
	private readonly listeners: Array<() => void> = [];
	private client: WorkClient | undefined;
	private stamp = "";
	private sessions: Array<Omit<WorkSession, "host" | "owner" | "repo">> = [];
	private beat: NodeJS.Timeout | undefined;

	constructor(options: WorkOptions) {
		this.options = options;
	}

	onChanged(listener: () => void): void {
		this.listeners.push(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}

	/** Bring this in line with the file. Called at start, after a change here, and on a timer for changes made elsewhere. */
	sync(): void {
		const file = join(this.options.home, SERVER_FILE);
		let stamp = "";
		try {
			const stat = statSync(file);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			stamp = "";
		}
		if (stamp === this.stamp) return;
		this.stamp = stamp;
		this.client?.stop();
		this.client = undefined;
		if (this.beat) clearInterval(this.beat);
		this.beat = undefined;
		const account = readAccount(this.options.home);
		if (account) {
			const client = new WorkClient(account);
			client.onChanged(() => this.changed());
			client.start();
			this.client = client;
			this.beat = setInterval(() => this.send(), this.options.beatMs ?? 15_000);
			this.beat.unref();
		}
		this.changed();
	}

	stop(): void {
		this.client?.stop();
		this.client = undefined;
		if (this.beat) clearInterval(this.beat);
	}

	state(): WorkState | null {
		return this.client?.state() ?? null;
	}

	private must(): WorkClient {
		if (!this.client) throw new Error("There is no server: you have not joined one.");
		return this.client;
	}

	async run(request: WorkRequest): Promise<WorkResult> {
		const client = this.must();
		switch (request.do) {
			case "look":
				return { work: client.state() };
			case "read":
				return client.read(request.number);
			case "add":
				return { issue: await client.create(request.change) };
			case "update":
				return { issue: await client.update(request.number, request.change, request.basedOn) };
			case "comment":
				await client.comment(request.number, request.body);
				return { issue: client.issue(request.number) as NonNullable<WorkResult["issue"]> };
			case "scheme":
				return { scheme: await client.setScheme(request.scheme) };
			case "next": {
				// Work that is for another repository is left for the sessions there.
				const { do: _do, ...filter } = request;
				return client.next({ ...filter, repo: this.options.repo });
			}
			default:
				throw new Error("The host keeps which session is on what.");
		}
	}

	async session(number: number, event: "start" | "report"): Promise<void> {
		await this.must().session(number, event);
	}

	publish(sessions: Array<Omit<WorkSession, "host" | "owner" | "repo">>): void {
		this.sessions = sessions;
		this.send();
	}

	private send(): void {
		// Not reaching the server is shown by the copy going stale; saying it again here would only repeat it.
		void this.client?.publish(this.options.hostId, this.options.repo, this.sessions).catch(() => {});
	}

	async server(action: string, args: string[]): Promise<string> {
		const file = join(this.options.home, SERVER_FILE);
		if (action === "join") {
			const [address, name] = args;
			if (!address) throw new Error("Give the server's address: /lattice server https://lattice.example.com/#code");
			const before = readAccount(this.options.home);
			const account = await joinAndSave(this.options.home, address, name ?? this.options.name());
			this.sync();
			await this.client?.refresh().catch(() => {});
			const count = this.state()?.issues.length ?? 0;
			return `Joined ${account.url} as ${account.name}. ${count === 0 ? "There is no work on it yet." : `It has ${count} issue${count === 1 ? "" : "s"}.`}${before && before.url !== account.url ? ` You have left ${before.url}.` : ""} Press c in the pane for the canopy.`;
		}
		if (action === "leave") {
			const account = readAccount(this.options.home);
			if (!account) return "You have not joined a server.";
			rmSync(file, { force: true });
			this.sync();
			return `Left ${account.url}. Your name there, ${account.name}, stays taken: to come back as ${account.name} you need the file you just removed, so nothing was deleted from the server.`;
		}
		if (action === "status") {
			const state = this.state();
			if (!state) return existsSync(file) ? "The file that says which server you joined cannot be read." : "You have not joined a server. Join one with /lattice server <address>.";
			const online = state.people.filter((person) => person.online).length;
			return state.connected
				? `${state.url}, as ${state.me}. ${state.issues.length} issue${state.issues.length === 1 ? "" : "s"}, ${state.people.length} ${state.people.length === 1 ? "person" : "people"} (${online} online), ${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"} running.`
				: `${state.url}, as ${state.me}: ${state.problem ?? "not connected yet."} What is shown is what was last heard.`;
		}
		throw new Error(`Unknown server action "${action}". There is join, leave and status.`);
	}
}
