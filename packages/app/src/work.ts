/**
 * The team's server, for one host. Which server, and who this person is on it, is one file in
 * the person's lattice home, shared by the host of every repository: this follows it, so joining
 * or leaving in one terminal takes effect in all of them.
 */
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkPort } from "@pi-lattice/host";
import type { WorkRequest, WorkResult, WorkSession, WorkState } from "@pi-lattice/protocol";
import { joinServer, type Peering, type ServerAccount, WorkClient } from "@pi-lattice/server";
import { boardAddresses, ensureBoard, liveBoard, shareBoard } from "./board.ts";

/** A server joined, and whether it is the board on this machine. */
export type Account = ServerAccount & { board?: boolean };

export const SERVER_FILE = "server.json";

/** Which server this person has joined, if any. */
export function readAccount(home: string, file = join(home, SERVER_FILE)): Account | undefined {
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Account>;
		return typeof value.url === "string" && typeof value.name === "string" && typeof value.token === "string" ? { url: value.url, name: value.name, token: value.token, ...(value.board === true ? { board: true } : {}) } : undefined;
	} catch {
		return undefined;
	}
}

function saveAccount(file: string, account: Account): void {
	// The token is this person on the server: nobody else on the machine should read it.
	writeFileSync(file, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** Start `pi-lattice` with these arguments, detached, as this process was started. */
function spawnSelf(home: string): (args: string[]) => void {
	return (args) => {
		mkdirSync(join(home, "board"), { recursive: true });
		const log = openSync(join(home, "board", "board.log"), "a");
		const child = spawn(process.execPath, [...process.execArgv, process.argv[1] as string, ...args], { env: { ...process.env, LATTICE_HOME: home }, detached: true, stdio: ["ignore", log, log] });
		child.unref();
		closeSync(log);
	};
}

/** Join a server and remember it for every repository on this machine. */
export async function joinAndSave(home: string, address: string, name: string): Promise<ServerAccount> {
	const account = await joinServer(address, name);
	mkdirSync(home, { recursive: true });
	saveAccount(join(home, SERVER_FILE), account);
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
	/** Told what a person must act on. */
	warn?: (message: string) => void;
	/** Starts `pi-lattice` with the arguments given, detached: how the board on this machine is started. Default: as this process was. */
	spawnBoard?: (args: string[]) => void;
}

export class Work implements WorkPort {
	private readonly options: WorkOptions;
	private readonly listeners: Array<() => void> = [];
	private client: WorkClient | undefined;
	private stamp = "";
	private sessions: Array<Omit<WorkSession, "host" | "owner" | "repo">> = [];
	private beat: NodeJS.Timeout | undefined;
	private readonly spawnBoard: (args: string[]) => void;
	private reviving = 0;
	private refused = "";
	private peering: (Peering & { heard: (from: string, body: unknown) => void }) | undefined;
	private teams = new Map<string, { name: string; secret: string }>();

	constructor(options: WorkOptions) {
		this.options = options;
		this.spawnBoard = options.spawnBoard ?? spawnSelf(options.home);
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
		if (stamp === this.stamp) return this.revive();
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
			if (this.peering) client.listen(this.peering.scope, (from, body) => this.peering?.heard(from, body));
			this.beat = setInterval(() => this.send(), this.options.beatMs ?? 15_000);
			this.beat.unref();
		}
		this.changed();
	}

	/** The board on this machine stops when nobody has used it for a while, or with the machine. Whoever needs it starts it. */
	private revive(): void {
		const state = this.client?.state();
		if (!state || state.connected || !readAccount(this.options.home)?.board || Date.now() - this.reviving < 20_000) return;
		this.reviving = Date.now();
		void ensureBoard(this.options.home, this.spawnBoard).catch(() => {});
	}

	/** Join the board on this machine, starting it when needed. The name taken the first time is kept, so leaving and coming back is the same person. */
	private async onBoard(name: string): Promise<Account> {
		const home = this.options.home;
		const board = await ensureBoard(home, this.spawnBoard);
		const url = `http://127.0.0.1:${board.port}`;
		const kept = join(home, "board", "account.json");
		const had = readAccount(home, kept);
		const account: Account = had ? { ...had, url, board: true } : { ...(await joinServer(`${url}/#${board.code}`, name)), board: true };
		saveAccount(kept, account);
		saveAccount(join(home, SERVER_FILE), account);
		return account;
	}

	stop(): void {
		this.client?.stop();
		this.client = undefined;
		if (this.beat) clearInterval(this.beat);
	}

	state(): WorkState | null {
		return this.client?.state() ?? null;
	}

	/** The server this host is on, and as whom. */
	account(): { url: string; name: string } | undefined {
		const account = this.client?.account;
		return account ? { url: account.url, name: account.name } : undefined;
	}

	/** What lets the team's hosts connect to each other. Asked of the server once for each server joined. */
	async team(): Promise<{ name: string; secret: string }> {
		const client = this.must();
		const known = this.teams.get(client.account.url);
		if (known) return known;
		const team = await client.team();
		this.teams.set(client.account.url, team);
		return team;
	}

	/**
	 * Say that this host can be connected to, where, and with which key; and take what teammates
	 * hand the server for it. Undefined takes that back. One at a time: a host works on one thing.
	 */
	setPeering(peering: (Peering & { heard: (from: string, body: unknown) => void }) | undefined): void {
		const listen = peering && !this.peering && this.client;
		this.peering = peering;
		// The client's listening ends with the client, which is replaced when the server joined changes.
		if (listen) listen.listen(peering.scope, (from, body) => this.peering?.heard(from, body));
		this.send();
	}

	/** Hand the server something for a teammate's host that works on the same thing. */
	async signal(to: string, body: unknown): Promise<void> {
		if (!this.peering) throw new Error("This host is not sharing.");
		await this.must().signal(to, this.peering.scope, body);
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
		const peering = this.peering ? { scope: this.peering.scope, addresses: this.peering.addresses, key: this.peering.key } : undefined;
		void this.client?.publish(this.options.hostId, this.options.repo, this.sessions, peering).catch((error: unknown) => {
			// A key the server refuses is the one thing here a person must act on.
			const problem = error instanceof Error ? error.message : String(error);
			if (problem.includes("another key") && problem !== this.refused) this.options.warn?.(problem);
			this.refused = problem;
		});
	}

	async server(action: string, args: string[]): Promise<string> {
		const file = join(this.options.home, SERVER_FILE);
		if (action === "start") {
			const before = readAccount(this.options.home);
			if (before && !before.board) throw new Error(`You are on ${before.url}. Leave it first with /lattice server leave: a machine is on one server at a time.`);
			const account = await this.onBoard(args[0] ?? this.options.name());
			this.sync();
			await this.client?.refresh().catch(() => {});
			const count = this.state()?.issues.length ?? 0;
			return `A board is running on this machine, and you are on it as ${account.name}. ${count === 0 ? "There is no work on it yet: press c in the pane for the canopy, then N to add the first issue." : `It has ${count} issue${count === 1 ? "" : "s"}. Press c in the pane for the canopy.`} Only this machine can reach it. To let teammates join, /lattice server share.`;
		}
		if (action === "share" || action === "unshare") {
			if (!readAccount(this.options.home)?.board) throw new Error("Only the board on this machine can be shared from here. Start one with /lattice server start.");
			const board = await shareBoard(this.options.home, this.spawnBoard, action === "share");
			await this.client?.refresh().catch(() => {});
			if (action === "unshare") return "The board is no longer shared: only this machine can reach it. Teammates who joined keep their names, and see it again when it is shared again.";
			const addresses = boardAddresses(board);
			return addresses.length === 0
				? `The board is shared, but this machine has no network address to give out. Teammates join with /lattice server http://<this machine's address>:${board.port}/#${board.code}`
				: `The board is shared. On another machine, teammates join with${addresses.length > 1 ? " the line for the network they are on" : ""}:\n\n${addresses.map((address) => `  /lattice server ${address}`).join("\n")}\n\nAnyone with that address can read and change everything on it. It speaks plain HTTP: share it only on a network you trust, such as a VPN. It is reachable while this machine is on; stop sharing with /lattice server share off.`;
		}
		if (action === "join") {
			const [address, name] = args;
			if (!address) throw new Error("Give the server's address: /lattice server https://lattice.example.com/#code");
			const before = readAccount(this.options.home);
			if ((await liveBoard(this.options.home))?.shared) throw new Error("This machine shares its own board. Stop sharing first with /lattice server share off, so teammates are not left on a board nobody looks at.");
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
			if (account.board) return "Left the board on this machine. Its work is kept: /lattice server start brings it back.";
			return `Left ${account.url}. Your name there, ${account.name}, stays taken: to come back as ${account.name} you need the file you just removed, so nothing was deleted from the server.`;
		}
		if (action === "status") {
			const state = this.state();
			if (!state) return existsSync(file) ? "The file that says which server you joined cannot be read." : "You are on no server. Start a board on this machine with /lattice server start, or join your team's with /lattice server <address>.";
			const online = state.people.filter((person) => person.online).length;
			const board = readAccount(this.options.home)?.board ? await liveBoard(this.options.home) : undefined;
			const where = board ? `The board on this machine${board.shared ? `, shared at ${boardAddresses(board).join(" and ") || `port ${board.port}`}` : ", not shared"}` : state.url;
			return state.connected
				? `${where}, as ${state.me}. ${state.issues.length} issue${state.issues.length === 1 ? "" : "s"}, ${state.people.length} ${state.people.length === 1 ? "person" : "people"} (${online} online), ${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"} running.`
				: `${state.url}, as ${state.me}: ${state.problem ?? "not connected yet."} What is shown is what was last heard.`;
		}
		throw new Error(`Unknown server action "${action}". There is start, share, unshare, join, leave and status.`);
	}
}
