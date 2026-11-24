/** Finding and connecting to the project's background host. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { decodeTree, emitEvent, type EventBus, HostClient, type KnownTree, latticeHome, mainCheckout, TREES_DIR } from "@pi-lattice/protocol";

/** The directory that owns the tree for a working directory: the main checkout of its repository, else itself. */
export function projectRoot(cwd: string): string {
	const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		const common = git("rev-parse", "--git-common-dir");
		const commonDir = isAbsolute(common) ? common : resolve(cwd, common);
		return mainCheckout(commonDir, () => {
			try {
				return git("--git-dir", commonDir, "rev-parse", "--show-toplevel");
			} catch {
				return undefined; // a bare repository: it has no checkout of its own
			}
		});
	} catch {
		return resolve(cwd);
	}
}

/**
 * What is asked for every frame that is drawn: the answer of the last moment, by what was asked.
 * Each of these runs git, which is far more than a frame should cost.
 */
const lately = new Map<string, { at: number; value: unknown }>();
function recent<T>(key: string, ask: () => T): T {
	const now = Date.now();
	const held = lately.get(key);
	if (held && now - held.at < 1000) return held.value as T;
	const value = ask();
	if (lately.size > 64) lately.clear();
	lately.set(key, { at: now, value });
	return value;
}
/** {@link projectRoot}, asked at most once a second for a directory: for drawing. */
export const projectRootLately = (cwd: string): string => recent(`root\n${cwd}`, () => projectRoot(cwd));
/** {@link inRepository}, asked at most once a second for a directory: for drawing. */
export const inRepositoryLately = (cwd: string): boolean => recent(`in\n${cwd}`, () => inRepository(cwd));

/** Whether a directory is inside a git repository. */
export function inRepository(cwd: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
		return true;
	} catch {
		return false;
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

/** Every tree this person's hosts have recorded that still exists, whether or not its host is running. */
export function knownTrees(): KnownTree[] {
	const dir = join(latticeHome(process.env, homedir()), TREES_DIR);
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const trees: KnownTree[] = [];
	for (const name of names) {
		try {
			const tree = decodeTree(readFileSync(join(dir, name), "utf8"));
			if (tree && hasTree(tree.stateDir)) trees.push(tree);
		} catch {
			// Unreadable entries are skipped.
		}
	}
	return trees;
}
