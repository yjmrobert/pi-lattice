/**
 * Sharing a session tree between the people of a network, peer to peer. Each person runs
 * their own host, and the hosts find each other and talk directly over an authenticated,
 * encrypted channel. There is no server and no shared storage: a teammate's sessions are
 * fetched from them while they are online, and shown as last seen when they are not.
 *
 * Nobody pairs with anybody. Being in the network is holding its secret, which a host
 * proves on every connection; the first key seen under a name is pinned from then on.
 *
 * Each node's ownership log has exactly one writer, its current owner. Everyone else asks
 * the owner to append (for example, the recipient's acceptance of an offer), and verifies
 * the signed log they get back. That is what makes a compare-and-swap store unnecessary.
 */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Envelope, isId, type LeaseEvent, newHandoffId, type NodeMeta, validateEnvelope } from "@pi-lattice/protocol";
import { type ChannelOptions, openChannel, type SecureChannel } from "./channel.ts";
import { fingerprint, type Identity, type Signed } from "./identity.ts";
import { appendEvent, type Folded, foldRecord, type KeyLookup, type NodeRecord, parseRecord, type SharedMeta, toSharedMeta } from "./ledger.ts";
import type { Discovery } from "./discovery.ts";
import { formatJoinCode, type Network, networkKey, sharedPort } from "./network.ts";
import type { PeerBook } from "./peers.ts";
import { type PeerTransport, splitAddress } from "./transport.ts";

/** The part of a lattice host that sharing needs. `LatticeHost` satisfies it. */
export interface HostPort {
	readonly owner: string;
	nodes(): NodeMeta[];
	node(id: string): NodeMeta | undefined;
	sleep(id: string): Promise<void>;
	/** A node's conversation, without starting its session. */
	readMessages(id: string): Promise<unknown[]>;
	setRemoteRouter(router: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined): void;
	importRemoteNode(node: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "owner" | "version" | "status" | "workspace" | "branch" | "createdAt" | "repo">): void;
	deliverExternal(envelope: unknown, recipientId: string): void;
	releaseNode(id: string, toOwner: string, version: number): Promise<void>;
	adoptNode(id: string, options: { cwd: string; branch: string | null; workspace: NodeMeta["workspace"]; version: number; sessionFile?: string }): NodeMeta;
	/** Whether a person has the node open in a terminal right now. Such a node is not sent away under them. */
	inUse?(id: string): boolean;
	on(event: "node", listener: (node: NodeMeta) => void): unknown;
	off(event: "node", listener: (node: NodeMeta) => void): unknown;
}

/**
 * Another way to a teammate's host for the same work than a connection to it: through
 * something both can reach, such as their team's server. Offers, requests and their answers
 * go this way when it is given, so they arrive whether or not the two machines can connect.
 * Handing the session over itself still needs the connection.
 */
export interface Relay {
	send(to: string, frame: unknown): Promise<void>;
	/** Called once, with what handles each frame handed over and who it is from. */
	listen(handler: (from: string, frame: unknown) => void): void;
	/** Whether their host for the same work is there to be handed something. */
	online(name: string): boolean;
}

/** What goes by the relay when there is one: everything two people say to each other about handing a session over. */
const RELAYED: ReadonlySet<string> = new Set(["offered", "accept", "cancel", "ask", "unask", "declined"]);

export interface CollabOptions {
	host: HostPort;
	identity: Identity;
	/** The network this person is in. Its secret is what lets other hosts connect. */
	network: Network;
	/** The people of the network seen so far, with their pinned keys. */
	peers: PeerBook;
	transport: PeerTransport;
	/** What this host is working on, usually a repository. Hosts connect only when it is the same. */
	scope?: string;
	/** Finds teammates on the local network. Without it, only known machines and seeds are tried. */
	discovery?: Discovery;
	/**
	 * A second place to listen, on the port every member knows (`lobbyPort`). Whichever of a
	 * person's hosts gets it is where teammates who share no repository with them first ask.
	 * The others keep trying, and take over when it stops.
	 */
	lobby?: PeerTransport;
	/** A directory all of this person's hosts share, where each says what it has running, so any one of them can answer for all. */
	directoryDir?: string;
	/** What this host's repository is called, and where a teammate can clone it from. */
	repo?: { name: string; url?: string };
	/** How often to look for news in a session someone is watching, in milliseconds. */
	followMs?: number;
	/** Private working directory: ownership logs, queued mail, transfers in flight. */
	dir: string;
	/** The local checkout of the project, where adopted nodes work. */
	projectDir: string;
	/** Host name or address other people should use to reach this host. Guessed when omitted. */
	advertise?: string;
	/** Carries offers and requests, in place of the connection. */
	relay?: Relay;
	/** How often to retry unreachable peers, in milliseconds. 0 disables the timer. */
	redialMs?: number;
	/** How long an offer stays open, in milliseconds. */
	offerTtlMs?: number;
	requestTimeoutMs?: number;
	now?: () => number;
}

/** `changed`: someone used this name with a key other than the pinned one. */
export type PersonTrust = "trusted" | "changed";

export interface PersonView {
	name: string;
	publicKey: string;
	fingerprint: string;
	trust: PersonTrust;
	/** One of their hosts is reachable right now, whatever it is working on. */
	online: boolean;
	/** Their host for the same work as this one is connected: their sessions here can be read, asked for and offered to. */
	here: boolean;
	self: boolean;
}

/** One repository a person has sessions running in, as their hosts describe it. */
export interface DirectoryTree {
	scope: string;
	repo: string;
	/** Where the repository can be cloned from, when its owner's checkout has a remote. */
	url?: string;
	/** The port their host for it listens on. */
	port: number;
	nodes: SharedMeta[];
}

/** A teammate's tree in a repository this host is not working on. */
export interface ElsewhereTree extends DirectoryTree {
	owner: string;
	online: boolean;
}

/** The scope of the port every member knows; see `CollabOptions.lobby`. */
const LOBBY = "|lobby";
export const lobbyPort = (network: Pick<Network, "secret">): number => sharedPort(networkKey(network), LOBBY);

/** What a member working on something else may ask of a host: who is in the network, what is running, and to read it. */
const GUEST_OPS = new Set(["roster", "directory", "messages", "follow"]);

/** Someone asking to take a session over. `owner`: they ask this person. `asker`: this person asked. */
export interface RequestView {
	nodeId: string;
	nodeName: string;
	from: string;
	to: string;
	role: "owner" | "asker";
	at: number;
}

export interface HandoffView {
	nodeId: string;
	nodeName: string;
	handoffId: string;
	from: string;
	to: string;
	state: "offered" | "accepted";
	expiresAt: number;
	role: "owner" | "recipient";
}

export interface CollabEvents {
	/** People, connections or shared nodes changed; views may differ. */
	changed: [];
	/** `notice` is for the person: someone joined, asked, declined, or a session became theirs. */
	log: [level: "info" | "notice" | "warn" | "error", message: string];
}

interface OutboxItem {
	envelope: Envelope;
	recipient: string;
	toOwner: string;
}
interface RosterEntry {
	name: string;
	publicKey: string;
	hosts: string[];
	/** The port their host for this work listens on, when known. */
	port?: number;
}
interface Ask {
	nodeId: string;
	/** Who asks (kept by the owner) or who was asked (kept by the asker). */
	who: string;
	at: number;
}
interface Transfer {
	nodeId: string;
	to: string;
	record: NodeRecord;
	branch: string | null;
	session: string | null;
	bundle: string | null;
}
type Frame =
	| { t: "req"; id: number; op: string; p: unknown }
	| { t: "res"; id: number; ok: true; r: unknown }
	| { t: "res"; id: number; ok: false; e: string }
	/** The sender's own tree changed. */
	| { t: "note"; kind: "changed" }
	/** What the sender, or another of that person's hosts, has running changed. */
	| { t: "note"; kind: "directory" }
	/** A session the receiver is watching has more in it: everything from message `from` on. */
	| { t: "note"; kind: "session"; nodeId: string; from: number; messages: unknown[] };

/** The person at the far end of a link: a link is their name, or `name|scope` when they are working on something else. */
const personOf = (link: string): string => link.split("|")[0] as string;

const git = (cwd: string, ...args: string[]): Promise<string> =>
	new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolvePromise(stdout.trim());
		});
	});

const sameLog = (a: NodeRecord, b: NodeRecord, upTo: number): boolean => {
	if (a.genesis.sig !== b.genesis.sig) return false;
	for (let i = 0; i < upTo; i++) if (a.events[i]?.sig !== b.events[i]?.sig) return false;
	return true;
};

