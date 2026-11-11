/**
 * The composition root: a host that shares with the person's network, run as a background process. This is the one
 * place that knows about both the host and collab; neither knows about the other.
 *
 * The lattice host as a background process. A person's own Pi starts it on demand and
 * talks to it over the local socket; it keeps the other sessions running headless, and
 * exits on its own once nobody is connected and nothing is working.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CollabSession, createNetwork, formatJoinCode, Identity, LanDiscovery, loadNetwork, type Network, networkKey, parseJoinCode, PeerBook, removeNetwork, saveNetwork, sharedPort, TcpTransport } from "@pi-lattice/collab";
import { encodeTree, latticeHome, TREES_DIR, treeEntryName, type UiState } from "@pi-lattice/protocol";
import { type HostOptions, LatticeHost, type SharingPort } from "@pi-lattice/host";

export interface DaemonOptions {
	stateDir: string;
	/** The project checkout: where adopted nodes work. */
	cwd: string;
	owner?: string;
	piArgs?: string[];
	extensionPaths?: string[];
	/** Where this person's network, people and keys are kept. Default: the lattice home. */
	home?: string;
	/** Look for teammates on the local network. Default: on, unless `LATTICE_DISCOVERY` is `off`. */
	discovery?: boolean;
	/** A join code: become a member of that network before starting. */
	join?: string;
	/** Host name or address teammates should use to reach this machine. Default: every network address it has. */
	advertise?: string;
	/** Exit after this long with no terminal connected and nothing working. 0 never exits. */
	idleExitMs?: number;
	tickMs?: number;
	hostOptions?: Partial<HostOptions>;
}

export interface Daemon {
	host: LatticeHost;
	/** Resolves when the daemon has stopped. */
	done: Promise<void>;
	stop(): Promise<void>;
}

/**
 * What a repository is, for the purpose of finding the teammates working on it: its first
 * commit, which every clone shares whatever it is called and wherever it is checked out.
 */
export function repoScope(cwd: string): string {
	try {
		const roots = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean).sort();
		if (roots[0]) return `git:${roots[0]}`;
	} catch {
		// Not a repository, or one with no commit yet.
	}
	return `dir:${basename(resolve(cwd))}`;
}

/**
 * Sharing with the person's network. The network is one file in the lattice home, used by
 * the host of every repository: this host follows it, so creating, joining or leaving a
 * network in one terminal takes effect in all of them, with nothing to switch on.
 */
class Sharing implements SharingPort {
	private collab: CollabSession | undefined;
	private network: Network | undefined;
	private stamp: string | undefined;
	private chain: Promise<void> = Promise.resolve();
	private readonly listeners: Array<() => void> = [];
	private readonly host: LatticeHost;
	private readonly options: DaemonOptions;
	private readonly networkPath: string;
	private readonly peoplePath: string;
	private readonly home: string;

	constructor(host: LatticeHost, options: DaemonOptions) {
		this.host = host;
		this.options = options;
		this.home = options.home ?? latticeHome(process.env, homedir());
		this.networkPath = join(this.home, "network.json");
		this.peoplePath = join(this.home, "people.json");
	}

	async restore(): Promise<void> {
		if (this.options.join !== undefined) this.join(this.options.join);
		await this.sync();
	}

	/** Bring sharing in line with the network file. Called at start, after every change here, and on a timer for changes made elsewhere. */
	sync(): Promise<void> {
		const run = this.chain.then(async () => {
			let stamp = "";
			try {
				const stat = statSync(this.networkPath);
				stamp = `${stat.mtimeMs}:${stat.size}`;
			} catch {
				// No network.
			}
			if (stamp === this.stamp) return;
			this.stamp = stamp;
			const network = loadNetwork(this.networkPath);
			if (network?.secret === this.network?.secret && network?.seeds.join() === this.network?.seeds.join()) return;
			await this.collab?.stop().catch(() => {});
			this.collab = undefined;
			this.network = network;
			if (network) await this.start(network);
			for (const listener of this.listeners) listener();
		});
		this.chain = run.catch((error: unknown) => {
			this.host.emit("log", "error", `Sharing could not start: ${error instanceof Error ? error.message : String(error)}`);
		});
		return run;
	}

