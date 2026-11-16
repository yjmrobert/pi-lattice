/**
 * One scenario's world: a scratch repository, a host running real Pi sessions in it, and a
 * server when the scenario is about the team's work. Everything a scenario looks at afterwards
 * is read from here: what was said, which tools were called, which files changed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinAndSave, Work } from "../../packages/app/src/work.ts";
import { LatticeHost } from "../../packages/host/src/index.ts";
import type { Issue, NodeMeta } from "../../packages/protocol/src/index.ts";
import { joinServer, WorkClient, WorkServer } from "../../packages/server/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const OWNER = "evaluator";

export interface WorldOptions {
	/** The model, as `pi --model` takes it. Absent, the one Pi is set up with. */
	model?: string;
	/** Run the scripted model: nothing is checked about wording, only that the scenario itself works. */
	faux?: boolean;
	/** With a server for the team's work, joined by the host. */
	board?: boolean;
	minutes: number;
}

export interface ToolCall {
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: tool arguments are whatever the model sent
	args: Record<string, any>;
}

type Message = { role: string; content: unknown };

export class World {
	readonly scratch: string;
	/** The repository the sessions work in. */
	readonly work: string;
	readonly host: LatticeHost;
	/** Why the scenario cannot go on, when a session waits on a question nobody is here to answer. */
	blocked = "";
	private readonly options: WorldOptions;
	private server: WorkServer | undefined;
	private link: Work | undefined;
	private address = "";
	private readonly clients: WorkClient[] = [];
	readonly log: string[] = [];

	private constructor(scratch: string, host: LatticeHost, options: WorldOptions) {
		this.scratch = scratch;
		this.work = join(scratch, "work");
		this.host = host;
		this.options = options;
		host.on("log", (level, message) => {
			if (level !== "info") this.log.push(`${level}: ${message}`);
		});
	}