export class CollabSession extends EventEmitter<CollabEvents> {
	private readonly options: CollabOptions;
	private readonly host: HostPort;
	private readonly identity: Identity;
	private readonly book: PeerBook;
	private readonly now: () => number;
	private readonly channels = new Map<string, { channel: SecureChannel; initiator: string }>();
	private readonly dialing = new Set<string>();
	private readonly unanswered = new Map<string, string>(); // address -> why it did not lead to a teammate
	private readonly strangers = new Map<string, string>(); // name -> a key other than the pinned one
	private readonly addresses = new Map<string, string>(); // name -> `host:port` they were last heard at
	private readonly told = new Map<string, string[]>(); // name -> every `host:port` they are said to be at
	private readonly offeredTo = new Set<string>(); // offers the recipient's host has been handed, by handoff id
	private readonly seedPeer = new Map<string, string>(); // seed -> who answered there
	private readonly failures = new Map<string, { count: number; retryAt: number }>();
	private readonly key: Buffer;
	private settling = false;
	/** Channels to members working on something else, by `name|scope`. They carry reading, never handing over. */
	private readonly guests = new Map<string, { channel: SecureChannel; initiator: string }>();
	private readonly guestAddresses = new Map<string, string>(); // name -> `host:port` of one of their other hosts
	private readonly reached = new Map<string, string>(); // link -> the machine it goes to
	private readonly directory = new Map<string, DirectoryTree[]>(); // person -> what they have running, as last told
	private readonly following = new Map<string, { messages: unknown[]; link: string; asked: number; used: number }>();
	private readonly followers = new Map<string, Map<string, { until: number; sent: number }>>();
	private followTimer: NodeJS.Timeout | undefined;
	private polling = false;
	private lobbyOpen = false;
	private summary = "";
	private directoryStamp = "";
	private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; peer: string }>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private requestId = 0;
	private bound: string | undefined;
	private redial: NodeJS.Timeout | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	private stopped = false;
	private readonly onNode = (node: NodeMeta): void => {
		if (node.owner === this.identity.name) this.debounce("publish", () => this.publishOwn());
	};

	constructor(options: CollabOptions) {
		super();
		this.options = options;
		this.host = options.host;
		this.identity = options.identity;
		this.book = options.peers;
		this.now = options.now ?? Date.now;
		this.key = networkKey(options.network);
		if (this.identity.name !== this.host.owner) throw new Error(`The sharing identity "${this.identity.name}" must match the host owner "${this.host.owner}".`);
		for (const name of ["ledger", "outbox", "transfers", "incoming", "requests", "asked", "directory"]) mkdirSync(join(options.dir, name), { recursive: true });
		if (options.directoryDir) mkdirSync(options.directoryDir, { recursive: true });
		// What teammates had running elsewhere when last heard from, so it shows before they are reached again.
		for (const file of readdirSync(join(options.dir, "directory"))) {
			try {
				const trees = cleanTrees(JSON.parse(readFileSync(join(options.dir, "directory", file), "utf8")));
				if (file.endsWith(".json")) this.directory.set(file.slice(0, -5), trees);
			} catch {
				// Unreadable: they will say again.
			}
		}
	}

	// --- lifecycle -------------------------------------------------------------

	/** Start listening, publish this host's nodes, and reach out to the rest of the network. */
	async start(): Promise<void> {
		this.bound = await this.options.transport.listen(this.answer);
		this.options.relay?.listen((from, frame) => this.onRelayed(from, frame as Frame));
		await this.openLobby();
		this.host.setRemoteRouter((envelope, recipient) => this.queueOutbound(envelope, recipient));
		this.host.on("node", this.onNode);
		await this.publishOwn();
		await this.options.discovery?.start(this.port(), (name, address, same) => this.heard(name, address, same)).catch(() => {});
		const redialMs = this.options.redialMs ?? 5000;
		if (redialMs > 0) {
			this.redial = setInterval(() => {
				void this.openLobby();
				this.tellDirectory();
				this.reach();
				void this.settle();
				for (const [nodeId, entry] of this.following) if (this.now() - entry.used > 60_000) this.following.delete(nodeId);
			}, redialMs);
			this.redial.unref();
		}
		this.reach();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.redial) clearInterval(this.redial);
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.host.off("node", this.onNode);
		this.host.setRemoteRouter(undefined);
		if (this.followTimer) clearInterval(this.followTimer);
		await this.options.discovery?.stop().catch(() => {});
		for (const { channel } of [...this.channels.values(), ...this.guests.values()]) channel.close();
		const mine = this.summaryPath();
		if (mine) rmSync(mine, { force: true });
		await this.options.lobby?.close().catch(() => {});
		await this.options.transport.close();
		await this.chain.catch(() => {});
	}

	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.catch(() => {});
		return run;
	}

	private debounce(key: string, work: () => unknown, ms = 60): void {
		if (this.timers.has(key) || this.stopped) return;
		const timer = setTimeout(() => {
			this.timers.delete(key);
			if (this.stopped) return;
			Promise.resolve()
				.then(work)
				.catch((error: unknown) => this.emit("log", "warn", error instanceof Error ? error.message : String(error)));
		}, ms);
		timer.unref();
		this.timers.set(key, timer);
	}

	// --- people and connections ------------------------------------------------

	/** Someone connected to one of this host's ports. */
	private readonly answer = (stream: import("node:stream").Duplex, from?: string): void => {
		openChannel(stream, { ...this.channelOptions(), initiator: false }).then(
			(channel) => this.adopted(channel, channel.peer, from),
			() => {}, // refused: not in the network, or a changed key, which knocked() reports
		);
	};

	/** Take the port every member knows, if no other host of this person has it. */
	private async openLobby(): Promise<void> {
		if (this.lobbyOpen || !this.options.lobby || this.stopped) return;
		try {
			await this.options.lobby.listen(this.answer);
			this.lobbyOpen = true;
		} catch {
			// Another of this person's hosts has it, and answers for this one too.
		}
	}

	private channelOptions(): Omit<ChannelOptions, "initiator"> {
		return {
			guests: true,
			identity: this.identity,
			keyOf: (name) => this.book.keyOf(name),
			network: this.key,
			...(this.options.scope !== undefined ? { scope: this.options.scope } : {}),
			onMember: (name, key) => this.joined(name, key),
			onChangedKey: (name, key) => this.knocked(name, key),
		};
	}

	/** Someone new showed they are in the network. Their key is pinned from here on. */
	private joined(name: string, key: string): void {
		if (name === this.identity.name || !this.book.learn(name, key)) return;
		this.emit("log", "notice", `${name} joined ${this.options.network.name}.`);
		this.emit("changed");
	}

	private knocked(name: string, key: string): void {
		if (this.strangers.get(name) === key) return;
		this.strangers.set(name, key);
		this.emit("log", "warn", `Someone tried to connect as ${name} with a different key from the one you know them by.`);
		this.emit("changed");
	}

	/** The port this host accepts teammates on. */
	private port(): number {
		if (!this.bound) throw new Error("Sharing has not started.");
		return splitAddress(this.bound).port;
	}

	/** The machines teammates can reach this host at. */
	hosts(): string[] {
		return this.options.advertise !== undefined ? [this.options.advertise] : localHosts();
	}

	/** The code a teammate joins with: the network, and where this host is right now. */
	joinCode(): string {
		const port = this.port();
		return formatJoinCode(this.options.network, this.hosts().map((host) => (port === this.wellKnownPort() ? host : `${host}:${port}`)));
	}

	/** The port every member's host for this work listens on, unless it was taken. */
	private wellKnownPort(): number {
		return sharedPort(this.key, this.options.scope ?? "");
	}

	/** Accept the key someone now uses in place of the pinned one. Call only after the human checked the fingerprint. */
	async trustPerson(name: string): Promise<void> {
		const key = this.strangers.get(name);
		if (!key) {
			if (this.book.get(name)) return;
			throw new Error(`Nobody called "${name}" has tried to connect with a new key.`);
		}
		this.channels.get(name)?.channel.close();
		this.book.pin(name, key);
		this.strangers.delete(name);
		this.failures.delete(name);
		this.emit("changed");
		await this.dial(name);
	}

	/** Whether their host for the same work is connected. */
	isOnline(name: string): boolean {
		return name === this.identity.name || this.channels.has(name);
	}

	/** Whether any of their hosts is connected. */
	isReachable(name: string): boolean {
		if (name === this.identity.name || this.channels.has(name)) return true;
		for (const link of this.guests.keys()) if (personOf(link) === name) return true;
		return false;
	}

	private link(id: string): SecureChannel | undefined {
		return (this.channels.get(id) ?? this.guests.get(id))?.channel;
	}

	private links(): string[] {
		return [...this.channels.keys(), ...this.guests.keys()];
	}

	people(): PersonView[] {
		const view = new Map<string, PersonView>();
		view.set(this.identity.name, {
			name: this.identity.name, publicKey: this.identity.publicKey, fingerprint: this.identity.fingerprint, trust: "trusted", online: true, here: true, self: true,
		});
		for (const peer of this.book.list()) {
			if (peer.name === this.identity.name) continue;
			const changed = this.strangers.get(peer.name);
			view.set(peer.name, {
				name: peer.name, publicKey: changed ?? peer.publicKey, fingerprint: fingerprint(changed ?? peer.publicKey), trust: changed ? "changed" : "trusted", online: this.isReachable(peer.name), here: this.channels.has(peer.name), self: false,
			});
		}
		return [...view.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
	}

	/** A beacon, or a teammate, says where someone is. Worth trying at once. `same`: it is their host for this work. */
	/** Where this host can be connected to, for telling teammates. */
	listening(): string[] {
		const port = this.port();
		return this.hosts().map((host) => `${host}:${port}`);
	}

	/** Someone both sides trust says who a person is: the key they sign with. The first key heard for a name stays. */
	learn(name: string, publicKey: string): void {
		this.joined(name, publicKey);
	}

	/** Someone both sides trust says where a person's host is. `same`: it is their host for this work. */
	heardAt(name: string, addresses: readonly string[], same: boolean): void {
		const first = addresses[0];
		if (name === this.identity.name || this.stopped || first === undefined) return;
		if (!same) return this.heard(name, first, false);
		if (this.told.get(name)?.join() !== addresses.join()) {
			this.told.set(name, [...addresses]);
			this.failures.delete(name);
		}
		if (!this.channels.has(name) && this.book.get(name)) void this.dial(name);
	}

	/** Whether their host for this work is there to be told something: by the relay when there is one, else by the connection. */
	private there(name: string): boolean {
		return this.options.relay ? this.options.relay.online(name) : this.channels.has(name);
	}

	private heard(name: string, address: string, same = true): void {
		if (name === this.identity.name || this.stopped) return;
		if (!same) {
			this.guestAddresses.set(name, address);
			if (this.isReachable(name)) return;
			this.failures.delete(`guest:${name}`);
			if (this.book.get(name)) void this.dialGuest(name);
			else void this.dialAddress(address);
			return;
		}
		if (this.addresses.get(name) !== address) {
			this.addresses.set(name, address);
			this.failures.delete(name);
		}
		if (this.channels.has(name)) return;
		if (this.book.get(name)) void this.dial(name);
		else void this.dialAddress(address);
	}

	/** The addresses tried most recently that did not lead to a teammate, and why, latest last. */
	tried(): Array<{ address: string; why: string }> {
		return [...this.unanswered].map(([address, why]) => ({ address, why }));
	}

	/** Try everyone in the network, and every machine the join code named, now. */
	reach(): void {
		if (this.stopped) return;
		for (const peer of this.book.list()) {
			// Their host for this work first; failing that, any host of theirs, to know what they have running.
			void this.dial(peer.name).then((here) => (here || this.isReachable(peer.name) ? undefined : this.dialGuest(peer.name)));
		}
		const known = new Set(this.book.list().flatMap((peer) => peer.hosts ?? []));
		for (const seed of this.options.network.seeds) {
			const answered = this.seedPeer.get(seed);
			// A seed is only for the first contact: once its machine belongs to someone known, they are dialled by name.
			if ((answered !== undefined && this.book.get(answered)) || known.has(seed)) continue;
			// Whoever gave the code may be working on something else: then the port every member knows is where they answer.
			const tries = seed.includes(":") ? [seed] : [`${seed}:${this.wellKnownPort()}`, `${seed}:${lobbyPort(this.options.network)}`];
			void (async () => {
				for (const address of tries) {
					const name = await this.dialAddress(address);
					if (name) return void this.seedPeer.set(seed, name);
				}
			})();
		}
	}

	/** Where a person might be: where they were last heard, then every machine they are known at. */
	private candidates(name: string): string[] {
		const out: string[] = [];
		const heard = this.addresses.get(name);
		if (heard) out.push(heard);
		out.push(...(this.told.get(name) ?? []));
		for (const host of this.book.get(name)?.hosts ?? []) out.push(`${host}:${this.wellKnownPort()}`);
		return out.filter((address, index) => out.indexOf(address) === index);
	}

	/** Open a channel to whoever answers at an address. Resolves with their name, or undefined. */
	private async dialAddress(address: string, expect?: string): Promise<string | undefined> {
		if (this.stopped || this.dialing.has(address)) return undefined;
		this.dialing.add(address);
		try {
			const stream = await this.options.transport.connect(address);
			const channel = await openChannel(stream, { ...this.channelOptions(), initiator: true, ...(expect !== undefined ? { expect } : {}) });
			(channel.scope === this.options.scope ? this.addresses : this.guestAddresses).set(channel.peer, address);
			this.adopted(channel, this.identity.name, splitAddress(address).host);
			this.unanswered.delete(address);
			return channel.peer;
		} catch (error) {
			// Not there, not them, or not in the network; a changed key is reported by knocked().
			this.unanswered.delete(address);
			this.unanswered.set(address, whyNot(error));
			if (this.unanswered.size > 12) this.unanswered.delete(this.unanswered.keys().next().value as string);
			return undefined;
		} finally {
			this.dialing.delete(address);
		}
	}

	/** Try to connect to someone in the network. Resolves true when a channel to them is open. */
	async dial(name: string): Promise<boolean> {
		if (this.stopped || name === this.identity.name) return false;
		if (this.channels.has(name)) return true;
		const failed = this.failures.get(name);
		if (failed && this.now() < failed.retryAt) return false;
		if (this.dialing.has(name)) return false;
		this.dialing.add(name);
		try {
			for (const address of this.candidates(name)) {
				if (this.channels.has(name)) return true;
				await this.dialAddress(address, name);
			}
			if (this.channels.has(name)) return true;
			// Someone who is away is tried less and less often, up to once a minute.
			const count = (failed?.count ?? 0) + 1;
			this.failures.set(name, { count, retryAt: this.now() + Math.min(60_000, 5000 * 2 ** (count - 1)) });
			return false;
		} finally {
			this.dialing.delete(name);
		}
	}

	/** Reach any host of someone whose host for this work is not around, to know what they have running. */
	private async dialGuest(name: string): Promise<boolean> {
		if (this.stopped || name === this.identity.name) return false;
		if (this.isReachable(name)) return true;
		const slot = `guest:${name}`;
		const failed = this.failures.get(slot);
		if ((failed && this.now() < failed.retryAt) || this.dialing.has(slot)) return false;
		this.dialing.add(slot);
		try {
			const hosts = this.book.get(name)?.hosts ?? [];
			const heard = this.guestAddresses.get(name);
			const ports = [lobbyPort(this.options.network), ...(this.directory.get(name) ?? []).map((tree) => tree.port)];
			const tries = [...(heard ? [heard] : []), ...ports.flatMap((port) => hosts.map((host) => `${host}:${port}`))];
			for (const address of tries.filter((address, index) => tries.indexOf(address) === index)) {
				if (this.isReachable(name)) return true;
				await this.dialAddress(address, name);
			}
			if (this.isReachable(name)) return true;
			const count = (failed?.count ?? 0) + 1;
			this.failures.set(slot, { count, retryAt: this.now() + Math.min(60_000, 5000 * 2 ** (count - 1)) });
			return false;
		} finally {
			this.dialing.delete(slot);
		}
	}

	/** Register an authenticated channel. When both sides dialled at once, both keep the same one. */
	private adopted(channel: SecureChannel, initiator: string, from?: string): void {
		if (this.stopped) {
			channel.close();
			return;
		}
		const peer = channel.peer;
		if (from !== undefined) this.book.sawAt(peer, [from], true);
		if (channel.scope !== this.options.scope) {
			// A member working on something else: they may look, and so may this host.
			const id = `${peer}|${channel.scope ?? ""}`;
			this.failures.delete(`guest:${peer}`);
			const known = this.guests.get(id);
			if (known) {
				if (known.initiator <= initiator) {
					channel.close();
					return;
				}
				known.channel.removeAllListeners("close");
				known.channel.close();
				this.failWaiting(id);
			}
			this.guests.set(id, { channel, initiator });
			if (from !== undefined) this.reached.set(id, from);
			channel.on("message", (value) => this.onFrame(id, channel, value as Frame));
			channel.on("close", () => {
				if (this.guests.get(id)?.channel !== channel) return;
				this.guests.delete(id);
				this.failWaiting(id);
				this.emit("changed");
			});
			this.emit("changed");
			void this.meet(id, from).then(() => this.fetchDirectory(id)).catch(() => {});
			return;
		}
		this.failures.delete(peer);
		if (from !== undefined) this.reached.set(peer, from);
		const existing = this.channels.get(peer);
		if (existing) {
			if (existing.initiator <= initiator) {
				channel.close();
				return;
			}
			existing.channel.removeAllListeners("close");
			existing.channel.close();
			this.failWaiting(peer);
		}
		this.channels.set(peer, { channel, initiator });
		channel.on("message", (value) => this.onFrame(peer, channel, value as Frame));
		channel.on("close", () => {
			if (this.channels.get(peer)?.channel !== channel) return;
			this.channels.delete(peer);
			this.failWaiting(peer);
			this.emit("changed");
		});
		this.emit("changed");
		void this.greet(peer, from);
	}

	private failWaiting(peer: string): void {
		for (const [id, entry] of this.waiting) {
			if (entry.peer !== peer) continue;
			clearTimeout(entry.timer);
			this.waiting.delete(id);
			entry.reject(new Error(`${personOf(peer)} went offline.`));
		}
	}

	/** Everything owed to a peer the moment they are reachable. */
	private async greet(peer: string, from?: string): Promise<void> {
		try {
			await this.meet(peer, from);
			await this.fetchDirectory(peer).catch(() => {});
			await this.fetchTree(peer);
			await this.flushOutbox(peer);
			await this.sendTransfers(peer);
			await this.settle();
		} catch (error) {
			this.emit("log", "warn", `Talking to ${peer}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Who this host knows, and where: what a teammate is told so that knowing one member leads to all of them. */
	private roster(): RosterEntry[] {
		const out: RosterEntry[] = [{ name: this.identity.name, publicKey: this.identity.publicKey, hosts: this.hosts(), port: this.port() }];
		for (const peer of this.book.list()) {
			if (peer.name === this.identity.name) continue;
			const heard = this.addresses.get(peer.name);
			out.push({ name: peer.name, publicKey: peer.publicKey, hosts: peer.hosts ?? [], ...(heard ? { port: splitAddress(heard).port } : {}) });
		}
		return out;
	}

	/** Learn the rest of the network from someone in it. Keys already pinned are never replaced this way. */
	private async meet(link: string, from?: string): Promise<void> {
		const peer = personOf(link);
		const { people } = await this.request<{ people: RosterEntry[] }>(link, "roster", {});
		for (const entry of Array.isArray(people) ? people : []) {
			if (!entry || typeof entry.name !== "string" || typeof entry.publicKey !== "string" || entry.name === this.identity.name) continue;
			const hosts = Array.isArray(entry.hosts) ? entry.hosts.filter((host): host is string => typeof host === "string") : [];
			if (entry.name !== peer) this.joined(entry.name, entry.publicKey);
			if (this.book.keyOf(entry.name) !== entry.publicKey) continue;
			this.book.sawAt(entry.name, hosts);
			const port = typeof entry.port === "number" && Number.isInteger(entry.port) && entry.port > 0 && entry.port < 65536 ? entry.port : undefined;
			const host = entry.name === peer ? from : hosts[0];
			if (port === undefined || host === undefined) continue;
			// Where the peer itself listens is worth keeping even though they are connected: others will ask.
			if (entry.name === peer) (link === peer ? this.addresses : this.guestAddresses).set(peer, `${host}:${port}`);
			// A guest speaks of ports for its own work, which is not this host's.
			else if (!this.isReachable(entry.name)) this.heard(entry.name, `${host}:${port}`, link === peer);
		}
		this.reach();
	}

	// --- requests --------------------------------------------------------------

	/** Ask over a link: a person's name for their host on this work, or `name|scope` for one of their others. */
	private request<T>(peer: string, op: string, params: unknown): Promise<T> {
		const relay = this.options.relay && RELAYED.has(op) ? this.options.relay : undefined;
		const channel = relay ? undefined : this.link(peer);
		if (!relay && !channel) return Promise.reject(new Error(`${personOf(peer)} is offline.`));
		const entry = { send: (frame: Frame): void => (relay ? void relay.send(peer, frame).catch(() => {}) : (channel as SecureChannel).send(frame)) };
		const id = ++this.requestId;
		return new Promise<T>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`${personOf(peer)} did not answer in time.`));
			}, this.options.requestTimeoutMs ?? 60_000);
			timer.unref();
			this.waiting.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timer, peer });
			entry.send({ t: "req", id, op, p: params } satisfies Frame);
		});
	}

	/** A frame handed over by the relay. Only what is said about handing over goes this way; who it is from is the relay's word. */
	private onRelayed(from: string, frame: Frame): void {
		const relay = this.options.relay;
		if (!relay || this.stopped || typeof from !== "string") return;
		if (frame?.t === "res") this.answered(from, frame);
		else if (frame?.t === "req" && RELAYED.has(frame.op)) {
			this.serve(from, frame.op, frame.p).then(
				(r) => relay.send(from, { t: "res", id: frame.id, ok: true, r } satisfies Frame),
				(error: unknown) => relay.send(from, { t: "res", id: frame.id, ok: false, e: error instanceof Error ? error.message : String(error) } satisfies Frame),
			).catch(() => {});
		}
	}

	private answered(peer: string, frame: Extract<Frame, { t: "res" }>): void {
		const entry = this.waiting.get(frame.id);
		if (!entry || entry.peer !== peer) return;
		this.waiting.delete(frame.id);
		clearTimeout(entry.timer);
		if (frame.ok) entry.resolve(frame.r);
		else entry.reject(new Error(frame.e));
	}

	private onFrame(peer: string, channel: SecureChannel, frame: Frame): void {
		if (frame?.t === "res") this.answered(peer, frame);
		else if (frame?.t === "note") {
			if (frame.kind === "changed" && this.channels.has(peer)) this.debounce(`fetch:${peer}`, () => this.fetchTree(peer));
			else if (frame.kind === "directory") this.debounce(`directory:${peer}`, () => this.fetchDirectory(peer));
			else if (frame.kind === "session") this.heardSession(peer, frame.nodeId, frame.from, frame.messages);
		} else if (frame?.t === "req") {
			this.serve(peer, frame.op, frame.p).then(
				(r) => channel.send({ t: "res", id: frame.id, ok: true, r } satisfies Frame),
				(error: unknown) => channel.send({ t: "res", id: frame.id, ok: false, e: error instanceof Error ? error.message : String(error) } satisfies Frame),
			);
		}
	}

	private async serve(link: string, op: string, params: unknown): Promise<unknown> {
		const p = (params ?? {}) as Record<string, unknown>;
		const peer = personOf(link);
		if (link !== peer && !GUEST_OPS.has(op)) throw new Error("That needs both of you to be working in the same repository.");
		switch (op) {
			case "directory":
				return { trees: this.ownTrees() };
			case "follow":
				return this.followed(link, p.nodeId, p.have);
			case "roster":
				return { people: this.roster() };
			case "tree":
				return { records: this.ownRecords() };
			case "messages": {
				const node = typeof p.nodeId === "string" ? this.host.node(p.nodeId) : undefined;
				if (!node || node.owner !== this.identity.name) throw new Error("That session is not here.");
				return { messages: await this.host.readMessages(node.id) };
			}
			case "mail":
				return this.receiveMail(peer, p.envelope, p.recipient);
			case "accept":
			case "cancel": {
				const answer = await this.exclusive(async () => this.appendFromPeer(peer, p.nodeId, p.event as Signed<LeaseEvent>, op));
				// Offering was the owner's yes. Once the other person says yes too, the session goes.
				if (op === "accept") this.debounce("settle", () => this.settle(), 0);
				return answer;
			}
			case "offered": {
				// The owner's own record of the session, with the offer in it: checked like any other.
				const parsed = parseRecord(JSON.stringify(p.record));
				if (parsed && this.fold(parsed).ownership.owner === peer && this.consider(parsed)) this.emit("changed");
				this.debounce("settle", () => this.settle(), 0);
				return {};
			}
			case "ask":
				return this.asked(peer, p.nodeId);
			case "unask":
				return this.dropRequest(p.nodeId, peer);
			case "declined":
				return this.wasDeclined(peer, p.nodeId);
			case "transfer":
				return this.exclusive(() => this.receiveTransfer(peer, p as unknown as Transfer));
			default:
				throw new Error(`Unknown request "${op}".`);
		}
	}

	private broadcastChanged(): void {
		for (const { channel } of this.channels.values()) channel.send({ t: "note", kind: "changed" } satisfies Frame);
		this.emit("changed");
	}

	// --- ownership logs --------------------------------------------------------

	private keys(): KeyLookup {
		return (person) => (person === this.identity.name ? this.identity.publicKey : this.book.keyOf(person));
	}

	private recordPath(nodeId: string): string {
		return join(this.options.dir, "ledger", `${nodeId}.json`);
	}

	private record(nodeId: string): NodeRecord | undefined {
		if (!isId(nodeId)) return undefined;
		try {
			return parseRecord(readFileSync(this.recordPath(nodeId), "utf8"));
		} catch {
			return undefined;
		}
	}

	private save(record: NodeRecord): void {
		const path = this.recordPath(record.meta.body.id);
		writeFileSync(`${path}.tmp`, JSON.stringify(record));
		renameSync(`${path}.tmp`, path);
	}

	private allRecords(): NodeRecord[] {
		const out: NodeRecord[] = [];
		for (const file of readdirSync(join(this.options.dir, "ledger"))) {
			if (!file.endsWith(".json")) continue;
			const record = this.record(file.slice(0, -5));
			if (record) out.push(record);
		}
		return out;
	}

	private fold(record: NodeRecord): Folded {
		return foldRecord(record, this.keys(), this.now());
	}

	/** Records for the nodes this host currently owns: what a peer is given when it asks for our tree. */
	private ownRecords(): NodeRecord[] {
		return this.allRecords().filter((record) => {
			const folded = this.fold(record);
			return folded.valid && folded.ownership.owner === this.identity.name;
		});
	}

	/** Create or refresh the signed record of every node owned here. Tells peers when anything changed. */
	private async publishOwn(): Promise<void> {
		const me = this.identity.name;
		let changed = false;
		for (const node of this.host.nodes()) {
			if (node.owner !== me) continue;
			const meta = toSharedMeta(node);
			const record = this.record(node.id);
			if (!record) {
				this.save({ genesis: this.identity.sign({ nodeId: node.id, owner: me, at: node.createdAt }), meta: this.identity.sign(meta), events: [] });
				changed = true;
				continue;
			}
			const folded = this.fold(record);
			if (!folded.valid) continue;
			if (folded.ownership.owner !== me) {
				// The log says this node was handed on; the local view is stale.
				await this.host.releaseNode(node.id, folded.ownership.owner, folded.ownership.version);
				continue;
			}
			if (JSON.stringify(record.meta.body) !== JSON.stringify(meta) || record.meta.by !== me) {
				this.save({ ...record, meta: this.identity.sign(meta) });
				changed = true;
			}
		}
		if (changed) this.broadcastChanged();
		this.writeSummary();
	}

	/**
	 * Weigh a record received from a peer against what is held. A record is only taken when
	 * its signatures verify and its log extends the one already known; a log that disagrees
	 * with a known one is refused and reported.
	 */
	private consider(incoming: NodeRecord): boolean {
		const id = incoming.meta.body.id;
		if (!isId(id) || incoming.genesis.body.nodeId !== id) return false;
		const folded = this.fold(incoming);
		if (!folded.valid || !folded.metaTrusted) return false;
		const verified: NodeRecord = { ...incoming, events: incoming.events.slice(0, folded.applied) };
		const held = this.record(id);
		let news = true;
		if (held) {
			const heldFold = this.fold(held);
			const shorter = Math.min(heldFold.applied, folded.applied);
			if (!sameLog(held, verified, shorter)) {
				this.emit("log", "error", `Conflicting ownership histories for "${verified.meta.body.name}". Keeping the one already known; ask its owner what happened.`);
				return false;
			}
			if (folded.applied < heldFold.applied) return false; // older than what is known
			news = folded.applied > heldFold.applied || JSON.stringify(held.meta) !== JSON.stringify(verified.meta);
		}
		if (news) this.save(verified);
		// Bring the host's tree in line even when the record itself is not news: the host may
		// have lost the node, or still think a node that was handed on is its own.
		const me = this.identity.name;
		const { owner, version } = folded.ownership;
		const here = this.host.node(id);
		if (owner !== me) {
			if (here?.owner === me) void this.host.releaseNode(id, owner, version);
			else if (!here || news) this.host.importRemoteNode({ ...verified.meta.body, owner, version });
		}
		return news || !here;
	}

	private async fetchTree(peer: string): Promise<void> {
		const { records } = await this.request<{ records: NodeRecord[] }>(peer, "tree", {});
		let changed = false;
		for (const record of Array.isArray(records) ? records : []) {
			const parsed = parseRecord(JSON.stringify(record));
			if (parsed && this.consider(parsed)) changed = true;
		}
		if (changed) this.emit("changed");
		this.debounce("settle", () => this.settle(), 0);
	}

	/** Ask every connected peer for their current tree. */
	async refresh(): Promise<void> {
		await this.publishOwn();
		await Promise.all([...this.channels.keys()].map((peer) => this.fetchTree(peer).catch(() => {})));
		for (const peer of this.channels.keys()) {
			await this.flushOutbox(peer).catch(() => {});
			await this.sendTransfers(peer).catch(() => {});
		}
	}

	/** A teammate's session's conversation, fetched from its owner, whichever repository it is in. Read-only. */
	async fetchMessages(nodeId: string): Promise<unknown[]> {
		const { messages } = await this.request<{ messages: unknown[] }>(await this.linkTo(nodeId), "messages", { nodeId });
		return Array.isArray(messages) ? messages : [];
	}

	// --- what everyone has running -------------------------------------------------

	private summaryPath(): string | undefined {
		const dir = this.options.directoryDir;
		return dir ? join(dir, `${createHash("sha256").update(resolve(this.options.dir)).digest("hex").slice(0, 16)}.json`) : undefined;
	}

	/** This host's own tree, as teammates anywhere are told of it. */
	private ownTree(): DirectoryTree {
		const me = this.identity.name;
		const repo = this.options.repo;
		return {
			scope: this.options.scope ?? "", repo: repo?.name ?? "", ...(repo?.url ? { url: repo.url } : {}), port: this.bound ? this.port() : 0,
			nodes: this.host.nodes().filter((node) => node.owner === me).map(toSharedMeta),
		};
	}

	/** Say what this host has running where this person's other hosts can read it, and tell teammates when it changed. */
	private writeSummary(): void {
		const path = this.summaryPath();
		const text = JSON.stringify({ pid: process.pid, ...this.ownTree() });
		if (text === this.summary) return;
		this.summary = text;
		if (path) {
			writeFileSync(`${path}.tmp`, text);
			renameSync(`${path}.tmp`, path);
		}
		this.tellDirectory(true);
	}

	/** Everything this person has running, in every repository with a live host. */
	private ownTrees(): DirectoryTree[] {
		const dir = this.options.directoryDir;
		if (!dir) return [this.ownTree()];
		const out: DirectoryTree[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const value = JSON.parse(readFileSync(join(dir, file), "utf8")) as { pid?: unknown };
				// A host that died without tidying up has nothing running.
				if (typeof value.pid === "number") process.kill(value.pid, 0);
				out.push(...cleanTrees([value]));
			} catch {
				// Unreadable, or its host is gone.
			}
		}
		return out;
	}

	/** Tell everyone connected that what this person has running changed: here, or in another of their hosts. */
	private tellDirectory(changed = false): void {
		const dir = this.options.directoryDir;
		if (dir && !changed) {
			let stamp = "";
			try {
				stamp = readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => `${file}:${statSync(join(dir, file)).mtimeMs}`).join("|");
			} catch {
				// No directory: nothing to tell.
			}
			if (stamp === this.directoryStamp) return;
			this.directoryStamp = stamp;
		}
		for (const id of this.links()) this.link(id)?.send({ t: "note", kind: "directory" } satisfies Frame);
	}

	/** Ask someone what they have running, everywhere. */
	private async fetchDirectory(link: string): Promise<void> {
		const peer = personOf(link);
		const answer = await this.request<{ trees: unknown }>(link, "directory", {});
		const trees = cleanTrees(answer?.trees);
		const text = JSON.stringify(trees);
		if (text !== JSON.stringify(this.directory.get(peer) ?? null)) {
			this.directory.set(peer, trees);
			writeFileSync(join(this.options.dir, "directory", `${peer}.json`), text);
			this.emit("changed");
		}
		// If they have a host for this work that was not found yet, this is where it is.
		const here = trees.find((tree) => tree.scope === (this.options.scope ?? ""));
		const host = this.reached.get(link);
		if (here && host && here.port > 0 && !this.channels.has(peer)) this.heard(peer, `${host}:${here.port}`);
	}

	/** Teammates' trees in repositories this host is not working on, as last heard. */
	elsewhere(): ElsewhereTree[] {
		const out: ElsewhereTree[] = [];
		for (const [owner, trees] of this.directory) {
			if (!this.book.get(owner)) continue;
			for (const tree of trees) {
				if (tree.scope === (this.options.scope ?? "") || tree.nodes.length === 0) continue;
				out.push({ ...tree, owner, online: this.isReachable(owner) });
			}
		}
		return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.owner.localeCompare(b.owner));
	}

	/** The link to the host that has a session: its owner's host for this work, or a channel opened to the one it is in. */
	private async linkTo(nodeId: string): Promise<string> {
		const node = this.host.node(nodeId);
		if (node) {
			if (node.owner === this.identity.name) throw new Error("That session is yours.");
			if (!this.channels.has(node.owner)) throw new Error(`${node.owner} is offline.`);
			return node.owner;
		}
		for (const [owner, trees] of this.directory) {
			const tree = trees.find((candidate) => candidate.nodes.some((each) => each.id === nodeId));
			if (!tree) continue;
			const id = `${owner}|${tree.scope}`;
			if (this.guests.has(id)) return id;
			const hosts = [...this.links().filter((link) => personOf(link) === owner).map((link) => this.reached.get(link)), ...(this.book.get(owner)?.hosts ?? [])];
			for (const host of hosts.filter((host, index): host is string => host !== undefined && hosts.indexOf(host) === index)) {
				await this.dialAddress(`${host}:${tree.port}`, owner);
				if (this.guests.has(id)) return id;
			}
			throw new Error(`${owner} is offline.`);
		}
		throw new Error(`No session ${nodeId} that anyone in ${this.options.network.name} has running.`);
	}

	// --- watching a session ----------------------------------------------------------

	/**
	 * A teammate's conversation, kept up to date for as long as this keeps being called. The
	 * first call fetches it and asks its owner for news; the owner then sends each new message
	 * as it is written, and stops a little after the calls do.
	 */
	async follow(nodeId: string): Promise<unknown[]> {
		const now = this.now();
		let entry = this.following.get(nodeId);
		if (!entry || now - entry.asked > 5000 || !this.link(entry.link)) {
			const link = await this.linkTo(nodeId);
			const have = entry && entry.link === link ? entry.messages.length : 0;
			const answer = await this.request<{ from: number; messages: unknown[] }>(link, "follow", { nodeId, have });
			const from = Number.isInteger(answer?.from) && answer.from >= 0 && answer.from <= have ? answer.from : 0;
			// What arrived while asking was added to the entry of the time; build on the newest.
			const kept = (this.following.get(nodeId)?.link === link ? this.following.get(nodeId)?.messages : entry?.messages) ?? [];
			const fresh = Array.isArray(answer?.messages) ? answer.messages : [];
			entry = { messages: kept.length >= from + fresh.length ? kept : [...kept.slice(0, from), ...fresh], link, asked: now, used: now };
			this.following.set(nodeId, entry);
		}
		entry.used = now;
		return entry.messages;
	}

	/** The owner sent more of a session this host is watching. */
	private heardSession(link: string, nodeId: unknown, from: unknown, messages: unknown): void {
		const entry = typeof nodeId === "string" ? this.following.get(nodeId) : undefined;
		if (!entry || entry.link !== link || typeof from !== "number" || !Array.isArray(messages)) return;
		// A gap means something was missed; the next look fetches it whole.
		if (from > entry.messages.length) this.following.delete(nodeId as string);
		else entry.messages = [...entry.messages.slice(0, from), ...messages];
		this.emit("changed");
	}

	/** Someone watches a session owned here. They are sent what is new until they stop asking. */
	private async followed(link: string, nodeId: unknown, have: unknown): Promise<{ from: number; messages: unknown[] }> {
		const node = typeof nodeId === "string" ? this.host.node(nodeId) : undefined;
		if (!node || node.owner !== this.identity.name) throw new Error("That session is not here.");
		const messages = await this.host.readMessages(node.id);
		const from = typeof have === "number" && Number.isInteger(have) && have >= 0 && have <= messages.length ? have : 0;
		const watchers = this.followers.get(node.id) ?? new Map<string, { until: number; sent: number }>();
		watchers.set(link, { until: this.now() + 20_000, sent: messages.length });
		this.followers.set(node.id, watchers);
		if (!this.followTimer && !this.stopped) {
			this.followTimer = setInterval(() => void this.tellFollowers(), this.options.followMs ?? 1000);
			this.followTimer.unref();
		}
		return { from, messages: messages.slice(from) };
	}

	private async tellFollowers(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			for (const [nodeId, watchers] of this.followers) {
				for (const [link, watcher] of watchers) if (this.now() > watcher.until || !this.link(link)) watchers.delete(link);
				if (watchers.size === 0 || this.host.node(nodeId)?.owner !== this.identity.name) {
					this.followers.delete(nodeId);
					continue;
				}
				const messages = await this.host.readMessages(nodeId).catch(() => undefined);
				if (!messages) continue;
				for (const [link, watcher] of watchers) {
					if (messages.length === watcher.sent) continue;
					// Fewer than before means the conversation was rewound: send it whole.
					const from = messages.length > watcher.sent ? watcher.sent : 0;
					this.link(link)?.send({ t: "note", kind: "session", nodeId, from, messages: messages.slice(from) } satisfies Frame);
					watcher.sent = messages.length;
				}
			}
			if (this.followers.size === 0 && this.followTimer) {
				clearInterval(this.followTimer);
				this.followTimer = undefined;
			}
		} finally {
			this.polling = false;
		}
	}

	// --- mail ------------------------------------------------------------------

	private queueOutbound(envelope: Envelope, recipient: NodeMeta): void {
		const item: OutboxItem = { envelope, recipient: recipient.id, toOwner: recipient.owner };
		const path = join(this.options.dir, "outbox", `${envelope.id}--${recipient.id}.json`);
		writeFileSync(`${path}.tmp`, JSON.stringify(item));
		renameSync(`${path}.tmp`, path);
		if (this.channels.has(recipient.owner)) void this.flushOutbox(recipient.owner).catch(() => {});
		else this.emit("log", "info", `${recipient.owner} is offline; the message for "${recipient.name}" will be sent when they are back.`);
	}

	private async flushOutbox(peer: string): Promise<void> {
		const dir = join(this.options.dir, "outbox");
		for (const file of readdirSync(dir).sort()) {
			if (!file.endsWith(".json")) continue;
			let item: OutboxItem;
			try {
				item = JSON.parse(readFileSync(join(dir, file), "utf8")) as OutboxItem;
			} catch {
				unlinkSync(join(dir, file));
				continue;
			}
			if (item.toOwner !== peer) continue;
			try {
				await this.request(peer, "mail", { envelope: item.envelope, recipient: item.recipient });
			} catch (error) {
				if (!this.channels.has(peer)) return; // went offline; keep it queued
				this.emit("log", "warn", `${peer} refused a message: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (existsSync(join(dir, file))) unlinkSync(join(dir, file));
		}
	}

	/** Mail from a peer's agent. The channel proves who sent it; the logs prove they may speak for that node. */
	private receiveMail(peer: string, value: unknown, recipient: unknown): Record<string, never> {
		const checked = validateEnvelope(value);
		if (!checked.ok) throw new Error(`Malformed message: ${checked.errors[0] ?? "invalid"}`);
		const envelope = checked.envelope;
		if (envelope.fromOwner !== peer) throw new Error("A message must come from its sender's owner.");
		const sender = this.record(envelope.from);
		if (!sender || this.fold(sender).ownership.owner !== peer) throw new Error("The sending session does not belong to you, as far as this host knows.");
		const target = typeof recipient === "string" ? this.host.node(recipient) : undefined;
		if (!target || target.owner !== this.identity.name) throw new Error("That session is not here.");
		this.host.deliverExternal(envelope, target.id);
		return {};
	}

	// --- handoff ---------------------------------------------------------------

	handoffs(): HandoffView[] {
		const me = this.identity.name;
		const out: HandoffView[] = [];
		for (const record of this.allRecords()) {
			const folded = this.fold(record);
			const handoff = folded.ownership.handoff;
			if (!folded.valid || !handoff || (handoff.from !== me && handoff.to !== me)) continue;
			out.push({
				nodeId: record.meta.body.id, nodeName: record.meta.body.name, handoffId: handoff.id, from: handoff.from, to: handoff.to,
				state: handoff.state, expiresAt: handoff.expiresAt, role: handoff.from === me ? "owner" : "recipient",
			});
		}
		return out;
	}

	private openHandoff(nodeId: string): HandoffView {
		const handoff = this.handoffs().find((candidate) => candidate.nodeId === nodeId);
		if (!handoff) throw new Error("There is no open handoff for this session.");
		return handoff;
	}

	/** Append an event to a log this host owns. */
	private appendOwn(nodeId: string, event: Signed<LeaseEvent>): NodeRecord {
		const record = this.record(nodeId);
		if (!record) throw new Error("That session has not been shared yet.");
		if (this.fold(record).ownership.owner !== this.identity.name) throw new Error("That session is not owned here.");
		const result = appendEvent(record, event, this.keys(), this.now());
		if (!result.ok) throw new Error(result.error);
		if (result.changed) {
			this.save(result.record);
			this.broadcastChanged();
		}
		return result.record;
	}

	/** A peer asks the owner (this host) to record their side of a handoff. */
	private appendFromPeer(peer: string, nodeId: unknown, event: Signed<LeaseEvent>, op: "accept" | "cancel"): { record: NodeRecord } {
		if (typeof nodeId !== "string" || event?.by !== peer || event.body?.type !== op) throw new Error("That request does not match who sent it.");
		return { record: this.appendOwn(nodeId, event) };
	}

	/**
	 * By the owner: offer a node to someone in the network. This is the owner's whole part.
	 * When they accept, the session is released to them without asking the owner again, so
	 * whoever calls this must already have told the human what a release sends.
	 */
	offer(nodeId: string, to: string): Promise<void> {
		return this.exclusive(async () => {
			this.forget("requests", nodeId, to);
			await this.publishOwn();
			const node = this.host.node(nodeId);
			if (!node) throw new Error(`No node ${nodeId} in this tree.`);
			if (node.owner !== this.identity.name) throw new Error(`"${node.name}" is owned by ${node.owner}; only its owner can offer it.`);
			if (!this.book.get(to)) throw new Error(`Nobody called "${to}" is in ${this.options.network.name}.`);
			const now = this.now();
			this.appendOwn(nodeId, this.identity.sign<LeaseEvent>({
				type: "offer", id: newHandoffId(now), by: this.identity.name, to, expectedVersion: node.version, expiresAt: now + (this.options.offerTtlMs ?? 24 * 3600_000), now,
			}));
			this.debounce("settle", () => this.settle(), 0);
		});
	}

	/** Hand the recipient's host the record with the offer in it, until it has it. */
	private async tellOffer(handoff: HandoffView): Promise<void> {
		if (!this.options.relay || this.offeredTo.has(handoff.handoffId) || !this.there(handoff.to)) return;
		await this.request(handoff.to, "offered", { record: this.record(handoff.nodeId) });
		this.offeredTo.add(handoff.handoffId);
	}

	/** By the recipient: accept. The owner records it, then releases the session. */
	accept(nodeId: string): Promise<void> {
		return this.exclusive(async () => {
			const handoff = this.openHandoff(nodeId);
			if (handoff.role !== "recipient") throw new Error("Only the person it was offered to can accept.");
			if (!this.there(handoff.from)) throw new Error(`${handoff.from} is offline. A handoff needs both of you online.`);
			const event = this.identity.sign<LeaseEvent>({ type: "accept", id: handoff.handoffId, by: this.identity.name, now: this.now() });
			const { record } = await this.request<{ record: NodeRecord }>(handoff.from, "accept", { nodeId, event });
			this.consider(record);
			this.emit("changed");
		});
	}

	/** Either side, before the release is confirmed: call the handoff off. */
	cancel(nodeId: string): Promise<void> {
		return this.exclusive(async () => {
			const handoff = this.openHandoff(nodeId);
			const event = this.identity.sign<LeaseEvent>({ type: "cancel", id: handoff.handoffId, by: this.identity.name, now: this.now() });
			if (handoff.role === "owner") {
				const record = this.appendOwn(nodeId, event);
				// Without a connection the recipient would go on seeing an offer that is no longer open.
				if (this.options.relay && this.there(handoff.to)) void this.request(handoff.to, "offered", { record }).catch(() => {});
				return;
			}
			if (!this.there(handoff.from)) throw new Error(`${handoff.from} is offline. Try again when they are back.`);
			const { record } = await this.request<{ record: NodeRecord }>(handoff.from, "cancel", { nodeId, event });
			this.consider(record);
			this.emit("changed");
		});
	}

	/**
	 * By the owner's host, once the recipient has accepted: release. This is the commit point.
	 * The session is stopped, the signed confirmation is recorded, and the conversation and
	 * branch are sent straight to the new owner. If the connection drops first, the package is
	 * kept and sent again when they are next reachable; it is deleted only on their signed
	 * receipt. It runs by itself (see `settle`); calling it is only needed to hurry it along.
	 */
	confirm(nodeId: string): Promise<void> {
		return this.exclusive(async () => {
			const handoff = this.openHandoff(nodeId);
			if (handoff.role !== "owner") throw new Error("Only the current owner confirms a release.");
			if (handoff.state !== "accepted") throw new Error(`${handoff.to} has not accepted yet.`);
			if (!this.channels.has(handoff.to)) throw new Error(`${handoff.to} is offline. A handoff needs both of you online.`);
			if (this.host.inUse?.(nodeId)) throw new Error("That session is open in a terminal. Leave it and it will be sent.");
			await this.host.sleep(nodeId);
			const node = this.host.node(nodeId);
			if (!node) throw new Error(`No node ${nodeId} in this tree.`);
			const session = node.sessionFile && existsSync(node.sessionFile) ? readFileSync(node.sessionFile).toString("base64") : null;
			const bundle = await this.bundleBranch(node);
			const record = this.appendOwn(nodeId, this.identity.sign<LeaseEvent>({ type: "confirm", id: handoff.handoffId, by: this.identity.name, now: this.now() }));
			const transfer: Transfer = { nodeId, to: handoff.to, record, branch: bundle ? node.branch : null, session, bundle };
			writeFileSync(join(this.options.dir, "transfers", `${nodeId}.json`), JSON.stringify(transfer));
			await this.host.releaseNode(nodeId, handoff.to, node.version + 1);
			this.emit("changed");
			await this.sendTransfers(handoff.to);
		});
	}

	/**
	 * Carry every handoff as far as it can go without a person. A session this person asked
	 * for is accepted the moment its owner offers it, and a session whose recipient accepted
	 * is released, unless its owner has it open in a terminal, in which case it waits for
	 * them to leave it. Called whenever something changed and on a timer, so it is safe to
	 * miss a beat.
	 */
	async settle(): Promise<void> {
		if (this.settling || this.stopped) return;
		this.settling = true;
		try {
			for (const handoff of this.handoffs()) {
				try {
					if (handoff.role === "owner" && handoff.state === "offered") await this.tellOffer(handoff);
					else if (handoff.role === "recipient" && handoff.state === "offered" && this.there(handoff.from) && this.readAsk("asked", handoff.nodeId)) {
						await this.accept(handoff.nodeId);
					} else if (handoff.role === "owner" && handoff.state === "accepted" && this.channels.has(handoff.to) && !this.host.inUse?.(handoff.nodeId)) {
						await this.confirm(handoff.nodeId);
					}
				} catch (error) {
					this.emit("log", "warn", `Handing over "${handoff.nodeName}": ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} finally {
			this.settling = false;
		}
	}

	// --- asking for a session ----------------------------------------------------

	private askPath(kind: "requests" | "asked", nodeId: string, who = ""): string {
		return join(this.options.dir, kind, kind === "requests" ? `${nodeId}--${who}.json` : `${nodeId}.json`);
	}

	private readAsk(kind: "requests" | "asked", nodeId: string, who = ""): Ask | undefined {
		try {
			const ask = JSON.parse(readFileSync(this.askPath(kind, nodeId, who), "utf8")) as Ask;
			return typeof ask.nodeId === "string" && typeof ask.who === "string" && typeof ask.at === "number" ? ask : undefined;
		} catch {
			return undefined;
		}
	}

	private forget(kind: "requests" | "asked", nodeId: string, who = ""): void {
		if (isId(nodeId)) rmSync(this.askPath(kind, nodeId, who), { force: true });
	}

	/** Open requests: those made to this person, and those this person made. Stale ones are dropped on the way. */
	requests(): RequestView[] {
		const me = this.identity.name;
		const ttl = this.options.offerTtlMs ?? 24 * 3600_000;
		const out: RequestView[] = [];
		for (const kind of ["requests", "asked"] as const) {
			for (const file of readdirSync(join(this.options.dir, kind))) {
				let ask: Ask | undefined;
				try {
					ask = JSON.parse(readFileSync(join(this.options.dir, kind, file), "utf8")) as Ask;
				} catch {
					ask = undefined;
				}
				const node = ask ? this.host.node(ask.nodeId) : undefined;
				// A request is moot once it is old, or the session is no longer with the person who was asked.
				const live = ask && node && this.now() - ask.at < ttl && (kind === "requests" ? node.owner === me && this.book.get(ask.who) !== undefined : node.owner === ask.who);
				if (!ask || !node || !live) {
					rmSync(join(this.options.dir, kind, file), { force: true });
					continue;
				}
				out.push(kind === "requests"
					? { nodeId: node.id, nodeName: node.name, from: ask.who, to: me, role: "owner", at: ask.at }
					: { nodeId: node.id, nodeName: node.name, from: me, to: ask.who, role: "asker", at: ask.at });
			}
		}
		return out.sort((a, b) => a.at - b.at);
	}

	/** Ask a teammate for one of their sessions. It becomes this person's as soon as they approve. */
	async ask(nodeId: string): Promise<void> {
		const node = this.host.node(nodeId);
		if (!node) throw new Error(`No node ${nodeId} in this tree.`);
		if (node.owner === this.identity.name) throw new Error(`"${node.name}" is already yours.`);
		if (!this.there(node.owner)) throw new Error(`${node.owner} is offline. Ask when they are back.`);
		// Recorded first: their approval may come back before the request returns.
		writeFileSync(this.askPath("asked", nodeId), JSON.stringify({ nodeId, who: node.owner, at: this.now() } satisfies Ask));
		try {
			await this.request(node.owner, "ask", { nodeId });
		} catch (error) {
			this.forget("asked", nodeId);
			throw error;
		}
		this.emit("changed");
		await this.settle(); // they may have offered it already
	}

	/** Take back a request this person made. */
	async withdraw(nodeId: string): Promise<void> {
		const ask = this.readAsk("asked", nodeId);
		this.forget("asked", nodeId);
		this.emit("changed");
		if (ask && this.there(ask.who)) await this.request(ask.who, "unask", { nodeId }).catch(() => {});
	}

	/** By the owner: say yes to someone who asked. The session is theirs as soon as their host hears. */
	async approve(nodeId: string, from: string): Promise<void> {
		if (!this.readAsk("requests", nodeId, from)) throw new Error(`${from} is not asking for that session.`);
		await this.offer(nodeId, from);
	}

	/** By the owner: say no to someone who asked. */
	async decline(nodeId: string, from: string): Promise<void> {
		this.forget("requests", nodeId, from);
		this.emit("changed");
		if (this.there(from)) await this.request(from, "declined", { nodeId }).catch(() => {});
	}

	/** A teammate asks for a session owned here. */
	private asked(peer: string, nodeId: unknown): Record<string, never> {
		const node = typeof nodeId === "string" && isId(nodeId) ? this.host.node(nodeId) : undefined;
		if (!node || node.owner !== this.identity.name) throw new Error("That session is not here.");
		const known = this.readAsk("requests", node.id, peer) !== undefined;
		writeFileSync(this.askPath("requests", node.id, peer), JSON.stringify({ nodeId: node.id, who: peer, at: this.now() } satisfies Ask));
		if (!known) this.emit("log", "notice", `${peer} asks to take over "${node.name}".`);
		this.emit("changed");
		return {};
	}

	private dropRequest(nodeId: unknown, peer: string): Record<string, never> {
		if (typeof nodeId === "string") this.forget("requests", nodeId, peer);
		this.emit("changed");
		return {};
	}

	private wasDeclined(peer: string, nodeId: unknown): Record<string, never> {
		const ask = typeof nodeId === "string" ? this.readAsk("asked", nodeId) : undefined;
		if (ask?.who === peer) {
			this.forget("asked", ask.nodeId);
			this.emit("log", "notice", `${peer} declined to hand over "${this.host.node(ask.nodeId)?.name ?? "the session"}".`);
			this.emit("changed");
		}
		return {};
	}

	// --- release -----------------------------------------------------------------

	/** Sessions released to someone who has not yet confirmed receiving them. */
	pendingTransfers(): Array<{ nodeId: string; to: string }> {
		const out: Array<{ nodeId: string; to: string }> = [];
		for (const file of readdirSync(join(this.options.dir, "transfers"))) {
			try {
				const transfer = JSON.parse(readFileSync(join(this.options.dir, "transfers", file), "utf8")) as Transfer;
				out.push({ nodeId: transfer.nodeId, to: transfer.to });
			} catch {
				// Unreadable: ignore.
			}
		}
		return out;
	}

	private async sendTransfers(peer: string): Promise<void> {
		const dir = join(this.options.dir, "transfers");
		for (const file of readdirSync(dir)) {
			let transfer: Transfer;
			try {
				transfer = JSON.parse(readFileSync(join(dir, file), "utf8")) as Transfer;
			} catch {
				continue;
			}
			if (transfer.to !== peer) continue;
			try {
				const { receipt } = await this.request<{ receipt: Signed<{ nodeId: string; received: true }> }>(peer, "transfer", transfer);
				if (receipt?.by === peer && receipt.body?.nodeId === transfer.nodeId) {
					unlinkSync(join(dir, file));
					this.emit("changed");
				}
			} catch (error) {
				this.emit("log", "warn", `"${transfer.record.meta.body.name}" is released to ${peer} but has not reached them yet: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** The new owner's side of the release: verify the log says so, take the session and branch, and sign a receipt. */
	private async receiveTransfer(peer: string, transfer: Transfer): Promise<{ receipt: Signed<{ nodeId: string; received: true }> }> {
		const me = this.identity.name;
		const record = parseRecord(JSON.stringify(transfer?.record));
		if (!record) throw new Error("Malformed transfer.");
		const id = record.meta.body.id;
		const folded = this.fold(record);
		if (!folded.valid || folded.ownership.owner !== me) throw new Error("That transfer does not make you the owner.");
		const receipt = { receipt: this.identity.sign({ nodeId: id, received: true as const }) };
		if (this.host.node(id)?.owner === me) return receipt; // sent again after a dropped connection
		const held = this.record(id);
		if (held && !sameLog(held, record, Math.min(this.fold(held).applied, folded.applied))) throw new Error("That transfer contradicts the ownership history known here.");
		const signers = new Set(record.events.map((event) => event.by));
		if (!signers.has(peer) && record.genesis.by !== peer) throw new Error("That transfer is not yours to send.");

		const incoming = join(this.options.dir, "incoming");
		const sessionPath = join(incoming, `${id}.jsonl`);
		const bundlePath = join(incoming, `${id}.bundle`);
		try {
			if (typeof transfer.session === "string") writeFileSync(sessionPath, Buffer.from(transfer.session, "base64"));
			const project = resolve(this.options.projectDir);
			let cwd = project;
			let branch: string | null = null;
			let workspace: NodeMeta["workspace"] = "shared";
			if (typeof transfer.bundle === "string" && typeof transfer.branch === "string" && /^[\w./-]+$/.test(transfer.branch)) {
				writeFileSync(bundlePath, Buffer.from(transfer.bundle, "base64"));
				const common = await git(project, "rev-parse", "--git-common-dir");
				const mainRoot = dirname(isAbsolute(common) ? common : resolve(project, common));
				const path = join(mainRoot, ".lattice", "worktrees", id);
				await git(project, "fetch", "-q", bundlePath, `+refs/heads/${transfer.branch}:refs/heads/${transfer.branch}`);
				if (!existsSync(path)) {
					mkdirSync(dirname(path), { recursive: true });
					await git(project, "worktree", "add", path, transfer.branch);
				}
				cwd = path;
				branch = transfer.branch;
				workspace = "worktree";
			}
			this.save({ ...record, events: record.events.slice(0, folded.applied) });
			if (!this.host.node(id)) this.host.importRemoteNode({ ...record.meta.body, owner: peer, version: folded.ownership.version });
			this.host.adoptNode(id, { cwd, branch, workspace, version: folded.ownership.version, ...(existsSync(sessionPath) ? { sessionFile: sessionPath } : {}) });
		} finally {
			rmSync(sessionPath, { force: true });
			rmSync(bundlePath, { force: true });
		}
		this.forget("asked", id);
		this.emit("log", "notice", `You now own "${record.meta.body.name}".`);
		this.debounce("publish", () => this.publishOwn());
		this.emit("changed");
		return receipt;
	}

	/** Pack a node's branch so the new owner can recreate it without a shared code remote. */
	private async bundleBranch(node: NodeMeta): Promise<string | null> {
		if (!node.branch || !node.cwd || !existsSync(node.cwd)) return null;
		const out = join(this.options.dir, `bundle-${node.id}.tmp`);
		try {
			await git(node.cwd, "bundle", "create", out, node.branch);
			return readFileSync(out).toString("base64");
		} catch (error) {
			this.emit("log", "warn", `Could not pack branch ${node.branch}; handing off the conversation only. ${error instanceof Error ? error.message : String(error)}`);
			return null;
		} finally {
			rmSync(out, { force: true });
		}
	}
}

/** The addresses other machines can reach this one at: every non-internal IPv4, else loopback. */
/** Why a machine did not answer, in words a person can act on. */
function whyNot(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	if (/ECONNREFUSED/.test(text)) return "nothing is listening there: their Pi is not running, or it is another machine";
	if (/timed out|ETIMEDOUT/.test(text)) return "no answer: a firewall, or an address that is not reachable from here";
	if (/EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL/.test(text)) return "this machine has no route to that address";
	if (/ENOTFOUND|EAI_AGAIN/.test(text)) return "that host name is not known here";
	return text.replace(/^Could not reach \S+: /, "");
}

export function localHosts(): string[] {
	const out: string[] = [];
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) out.push(address.address);
		}
	}
	return out.length > 0 ? out : ["127.0.0.1"];
}

/** Read what someone says they have running, keeping only what is well formed. They speak for their own sessions only. */
function cleanTrees(value: unknown): DirectoryTree[] {
	const out: DirectoryTree[] = [];
	for (const raw of Array.isArray(value) ? value.slice(0, 64) : []) {
		const tree = raw as Partial<DirectoryTree> | null;
		if (!tree || typeof tree.scope !== "string" || typeof tree.repo !== "string" || typeof tree.port !== "number" || !Number.isInteger(tree.port) || tree.port < 0 || tree.port > 65535) continue;
		const nodes = (Array.isArray(tree.nodes) ? tree.nodes.slice(0, 500) : []).filter(
			(node): node is SharedMeta =>
				node !== null && typeof node === "object" && isId(node.id) && typeof node.name === "string" && typeof node.kind === "string" && typeof node.status === "string" &&
				typeof node.createdAt === "string" && (node.parentId === null || typeof node.parentId === "string") && typeof node.rootId === "string" && Array.isArray(node.fragments),
		);
		// A clone address is shown to a person before anything is cloned, and is only ever handed to git.
		const url = typeof tree.url === "string" && tree.url.length < 500 && !tree.url.startsWith("-") && !/\s/.test(tree.url) ? tree.url : undefined;
		out.push({ scope: tree.scope, repo: tree.repo.slice(0, 80), ...(url ? { url } : {}), port: tree.port, nodes });
	}
	return out;
}