	private async start(network: Network): Promise<void> {
		const cwd = resolve(this.options.cwd);
		const scope = repoScope(cwd);
		const key = networkKey(network);
		const advertise = this.options.advertise ?? process.env.LATTICE_ADVERTISE;
		const collab = new CollabSession({
			host: this.host,
			identity: Identity.loadOrCreate(join(this.home, "identity"), this.host.owner),
			network,
			peers: new PeerBook(this.peoplePath),
			// Every member's host for this repository tries the same port, so a teammate's machine is all anyone needs to know.
			transport: new TcpTransport({ port: sharedPort(key, scope), orAnyPort: true }),
			scope,
			...((this.options.discovery ?? process.env.LATTICE_DISCOVERY !== "off") ? { discovery: new LanDiscovery({ key, scope, name: this.host.owner }) } : {}),
			dir: join(this.host.stateDir, "collab"),
			projectDir: cwd,
			...(advertise ? { advertise } : {}),
		});
		collab.on("changed", () => {
			for (const listener of this.listeners) listener();
		});
		collab.on("log", (level, message) => this.host.emit("log", level, message));
		await collab.start();
		this.collab = collab;
	}

	async stop(): Promise<void> {
		await this.chain.catch(() => {});
		await this.collab?.stop();
	}

	onChanged(listener: () => void): void {
		this.listeners.push(listener);
	}

	state(): UiState["sharing"] {
		const collab = this.collab;
		if (!collab || !this.network) return null;
		return {
			network: this.network.name,
			people: collab.people().map((person) => ({ name: person.name, fingerprint: person.fingerprint, trust: person.trust, online: person.online, self: person.self })),
			handoffs: collab.handoffs().map((handoff) => ({
				nodeId: handoff.nodeId, nodeName: handoff.nodeName, from: handoff.from, to: handoff.to, state: handoff.state, role: handoff.role,
			})),
			requests: collab.requests().map((request) => ({ nodeId: request.nodeId, nodeName: request.nodeName, from: request.from, to: request.to, role: request.role })),
			pendingTransfers: collab.pendingTransfers(),
		};
	}

	fetchMessages(nodeId: string): Promise<unknown[]> {
		if (!this.collab) throw new Error("You are not in a network.");
		return this.collab.fetchMessages(nodeId);
	}

	private join(code: string): Network {
		const network = parseJoinCode(code);
		const current = loadNetwork(this.networkPath);
		if (current && current.secret !== network.secret) throw new Error(`You are in ${current.name}. Leave it before joining another network.`);
		// Joining again with a newer code adds the machines it names.
		saveNetwork(this.networkPath, { ...network, seeds: [...new Set([...(current?.seeds ?? []), ...network.seeds])] });
		return network;
	}

	async run(action: string, args: string[]): Promise<string> {
		const [first = "", second = ""] = args;
		if (action === "create") {
			const current = loadNetwork(this.networkPath);
			if (current) throw new Error(`You are already in ${current.name}. Leave it before creating another network.`);
			const network = createNetwork(first);
			saveNetwork(this.networkPath, network);
			await this.sync();
			return `Created ${network.name}. Give your teammates this code, over a channel you trust; whoever has it is in:\n${this.collab?.joinCode() ?? formatJoinCode(network)}`;
		}
		if (action === "join") {
			const network = this.join(first);
			await this.sync();
			return `You are in ${network.name}. Your teammates' sessions appear here as their machines are found.`;
		}
		if (action === "leave") {
			const current = loadNetwork(this.networkPath);
			if (!current) return "You are not in a network.";
			removeNetwork(this.networkPath);
			rmSync(this.peoplePath, { force: true });
			await this.sync();
			return `You left ${current.name}. Your sessions are no longer shown to anyone.`;
		}
		const collab = this.collab;
		if (!collab) throw new Error("You are not in a network. Create one, or join with a teammate's code.");
		switch (action) {
			case "code":
				return collab.joinCode();
			case "trust":
				await collab.trustPerson(first);
				return `${first}'s new key is accepted.`;
			case "offer":
				await collab.offer(first, second);
				return `Offered to ${second}. It is theirs as soon as they accept.`;
			case "accept":
				await collab.accept(first);
				return "Accepted. It is on its way.";
			case "confirm":
				await collab.confirm(first);
				return "Sent.";
			case "cancel":
				await collab.cancel(first);
				return "Handoff cancelled.";
			case "ask":
				await collab.ask(first);
				return `Asked ${this.host.node(first)?.owner ?? "its owner"}. It is yours as soon as they approve.`;
			case "withdraw":
				await collab.withdraw(first);
				return "Request withdrawn.";
			case "approve":
				await collab.approve(first, second);
				return `Approved. It goes to ${second} now.`;
			case "decline":
				await collab.decline(first, second);
				return `Declined. ${second} is told.`;
			case "refresh":
				collab.reach();
				await collab.refresh();
				return "Refreshed.";
			default:
				throw new Error(`Unknown sharing action "${action}".`);
		}
	}
}