	static async start(name: string, options: WorldOptions): Promise<World> {
		const scratch = mkdtempSync(join(tmpdir(), `pi-lattice-eval-${name}-`));
		const work = join(scratch, "work");
		execFileSync("git", ["init", "-q", work]);
		execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: work });
		const home = join(scratch, "lattice");
		mkdirSync(home, { recursive: true });
		const extensionPaths = ["packages/a2a", "packages/roles", "packages/graph"].map((path) => join(root, path));
		const host = await LatticeHost.start({
			stateDir: join(scratch, "state"),
			// Settings and templates come from here, so the run checks the built-in texts.
			userDir: home,
			owner: OWNER,
			piCommand: [process.execPath, cli],
			// The person's own extensions, skills and context files stay out of it: this checks the roles, not their setup.
			piArgs: options.faux
				? ["-e", join(root, "test/support/faux-provider.ts"), "--provider", "lattice-faux", "--model", "scripted", "--no-extensions", "--no-skills", "--no-context-files"]
				: ["--no-extensions", "--no-skills", "--no-context-files", ...(options.model ? ["--model", options.model] : [])],
			extensionPaths,
			...(options.faux ? { env: { PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", LATTICE_FAUX_SCRIPT: join(root, "test/support/director.mjs") } } : {}),
		});
		const world = new World(scratch, host, options);
		if (options.board) await world.join();
		return world;
	}

	private async join(): Promise<void> {
		this.server = new WorkServer({ file: ":memory:", host: "127.0.0.1" });
		this.address = `http://127.0.0.1:${await this.server.start()}/#${this.server.tracker.code}`;
		const home = join(this.scratch, "lattice");
		await joinAndSave(home, this.address, OWNER);
		this.link = new Work({ home, hostId: "eval:work", repo: "work", name: () => OWNER, beatMs: 500 });
		this.host.setWork(this.link);
		this.link.sync();
		await this.wait(() => this.host.uiState().work?.connected === true, 15_000);
	}

	/** Someone else on the server: a teammate, or an agent that is not a session of this host. */
	async client(name: string): Promise<WorkClient> {
		const client = new WorkClient(await joinServer(this.address, name), { waitSeconds: 5 });
		this.clients.push(client);
		client.start();
		await this.wait(() => client.state().connected, 15_000);
		return client;
	}

	issues(): Issue[] {
		return this.host.uiState().work?.issues ?? [];
	}

	issue(number: number): Issue | undefined {
		return this.issues().find((issue) => issue.number === number);
	}

	/** Put a file in the repository and commit it, so that what a session changes can be told from what was there. */
	file(path: string, text: string): void {
		const full = join(this.work, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
		execFileSync("git", ["add", "-A"], { cwd: this.work });
		execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-q", "-m", `add ${path}`], { cwd: this.work });
	}

	read(path: string, cwd = this.work): string | undefined {
		const full = join(cwd, path);
		return existsSync(full) ? readFileSync(full, "utf8") : undefined;
	}

	/** The files in a working directory that differ from what was committed: changed, added or removed. */
	changed(cwd = this.work): string[] {
		return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean).map((line) => line.slice(3));
	}

	private async messages(id: string): Promise<Message[]> {
		return (await this.host.readMessages(id)) as Message[];
	}

	/** Everything a session's agent said in words, one entry per message. */
	async texts(id: string): Promise<string[]> {
		return (await this.messages(id))
			.filter((message) => message.role === "assistant")
			.map((message) => (Array.isArray(message.content) ? message.content : []).filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "").join(""))
			.filter((text) => text.trim() !== "");
	}

	/** The last thing a session's agent said in words. */
	async last(id: string): Promise<string> {
		return (await this.texts(id)).at(-1) ?? "";
	}

	/** Every tool a session's agent called, in order. */
	async tools(id: string): Promise<ToolCall[]> {
		return (await this.messages(id))
			.filter((message) => message.role === "assistant")
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []).filter((part: { type?: string }) => part.type === "toolCall").map((part: { name?: string; arguments?: unknown }) => ({ name: String(part.name ?? ""), args: (part.arguments ?? {}) as ToolCall["args"] })));
	}

	/** Everything a session was shown and said, as one text: for what must not appear anywhere in it. */
	async history(id: string): Promise<string> {
		return JSON.stringify(await this.messages(id));
	}

	/** The roles a session has applied now, which it may have changed since it was created. */
	roles(id: string): string[] {
		const node = this.host.node(id);
		const file = node?.sessionFile;
		if (!file || !existsSync(file)) return node?.fragments ?? [];
		let found: string[] | undefined;
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.includes("lattice:roles")) continue;
			try {
				const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { fragments?: unknown } };
				if (entry.type === "custom" && entry.customType === "lattice:roles" && Array.isArray(entry.data?.fragments)) found = entry.data.fragments.filter((name): name is string => typeof name === "string");
			} catch {
				// Not an entry.
			}
		}
		return found ?? node?.fragments ?? [];
	}

	nodes(): NodeMeta[] {
		return this.host.nodes();
	}

	/** Nothing is running, starting or waiting to start. */
	quiet(): boolean {
		return this.host.nodes().every((node) => node.status === "idle" || node.status === "dormant" || node.status === "exited" || node.status === "failed");
	}

	private async wait(done: () => boolean | Promise<boolean>, ms: number, every = 100): Promise<boolean> {
		const end = Date.now() + ms;
		for (;;) {
			if (await done()) return true;
			if (Date.now() > end) return false;
			await new Promise((next) => setTimeout(next, every));
		}
	}

	/**
	 * Wait for something to be so, for as long as the scenario is given. Stops early, and says
	 * why in `blocked`, when a session waits on a question: nobody is here to answer it.
	 */
	async until(done: () => boolean | Promise<boolean>): Promise<boolean> {
		return this.wait(async () => {
			for (const node of this.host.nodes()) {
				const dialog = this.host.dialogs(node.id)[0];
				if (dialog) this.blocked = `"${node.name}" is waiting on a question nobody is here to answer: ${dialog.title}`;
			}
			return this.blocked !== "" || (await done());
		}, this.options.minutes * 60_000, this.options.faux ? 200 : 2000).then((ok) => ok && this.blocked === "");
	}

	/** What the sessions used, in all. */
	usage(): { tokens: number; cost: number } {
		return this.host.nodes().reduce((sum, node) => ({ tokens: sum.tokens + (node.usage?.tokens ?? 0), cost: sum.cost + (node.usage?.cost ?? 0) }), { tokens: 0, cost: 0 });
	}

	async stop(): Promise<void> {
		for (const client of this.clients.splice(0)) client.stop();
		this.link?.stop();
		await this.host.stop();
		await this.server?.stop();
	}
}
