/** Finding, starting and connecting to the project's background host. */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostClient } from "@pi-lattice/protocol";

/** The directory that owns the tree for a working directory: the main checkout of its repository, else itself. */
export function projectRoot(cwd: string): string {
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return dirname(isAbsolute(common) ? common : resolve(cwd, common));
	} catch {
		return resolve(cwd);
	}
}

export function stateDirFor(cwd: string): string {
	return process.env.LATTICE_STATE_DIR ?? join(projectRoot(cwd), ".lattice");
}

interface HostInfo {
	socket: string;
	pid: number;
	owner: string;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function hostInfo(stateDir: string): HostInfo | undefined {
	try {
		const info = JSON.parse(readFileSync(join(stateDir, "host.json"), "utf8")) as HostInfo;
		return typeof info.socket === "string" && alive(info.pid) ? info : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a tree has ever been started for this state directory. */
export function hasTree(stateDir: string): boolean {
	return existsSync(join(stateDir, "host.db"));
}

/** Connect to a running host as this person's terminal. Resolves undefined when none is running. */
export async function connectHost(stateDir: string): Promise<HostClient | undefined> {
	const info = hostInfo(stateDir);
	if (!info) return undefined;
	let token: string;
	try {
		token = readFileSync(join(stateDir, "ui.token"), "utf8").trim();
	} catch {
		return undefined;
	}
	const socket = connect(info.socket);
	socket.setEncoding("utf8");
	const client = new HostClient({ stream: socket, token, nodeId: "ui", channel: "ui", pid: process.pid });
	try {
		await Promise.race([client.ready(), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 3000).unref())]);
		return client;
	} catch {
		client.close();
		socket.destroy();
		return undefined;
	}
}

/** The host's command-line entry point, found through this package's dependency on it. */
function hostCli(): string {
	try {
		return join(dirname(createRequire(import.meta.url).resolve("@pi-lattice/host/package.json")), "src", "cli.ts");
	} catch {
		return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "host", "src", "cli.ts");
	}
}

/**
 * The Pi package the headless sessions should load so they get the same lattice
 * extensions as this terminal: the bundle this file ships in.
 */
function bundlePaths(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const repo = resolve(here, "..", "..", "..");
	try {
		const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
		if (manifest.pi?.extensions?.some((entry) => entry.includes("pane"))) return [repo];
	} catch {
		// Not running from the bundle.
	}
	return ["pane", "a2a", "roles", "graph"].map((name) => resolve(here, "..", "..", name));
}

/** Start the background host for a project and connect to it. */
export async function startHost(stateDir: string, cwd: string, timeoutMs = 20_000): Promise<HostClient> {
	const existing = await connectHost(stateDir);
	if (existing) return existing;
	mkdirSync(stateDir, { recursive: true });
	const log = openSync(join(stateDir, "daemon.err"), "a");
	const child = spawn(process.execPath, [hostCli(), "daemon", "--state", stateDir, "--cwd", projectRoot(cwd)], {
		cwd: projectRoot(cwd),
		detached: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, LATTICE_EXTENSION_PATHS: process.env.LATTICE_EXTENSION_PATHS ?? JSON.stringify(bundlePaths()) },
	});
	child.unref();
	closeSync(log);
	const end = Date.now() + timeoutMs;
	for (;;) {
		const client = await connectHost(stateDir);
		if (client) return client;
		if (child.exitCode !== null || Date.now() > end) {
			let detail = "";
			try {
				detail = readFileSync(join(stateDir, "daemon.err"), "utf8").trim().split("\n").slice(-3).join(" ");
			} catch {
				// No output.
			}
			throw new Error(`The lattice host did not start. ${detail}`.trim());
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
}