/**
 * The extensions every headless session needs to take part in the tree. When this package
 * runs from the repository checkout that Pi has installed, that checkout is passed whole so
 * Pi recognises it as the package it already loaded and does not load it twice.
 */
export function sessionExtensionPaths(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	const repo = resolve(here, "..", "..", "..");
	try {
		const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
		if (manifest.pi?.extensions?.some((entry) => entry.includes("launcher"))) return [repo];
	} catch {
		// Not running from a checkout.
	}
	const require = createRequire(import.meta.url);
	return ["@pi-lattice/a2a", "@pi-lattice/roles", "@pi-lattice/graph"].map((name) => dirname(require.resolve(`${name}/package.json`)));
}

/** Read a JSON array of strings from an environment variable; used to configure hosts started on demand. */
function envList(name: string): string[] | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? value.map(String) : undefined;
	} catch {
		return undefined;
	}
}

export async function runDaemon(options: DaemonOptions): Promise<Daemon> {
	const stateDir = resolve(options.stateDir);
	mkdirSync(stateDir, { recursive: true });
	const piCommand = envList("LATTICE_PI_COMMAND");
	const piArgs = options.piArgs ?? envList("LATTICE_PI_ARGS");
	const extensionPaths = options.extensionPaths ?? envList("LATTICE_EXTENSION_PATHS") ?? sessionExtensionPaths();
	const host = await LatticeHost.start({
		stateDir,
		...(options.owner !== undefined ? { owner: options.owner } : {}),
		...(piCommand ? { piCommand } : {}),
		...(piArgs ? { piArgs } : {}),
		extensionPaths,
		...options.hostOptions,
	});
	const log = (level: string, message: string): void => {
		try {
			appendFileSync(join(stateDir, "daemon.log"), `${new Date().toISOString()} ${level} ${message}\n`);
		} catch {
			// Logging must never take the host down.
		}
	};
	host.on("log", log);
	const sharing = new Sharing(host, options);
	host.setSharing(sharing);
	try {
		await sharing.restore();
	} catch (error) {
		log("error", `Sharing could not start: ${error instanceof Error ? error.message : String(error)}`);
	}

	let finish!: () => void;
	const done = new Promise<void>((resolveDone) => {
		finish = resolveDone;
	});
	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return done;
		stopping = true;
		clearInterval(timer);
		await sharing.stop().catch(() => {});
		await host.stop();
		finish();
	};

	const idleExitMs = options.idleExitMs ?? 10 * 60_000;
	let idleSince = Date.now();
	const timer = setInterval(() => {
		if (host.shutdownRequested) {
			void stop();
			return;
		}
		// A network created, joined or left from another repository's terminal.
		void sharing.sync().catch(() => {});
		const { terminals, working } = host.activity();
		if (terminals > 0 || working > 0) idleSince = Date.now();
		else if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) {
			log("info", "Nobody is connected and nothing is working; stopping.");
			void stop();
		}
	}, options.tickMs ?? 2000);
	// Let this person's terminals in other repositories find this tree.
	try {
		const trees = join(options.home ?? latticeHome(process.env, homedir()), TREES_DIR);
		mkdirSync(trees, { recursive: true });
		writeFileSync(join(trees, treeEntryName(stateDir)), encodeTree({ stateDir, root: resolve(options.cwd) }));
	} catch (error) {
		log("error", `Could not record this tree for other terminals: ${error instanceof Error ? error.message : String(error)}`);
	}
	log("info", `Host started for ${stateDir} as ${host.owner}.`);
	return { host, done, stop };
}
