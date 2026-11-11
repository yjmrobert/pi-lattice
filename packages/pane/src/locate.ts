/** Finding and connecting to the project's background host. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { emitEvent, type EventBus, HostClient } from "@pi-lattice/protocol";

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

/**
 * Ask for a host to be started for a project, then connect to it. The pane does not know
 * how hosts are started: it asks on the event bus, and whoever can start one does.
 */
export async function launchHost(bus: EventBus, stateDir: string, cwd: string, timeoutMs = 20_000): Promise<HostClient> {
	const existing = await connectHost(stateDir);
	if (existing) return existing;
	const request = { stateDir, cwd: projectRoot(cwd), claimed: false };
	emitEvent(bus, "lattice:host:launch", request);
	if (!request.claimed) {
		throw new Error("Nothing here can start a lattice host. Install the pi-lattice package into Pi, or start a host yourself with `pi-lattice daemon`.");
	}
	const end = Date.now() + timeoutMs;
	for (;;) {
		const client = await connectHost(stateDir);
		if (client) return client;
		if (Date.now() > end) {
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
