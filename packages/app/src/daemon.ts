/**
 * The composition root: a host that shares with the person's team, run as a background process. This is the one
 * place that knows about both the host and collab; neither knows about the other.
 *
 * The lattice host as a background process. A person's own Pi starts it on demand and
 * talks to it over the local socket; it keeps the other sessions running headless, and
 * exits on its own once nobody is connected and nothing is working.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CollabSession, Identity, isPersonName, type Network, PeerBook, TcpTransport } from "@pi-lattice/collab";
import { encodeTree, latticeHome, type NodeMeta, toggleSetting, TREES_DIR, treeEntryName, type UiState } from "@pi-lattice/protocol";
import { type HostOptions, LatticeHost, repoName, type SharingPort } from "@pi-lattice/host";
import { PEOPLE_FILE, Work } from "./work.ts";

export interface DaemonOptions {
	stateDir: string;
	/** The project checkout: where adopted nodes work. */
	cwd: string;
	owner?: string;
	piArgs?: string[];
	extensionPaths?: string[];
	/** Where this person's server, people and keys are kept. Default: the lattice home. */
	home?: string;
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

/** Where a teammate can clone a repository from: its `origin`, when it has one. */
function cloneUrl(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** The name a person chose to go by, kept in their lattice home so that every repository's host uses it. */
export function chosenName(home: string): string | undefined {
	try {
		const name = readFileSync(join(home, "name"), "utf8").trim();
		return isPersonName(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

export function chooseName(home: string, name: string): void {
	if (!isPersonName(name)) throw new Error(`"${name}" cannot be used as a name. Use letters, digits, dot, dash or underscore.`);
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "name"), `${name}\n`);
}

/** The name given for this run alone, which the chosen one does not replace. */
const givenName = (options: Pick<DaemonOptions, "owner">): string | undefined => options.owner ?? (process.env.LATTICE_OWNER || undefined);

/**
 * Sharing sessions with the person's team: the people on the server they have joined. The
 * server is one file in the lattice home, used by the host of every repository: this host
 * follows it, so joining or leaving a server in one terminal takes effect in all of them.
 *
 * The server says who is on the team, which key each signs with and where their hosts are,
 * and carries offers and requests. Sessions go straight between the two machines.
 */
const NO_TEAM = "Sessions are shared with the people on your server, and you are on none. Join your team's with /lattice server <address>, or start a board with /lattice server start and share it.";

class Sharing implements SharingPort {
	private collab: CollabSession | undefined;
	private network: Network | undefined;
	private scope = "";
	/** What the team is called in the pane: the server it is on. */
	private shown = "";
	private stamp: string | undefined;
	private warned = false;
	private chain: Promise<void> = Promise.resolve();
	private readonly listeners: Array<() => void> = [];
	private readonly host: LatticeHost;
	private readonly options: DaemonOptions;
	private readonly home: string;
	private readonly work: Work;

	constructor(host: LatticeHost, options: DaemonOptions, work: Work) {
		this.host = host;
		this.options = options;
		this.work = work;
		work.onChanged(() => this.introduce());
		this.home = options.home ?? latticeHome(process.env, homedir());
	}

	/** Bring sharing in line with the server this person is on. Called at start, after every change here, and on a timer for changes made elsewhere. */
	sync(): Promise<void> {
		const run = this.chain.then(async () => {
			// A repository can be kept to oneself; that is a setting, read each time.
			const share = toggleSetting(this.host.settings(), "network.share");
			const account = this.work.account();
			const stamp = `${share}|${this.wanted()}|${account?.url ?? ""}|${account?.name ?? ""}`;
			if (stamp === this.stamp) return;
			this.stamp = stamp;
			if (this.outdated() && !this.warned) {
				this.warned = true;
				this.host.emit("log", "notice", `You now go by ${this.wanted()}. This repository's sessions are still under ${this.host.owner}: /lattice restart here brings them along.`);
			}
			let network: Network | undefined;
			// Two names for one person would be two people to everyone else: stay out until restarted.
			if (account && share && !this.outdated()) {
				if (account.name !== this.host.owner) {
					this.host.emit("log", "notice", `On the server you are ${account.name}, and here ${this.host.owner}: teammates cannot tell these are one person, so sessions are not shared. Join the server as ${this.host.owner}, or go by ${account.name} with /lattice name.`);
				} else {
					try {
						network = await this.work.team();
					} catch {
						// The server is not there yet: look again on the next beat.
						this.stamp = undefined;
						return;
					}
				}
			}
			if (network?.secret === this.network?.secret) return;
			await this.collab?.stop().catch(() => {});
			this.work.setPeering(undefined);
			this.collab = undefined;
			this.network = network;
			this.shown = !account ? "" : account.board ? "your board" : account.url.replace(/^\w+:\/\//, "").replace(/\/.*$/, "");
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
		this.scope = scope;
		const advertise = this.options.advertise ?? process.env.LATTICE_ADVERTISE;
		const work = this.work;
		const identity = Identity.loadOrCreate(join(this.home, "identity"), this.host.owner);
		const collab = new CollabSession({
			host: this.host,
			identity,
			network,
			peers: new PeerBook(join(this.home, PEOPLE_FILE)),
			// Any free port: the server tells teammates' hosts where this one is.
			transport: new TcpTransport({ port: 0 }),
			scope,
			directoryDir: join(this.home, "summaries"),
			repo: { name: repoName(cwd), ...(cloneUrl(cwd) ? { url: cloneUrl(cwd) as string } : {}) },
			// Offers and requests go through the server; the session itself goes straight to the other machine.
			relay: {
				send: (to, frame) => work.signal(to, frame),
				listen: (handler) => void (this.heard = handler),
				online: (name) => (work.state()?.hosts ?? []).some((entry) => entry.owner === name && entry.scope === scope),
			},
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
		work.setPeering({ scope, addresses: collab.listening(), key: identity.publicKey, heard: (from, body) => this.heard(from, body) });
		this.introduce();
	}

	private heard: (from: string, frame: unknown) => void = () => {};

	/** Pass on what the server says of the team: who each person is, and where their hosts are. */
	private introduce(): void {
		const state = this.work.state();
		if (!state || !this.collab) return;
		for (const person of state.people) if (person.key && person.name !== this.host.owner) this.collab.learn(person.name, person.key);
		for (const entry of state.hosts) if (entry.owner !== this.host.owner) this.collab.heardAt(entry.owner, entry.addresses, entry.scope === this.scope);
	}

	async stop(): Promise<void> {
		await this.chain.catch(() => {});
		this.work.setPeering(undefined);
		await this.collab?.stop();
	}

	/** Whether a session is on its way between people: a host stays up until that is settled. */
	busy(): boolean {
		const collab = this.collab;
		return collab !== undefined && collab.handoffs().length + collab.requests().length + collab.pendingTransfers().length > 0;
	}

	onChanged(listener: () => void): void {
		this.listeners.push(listener);
	}

	state(): UiState["sharing"] {
		const collab = this.collab;
		if (!collab || !this.network) return null;
		// Enough of a node for the pane to draw a teammate's session it can only look at.
		const shown = (owner: string, meta: ReturnType<CollabSession["elsewhere"]>[number]["nodes"][number]): NodeMeta => ({
			...meta, owner, version: 0, sessionId: null, sessionFile: null, cwd: "", updatedAt: "",
		});
		return {
			team: this.shown,
			scope: this.scope,
			elsewhere: collab.elsewhere().map((tree) => ({
				scope: tree.scope, repo: tree.repo, ...(tree.url ? { url: tree.url } : {}), owner: tree.owner, online: tree.online, nodes: tree.nodes.map((node) => shown(tree.owner, node)),
			})),
			people: collab.people().map((person) => ({ name: person.name, fingerprint: person.fingerprint, trust: person.trust, online: person.online, here: person.here, self: person.self })),
			handoffs: collab.handoffs().map((handoff) => ({
				nodeId: handoff.nodeId, nodeName: handoff.nodeName, from: handoff.from, to: handoff.to, state: handoff.state, role: handoff.role,
			})),
			requests: collab.requests().map((request) => ({ nodeId: request.nodeId, nodeName: request.nodeName, from: request.from, to: request.to, role: request.role })),
			pendingTransfers: collab.pendingTransfers(),
			tried: collab.tried(),
		};
	}

	fetchMessages(nodeId: string): Promise<unknown[]> {
		if (!this.collab) throw new Error(NO_TEAM);
		return this.collab.fetchMessages(nodeId);
	}

	follow(nodeId: string): Promise<unknown[]> {
		if (!this.collab) throw new Error(NO_TEAM);
		return this.collab.follow(nodeId);
	}

	named(): boolean {
		return givenName(this.options) !== undefined || chosenName(this.home) !== undefined;
	}

	/** The name this host should be running under. When it is not, it must restart before it talks to anyone. */
	private wanted(): string {
		return givenName(this.options) ?? chosenName(this.home) ?? this.host.owner;
	}

	/** Whether this person now goes by another name than this host was started with. */
	outdated(): boolean {
		return this.wanted() !== this.host.owner;
	}

	async run(action: string, args: string[]): Promise<string> {
		const [first = "", second = ""] = args;
		if (action === "name") {
			if (first === "") return this.host.owner;
			const given = givenName(this.options);
			if (given !== undefined && given !== first) throw new Error(`This host was started as ${given}, which a chosen name does not replace.`);
			const account = this.work.account();
			if (first !== this.wanted() && account && !account.board) throw new Error(`Your teammates know you by the name you have on ${account.url}. Leave it with /lattice server leave before changing it.`);
			chooseName(this.home, first);
			await this.sync();
			return this.outdated() ? `You go by ${first} from the next start of each repository's host.` : `You go by ${first}.`;
		}
		const collab = this.collab;
		if (!collab) throw new Error(NO_TEAM);
		switch (action) {
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
 * runs from the repository checkout or the published package that Pi has installed, that is
 * passed whole so Pi recognises it as the package it already loaded and does not load it twice.
 */
export function sessionExtensionPaths(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	// The checkout is three directories up from this file; the published package, built, is one up.
	for (const root of [resolve(here, "..", "..", ".."), resolve(here, "..")]) {
		try {
			const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
			if (manifest.pi?.extensions?.some((entry) => entry.includes("launcher"))) return [root];
		} catch {
			// Not running from there.
		}
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
	const owner = givenName(options) ?? chosenName(options.home ?? latticeHome(process.env, homedir()));
	const host = await LatticeHost.start({
		stateDir,
		...(owner !== undefined ? { owner } : {}),
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
	// What was signed under the old name cannot be continued under the new one; the records are made again.
	if (host.renamedFrom !== undefined) rmSync(join(stateDir, "collab"), { recursive: true, force: true });
	const home = options.home ?? latticeHome(process.env, homedir());
	const work = new Work({ home, hostId: `${hostname()}:${treeEntryName(stateDir)}`, repo: basename(resolve(options.cwd)), name: () => host.owner, warn: (message) => log("notice", message) });
	host.setWork(work);
	work.sync();
	const sharing = new Sharing(host, options, work);
	host.setSharing(sharing);
	try {
		await sharing.sync();
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
		work.stop();
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
		// A server joined or left from another repository's terminal.
		work.sync();
		void sharing.sync().catch(() => {});
		const { terminals, working } = host.activity();
		// Renamed with nobody here: stop, and the next terminal starts this host under the new name.
		if (terminals === 0 && working === 0 && sharing.outdated()) return void stop();
		if (terminals > 0 || working > 0 || sharing.busy()) idleSince = Date.now();
		else if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) {
			log("info", "Nobody is connected and nothing is working; stopping.");
			void stop();
		}
	}, options.tickMs ?? 2000);
	// Let this person's terminals in other repositories find this tree.
	try {
		const trees = join(options.home ?? latticeHome(process.env, homedir()), TREES_DIR);
		mkdirSync(trees, { recursive: true });
		writeFileSync(join(trees, treeEntryName(stateDir)), encodeTree({ stateDir, root: resolve(options.cwd), scope: repoScope(resolve(options.cwd)) }));
	} catch (error) {
		log("error", `Could not record this tree for other terminals: ${error instanceof Error ? error.message : String(error)}`);
	}
	log("info", `Host started for ${stateDir} as ${host.owner}.`);
	return { host, done, stop };
}
