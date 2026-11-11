/** Spawn real Pi processes in RPC mode for integration tests, isolated from the developer's Pi config. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "../..");
const cliPath = join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

export const extensionPaths = {
	faux: join(here, "faux-provider.ts"),
	a2a: join(repoRoot, "packages/a2a"),
	roles: join(repoRoot, "packages/roles"),
	graph: join(repoRoot, "packages/graph"),
	collab: join(repoRoot, "packages/collab"),
	pane: join(repoRoot, "packages/pane"),
	/** The launcher extension from the app package: starts a background host when the pane asks. */
	launcher: join(repoRoot, "packages/app/src/launcher.ts"),
};
export const piCli = cliPath;
export const directorScript = join(here, "director.mjs");

/** One isolated world: a Pi agent dir, a lattice home, a working directory, a sessions dir. */
export interface Sandbox {
	root: string;
	agentDir: string;
	home: string;
	work: string;
	sessions: string;
	cleanup(): void;
}

export function createSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pi-lattice-test-"));
	const sandbox = {
		root,
		agentDir: join(root, "agent"),
		home: join(root, "lattice"),
		work: join(root, "work"),
		sessions: join(root, "sessions"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
	for (const dir of [sandbox.agentDir, sandbox.home, sandbox.work, sandbox.sessions]) mkdirSync(dir, { recursive: true });
	// The scripted model only reports to its parent when a test tells it to, so the reminder a quiet
	// child gets would add turns to every test. Tests about the reminder switch it back on.
	writeFileSync(join(sandbox.home, "config.json"), JSON.stringify({ reports: { remind: false } }));
	return sandbox;
}

// biome-ignore lint/suspicious/noExplicitAny: RPC events are loosely typed JSON records
export type RpcEvent = Record<string, any>;

export interface PiChildOptions {
	name: string;
	extensions?: string[];
	env?: Record<string, string>;
	args?: string[];
	cwd?: string;
	script?: string;
}

export class PiChild {
	readonly name: string;
	readonly client: RpcClient;
	readonly events: RpcEvent[] = [];

	constructor(name: string, client: RpcClient) {
		this.name = name;
		this.client = client;
		client.onEvent((event) => this.events.push(event as RpcEvent));
	}

	/** Send a prompt (or slash command) and wait until the session settles. */
	async prompt(text: string): Promise<void> {
		await this.client.promptAndWait(text, undefined, 20_000);
	}

	/** Run an extension command. Commands do not start an agent run, so there is nothing to wait for. */
	async command(text: string): Promise<void> {
		await this.client.prompt(text);
	}

	async waitFor<T>(probe: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const value = probe();
			if (value) return value;
			if (Date.now() > end) throw new Error(`${this.name}: timed out waiting for ${what}\nstderr: ${this.client.getStderr().slice(-600)}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	/** Text of every completed assistant message so far. */
	assistantTexts(): string[] {
		return this.events
			.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
			.map((event) => (event.message.content as RpcEvent[]).filter((part) => part.type === "text").map((part) => part.text).join(""));
	}

	/** Wait for an assistant message containing the given text. */
	async waitForAssistant(needle: string, timeoutMs = 10_000): Promise<string> {
		return this.waitFor(() => this.assistantTexts().find((text) => text.includes(needle)), `assistant text containing "${needle}"`, timeoutMs);
	}

	/** Notifications raised by extensions through ctx.ui.notify. */
	notifications(): string[] {
		return this.events.filter((event) => event.type === "extension_ui_request" && event.method === "notify").map((event) => String(event.message));
	}

	toolResults(toolName: string): RpcEvent[] {
		return this.events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName);
	}

	/** Answer a blocking extension dialog. RpcClient has no public method for this (ADR 0005). */
	answer(id: string, payload: Record<string, unknown>): void {
		const child = (this.client as unknown as { process: { stdin: NodeJS.WritableStream } }).process;
		child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`);
	}

	async stop(): Promise<void> {
		await this.client.stop();
	}
}

export async function startPi(sandbox: Sandbox, options: PiChildOptions): Promise<PiChild> {
	const extensions = [extensionPaths.faux, ...(options.extensions ?? [])];
	const client = new RpcClient({
		cliPath,
		cwd: options.cwd ?? sandbox.work,
		provider: "lattice-faux",
		model: "scripted",
		env: {
			PI_CODING_AGENT_DIR: sandbox.agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			LATTICE_HOME: sandbox.home,
			LATTICE_OWNER: "tester",
			LATTICE_NODE_NAME: options.name,
			LATTICE_FAUX_SCRIPT: options.script ?? directorScript,
			...options.env,
		},
		args: [...extensions.flatMap((path) => ["-e", path]), "--session-dir", sandbox.sessions, "--no-skills", "--no-context-files", ...(options.args ?? [])],
	});
	const child = new PiChild(options.name, client);
	await client.start();
	return child;
}

/** Look up a node id by the name it registered with the file transport. */
export async function nodeIdOf(sandbox: Sandbox, name: string, timeoutMs = 10_000): Promise<string> {
	const dir = join(sandbox.home, "nodes");
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			for (const id of readdirSync(dir)) {
				try {
					const info = JSON.parse(readFileSync(join(dir, id, "node.json"), "utf8")) as { name?: string };
					if (info.name === name) return id;
				} catch {
					// Not registered yet.
				}
			}
		} catch {
			// Directory not created yet.
		}
		if (Date.now() > end) throw new Error(`no node registered as "${name}"`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Names of the mail files a node holds in a state directory. */
export function mailIn(sandbox: Sandbox, nodeId: string, state: string): string[] {
	try {
		return readdirSync(join(sandbox.home, "nodes", nodeId, "mail", state)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

/** Options that make a LatticeHost run its sessions against the scripted model inside a sandbox. */
export function hostOptionsFor(sandbox: Sandbox, overrides: Record<string, unknown> = {}): {
	stateDir: string; userDir: string; owner: string; piCommand: string[]; piArgs: string[]; extensionPaths: string[]; env: Record<string, string>; socketDir: string; startTimeoutMs: number;
} & Record<string, unknown> {
	return {
		stateDir: join(sandbox.root, "state"),
		// The person's own settings come from the sandbox, never from whoever runs the tests.
		userDir: sandbox.home,
		owner: "tester",
		piCommand: [process.execPath, cliPath],
		piArgs: ["-e", extensionPaths.faux, "--provider", "lattice-faux", "--model", "scripted", "--no-skills", "--no-context-files"],
		extensionPaths: [extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
		env: {
			PI_CODING_AGENT_DIR: sandbox.agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			LATTICE_FAUX_SCRIPT: directorScript,
		},
		socketDir: join(sandbox.root, "sock"),
		startTimeoutMs: 20_000,
		...overrides,
	};
}

export async function eventually<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
