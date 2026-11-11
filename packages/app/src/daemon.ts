/**
 * The composition root: a host with sharing, run as a background process. This is the one
 * place that knows about both the host and collab; neither knows about the other.
 *
 * The lattice host as a background process. A person's own Pi starts it on demand and
 * talks to it over the local socket; it keeps the other sessions running headless, and
 * exits on its own once nobody is connected and nothing is working.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CollabSession, Identity, PeerBook, TcpTransport } from "@pi-lattice/collab";
import type { UiState } from "@pi-lattice/protocol";
import { type HostOptions, LatticeHost, type SharingPort } from "@pi-lattice/host";

export interface DaemonOptions {
	stateDir: string;
	/** The project checkout: where adopted nodes work. */
	cwd: string;
	owner?: string;
	piArgs?: string[];
	extensionPaths?: string[];
	/** `[host:]port` to share on. When omitted, sharing starts only if it was turned on before. */
	listen?: string;
	advertise?: string;
	/** Invites to pair with at start. */
	peers?: string[];
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

interface SharingConfig {
	listen: string;
	advertise?: string;
}

function parseListen(listen: string): { host: string; port: number } {
	const colon = listen.lastIndexOf(":");
	const port = Number(listen.slice(colon + 1));
	if (listen.slice(colon + 1) === "" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Sharing needs [host:]port, got "${listen}".`);
	return { host: colon > 0 ? listen.slice(0, colon) : "0.0.0.0", port };
}

/** Sharing that can be switched on while the host runs, and comes back on the next start. */
class Sharing implements SharingPort {
	private collab: CollabSession | undefined;
	private readonly listeners: Array<() => void> = [];
	private readonly host: LatticeHost;
	private readonly options: DaemonOptions;
	private readonly configPath: string;

	constructor(host: LatticeHost, options: DaemonOptions) {
		this.host = host;
		this.options = options;
		this.configPath = join(host.stateDir, "sharing.json");
	}

	async restore(): Promise<void> {
		let config: SharingConfig | undefined;
		if (this.options.listen !== undefined) config = { listen: this.options.listen, ...(this.options.advertise !== undefined ? { advertise: this.options.advertise } : {}) };
		else if (existsSync(this.configPath)) config = JSON.parse(readFileSync(this.configPath, "utf8")) as SharingConfig;
		else if ((this.options.peers ?? []).length > 0) config = { listen: "47610" };
		if (config) await this.start(config);
		for (const invite of this.options.peers ?? []) await this.collab?.addInvite(invite);
	}

	private async start(config: SharingConfig): Promise<void> {
		if (this.collab) return;
		const { host: bindHost, port } = parseListen(config.listen);
		const collab = new CollabSession({
			host: this.host,
			identity: Identity.loadOrCreate(join(getAgentDir(), "lattice", "identity"), this.host.owner),
			peers: new PeerBook(join(this.host.stateDir, "collab", "peers.json")),
			transport: new TcpTransport({ host: bindHost, port }),
			dir: join(this.host.stateDir, "collab"),
			projectDir: resolve(this.options.cwd),
			...(config.advertise !== undefined ? { advertise: config.advertise } : {}),
		});
		await collab.start();
		this.collab = collab;
		collab.on("changed", () => {
			for (const listener of this.listeners) listener();
		});
		collab.on("log", (level, message) => this.host.emit("log", level, message));
		writeFileSync(this.configPath, JSON.stringify(config));
		for (const listener of this.listeners) listener();
	}

	async stop(): Promise<void> {
		await this.collab?.stop();
	}

	onChanged(listener: () => void): void {
		this.listeners.push(listener);
	}

	state(): UiState["sharing"] {
		const collab = this.collab;
		if (!collab) return null;
		return {
			people: collab.people().map((person) => ({ name: person.name, fingerprint: person.fingerprint, trust: person.trust, online: person.online, self: person.self })),
			handoffs: collab.handoffs().map((handoff) => ({
				nodeId: handoff.nodeId, nodeName: handoff.nodeName, from: handoff.from, to: handoff.to, state: handoff.state, role: handoff.role,
			})),
			pendingTransfers: collab.pendingTransfers(),
		};
	}

	fetchMessages(nodeId: string): Promise<unknown[]> {
		if (!this.collab) throw new Error("Sharing is off.");
		return this.collab.fetchMessages(nodeId);
	}

	async run(action: string, args: string[]): Promise<string> {
		const [first = "", second = ""] = args;
		if (action === "start") {
			await this.start({ listen: first || "47610", ...(second ? { advertise: second } : {}) });
			return `Sharing is on. Your invite:\n${this.collab?.invite() ?? ""}`;
		}
		const collab = this.collab;
		if (!collab) throw new Error("Sharing is off. Turn it on first.");
		switch (action) {
			case "invite":
				return collab.invite();
			case "add":
				return `Paired with ${await collab.addInvite(first)}. They will appear once they have paired with you too.`;
			case "trust":
				await collab.trustPerson(first);
				return `Paired with ${first}.`;
			case "offer":
				await collab.offer(first, second);
				return `Offered to ${second}. They need to accept, then you confirm.`;
			case "accept":
				await collab.accept(first);
				return "Accepted. It becomes yours when they confirm the release.";
			case "confirm":
				await collab.confirm(first);
				return "Released.";
			case "cancel":
				await collab.cancel(first);
				return "Handoff cancelled.";
			case "refresh":
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
		const { terminals, working } = host.activity();
		if (terminals > 0 || working > 0) idleSince = Date.now();
		else if (idleExitMs > 0 && Date.now() - idleSince >= idleExitMs) {
			log("info", "Nobody is connected and nothing is working; stopping.");
			void stop();
		}
	}, options.tickMs ?? 2000);
	log("info", `Host started for ${stateDir} as ${host.owner}.`);
	return { host, done, stop };
}
