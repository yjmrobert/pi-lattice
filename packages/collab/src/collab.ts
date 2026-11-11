/**
 * Sharing a session tree between people, peer to peer. Each person runs their own host,
 * and the hosts talk directly over an authenticated, encrypted channel. There is no
 * server and no shared storage: a peer's sessions are fetched from that peer while they
 * are online, and shown as last seen when they are not.
 *
 * Each node's ownership log has exactly one writer, its current owner. Everyone else asks
 * the owner to append (for example, the recipient's acceptance of an offer), and verifies
 * the signed log they get back. That is what makes a compare-and-swap store unnecessary.
 */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Envelope, isId, type LeaseEvent, newHandoffId, type NodeMeta, validateEnvelope } from "@pi-lattice/protocol";
import { HandshakeError, openChannel, type SecureChannel } from "./channel.ts";
import { fingerprint, type Identity, type Signed } from "./identity.ts";
import { appendEvent, type Folded, foldRecord, type KeyLookup, type NodeRecord, parseRecord, toSharedMeta } from "./ledger.ts";
import { formatInvite, parseInvite, type PeerBook } from "./peers.ts";
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
	importRemoteNode(node: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "owner" | "version" | "status" | "workspace" | "branch" | "createdAt">): void;
	deliverExternal(envelope: unknown, recipientId: string): void;
	releaseNode(id: string, toOwner: string, version: number): Promise<void>;
	adoptNode(id: string, options: { cwd: string; branch: string | null; workspace: NodeMeta["workspace"]; version: number; sessionFile?: string }): NodeMeta;
	on(event: "node", listener: (node: NodeMeta) => void): unknown;
	off(event: "node", listener: (node: NodeMeta) => void): unknown;
}

export interface CollabOptions {
	host: HostPort;
	identity: Identity;
	/** The people this human has paired with. */
	peers: PeerBook;
	transport: PeerTransport;
	/** Private working directory: ownership logs, queued mail, transfers in flight. */
	dir: string;
	/** The local checkout of the project, where adopted nodes work. */
	projectDir: string;
	/** Host name or address other people should use to reach this host. Guessed when omitted. */
	advertise?: string;
	/** How often to retry unreachable peers, in milliseconds. 0 disables the timer. */
	redialMs?: number;
	/** How long an offer stays open, in milliseconds. */
	offerTtlMs?: number;
	requestTimeoutMs?: number;
	now?: () => number;
}

export type PersonTrust = "trusted" | "unknown" | "changed";

export interface PersonView {
	name: string;
	publicKey: string;
	fingerprint: string;
	/** `unknown`: knocked, not paired. `changed`: someone used this name with a different key. */
	trust: PersonTrust;
	online: boolean;
	address?: string;
	self: boolean;
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
	log: [level: "info" | "warn" | "error", message: string];
}

interface OutboxItem {
	envelope: Envelope;
	recipient: string;
	toOwner: string;
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
	| { t: "note"; kind: "changed" };

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
	private readonly strangers = new Map<string, string>(); // name -> key they knocked with
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
		if (this.identity.name !== this.host.owner) throw new Error(`The sharing identity "${this.identity.name}" must match the host owner "${this.host.owner}".`);
		for (const name of ["ledger", "outbox", "transfers", "incoming"]) mkdirSync(join(options.dir, name), { recursive: true });
	}

	// --- lifecycle -------------------------------------------------------------

	/** Start listening, publish this host's nodes, and reach out to paired peers. */
	async start(): Promise<void> {
		this.bound = await this.options.transport.listen((stream) => {
			openChannel(stream, {
				identity: this.identity,
				initiator: false,
				keyOf: (name) => this.book.keyOf(name),
				onStranger: (name, key) => this.knocked(name, key),
				onChangedKey: (name, key) => this.knocked(name, key),
			}).then(
				(channel) => this.adopted(channel, channel.peer),
				() => {}, // refused: strangers are surfaced through knocked()
			);
		});
		this.host.setRemoteRouter((envelope, recipient) => this.queueOutbound(envelope, recipient));
		this.host.on("node", this.onNode);
		await this.publishOwn();
		const redialMs = this.options.redialMs ?? 5000;
		if (redialMs > 0) {
			this.redial = setInterval(() => this.dialAll(), redialMs);
			this.redial.unref();
		}
		this.dialAll();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.redial) clearInterval(this.redial);
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.host.off("node", this.onNode);
		this.host.setRemoteRouter(undefined);
		for (const { channel } of this.channels.values()) channel.close();
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

	private knocked(name: string, key: string): void {
		if (this.strangers.get(name) === key) return;
		this.strangers.set(name, key);
		this.emit("log", "info", this.book.get(name) ? `Someone tried to connect as ${name} with a different key.` : `${name} wants to connect. Pair with them to allow it.`);
		this.emit("changed");
	}

	/** This host's invite: pass it to a collaborator over a channel you trust. */
	invite(): string {
		if (!this.bound) throw new Error("Sharing has not started.");
		const { port } = splitAddress(this.bound);
		return formatInvite({ name: this.identity.name, publicKey: this.identity.publicKey, address: `${this.options.advertise ?? guessHost()}:${port}` });
	}

	/** Pair with the person who sent an invite, and try to reach them. */
	async addInvite(invite: string): Promise<string> {
		const peer = parseInvite(invite);
		if (peer.name === this.identity.name) throw new Error("That is your own invite.");
		this.book.pin(peer.name, peer.publicKey, peer.address);
		this.strangers.delete(peer.name);
		this.emit("changed");
		await this.dial(peer.name);
		return peer.name;
	}

	/** Pair with someone who knocked, or accept a changed key. Call only after the human checked the fingerprint. */
	async trustPerson(name: string): Promise<void> {
		const key = this.strangers.get(name);
		if (!key) {
			if (this.book.get(name)) return;
			throw new Error(`Nobody called "${name}" has tried to connect.`);
		}
		this.channels.get(name)?.channel.close();
		this.book.pin(name, key);
		this.strangers.delete(name);
		this.emit("changed");
		await this.dial(name);
	}

	isOnline(name: string): boolean {
		return name === this.identity.name || this.channels.has(name);
	}

	people(): PersonView[] {
		const view = new Map<string, PersonView>();
		view.set(this.identity.name, {
			name: this.identity.name, publicKey: this.identity.publicKey, fingerprint: this.identity.fingerprint, trust: "trusted", online: true, self: true,
		});
		for (const peer of this.book.list()) {
			view.set(peer.name, {
				name: peer.name, publicKey: peer.publicKey, fingerprint: fingerprint(peer.publicKey), trust: "trusted", online: this.channels.has(peer.name), self: false,
				...(peer.address !== undefined ? { address: peer.address } : {}),
			});
		}
		for (const [name, key] of this.strangers) {
			const known = view.get(name);
			if (known?.self) continue;
			view.set(name, { name, publicKey: key, fingerprint: fingerprint(key), trust: known ? "changed" : "unknown", online: false, self: false, ...(known?.address !== undefined ? { address: known.address } : {}) });
		}
		return [...view.values()].sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
	}

	private dialAll(): void {
		for (const peer of this.book.list()) void this.dial(peer.name);
	}

	/** Try to connect to a paired person. Resolves true when a channel to them is open. */
	async dial(name: string): Promise<boolean> {
		if (this.stopped) return false;
		if (this.channels.has(name)) return true;
		const peer = this.book.get(name);
		if (!peer?.address || this.dialing.has(name)) return false;
		this.dialing.add(name);
		try {
			const stream = await this.options.transport.connect(peer.address);
			const channel = await openChannel(stream, { identity: this.identity, initiator: true, expect: name, keyOf: (who) => this.book.keyOf(who) });
			this.adopted(channel, this.identity.name);
			return true;
		} catch (error) {
			if (error instanceof HandshakeError && !/not someone you have paired with/.test(error.message)) this.emit("log", "warn", `Could not connect to ${name}: ${error.message}`);
			return false;
		} finally {
			this.dialing.delete(name);
		}
	}

	/** Register an authenticated channel. When both sides dialled at once, both keep the same one. */
	private adopted(channel: SecureChannel, initiator: string): void {
		if (this.stopped) {
			channel.close();
			return;
		}
		const peer = channel.peer;
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
		void this.greet(peer);
	}

	private failWaiting(peer: string): void {
		for (const [id, entry] of this.waiting) {
			if (entry.peer !== peer) continue;
			clearTimeout(entry.timer);
			this.waiting.delete(id);
			entry.reject(new Error(`${peer} went offline.`));
		}
	}

	/** Everything owed to a peer the moment they are reachable. */
	private async greet(peer: string): Promise<void> {
		try {
			await this.fetchTree(peer);
			await this.flushOutbox(peer);
			await this.sendTransfers(peer);
		} catch (error) {
			this.emit("log", "warn", `Talking to ${peer}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// --- requests --------------------------------------------------------------

	private request<T>(peer: string, op: string, params: unknown): Promise<T> {
		const entry = this.channels.get(peer);
		if (!entry) return Promise.reject(new Error(`${peer} is offline.`));
		const id = ++this.requestId;
		return new Promise<T>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`${peer} did not answer in time.`));
			}, this.options.requestTimeoutMs ?? 60_000);
			timer.unref();
			this.waiting.set(id, { resolve: resolvePromise as (value: unknown) => void, reject, timer, peer });
			entry.channel.send({ t: "req", id, op, p: params } satisfies Frame);
		});
	}

	private onFrame(peer: string, channel: SecureChannel, frame: Frame): void {
		if (frame?.t === "res") {
			const entry = this.waiting.get(frame.id);
			if (!entry || entry.peer !== peer) return;
			this.waiting.delete(frame.id);
			clearTimeout(entry.timer);
			if (frame.ok) entry.resolve(frame.r);
			else entry.reject(new Error(frame.e));
		} else if (frame?.t === "note") {
			if (frame.kind === "changed") this.debounce(`fetch:${peer}`, () => this.fetchTree(peer));
		} else if (frame?.t === "req") {
			this.serve(peer, frame.op, frame.p).then(
				(r) => channel.send({ t: "res", id: frame.id, ok: true, r } satisfies Frame),
				(error: unknown) => channel.send({ t: "res", id: frame.id, ok: false, e: error instanceof Error ? error.message : String(error) } satisfies Frame),
			);
		}
	}

	private async serve(peer: string, op: string, params: unknown): Promise<unknown> {
		const p = (params ?? {}) as Record<string, unknown>;
		switch (op) {
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
			case "cancel":
				return this.exclusive(async () => this.appendFromPeer(peer, p.nodeId, p.event as Signed<LeaseEvent>, op));
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

	/** A peer's node's conversation, fetched from its owner. Read-only. */
	async fetchMessages(nodeId: string): Promise<unknown[]> {
		const node = this.host.node(nodeId);
		if (!node) throw new Error(`No node ${nodeId} in this tree.`);
		const { messages } = await this.request<{ messages: unknown[] }>(node.owner, "messages", { nodeId });
		return Array.isArray(messages) ? messages : [];
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

	/** Step 1, by the owner: offer a node to a paired person. */
	offer(nodeId: string, to: string): Promise<void> {
		return this.exclusive(async () => {
			await this.publishOwn();
			const node = this.host.node(nodeId);
			if (!node) throw new Error(`No node ${nodeId} in this tree.`);
			if (node.owner !== this.identity.name) throw new Error(`"${node.name}" is owned by ${node.owner}; only its owner can offer it.`);
			if (!this.book.get(to)) throw new Error(`You have not paired with anyone called "${to}".`);
			const now = this.now();
			this.appendOwn(nodeId, this.identity.sign<LeaseEvent>({
				type: "offer", id: newHandoffId(now), by: this.identity.name, to, expectedVersion: node.version, expiresAt: now + (this.options.offerTtlMs ?? 24 * 3600_000), now,
			}));
		});
	}

	/** Step 2, by the recipient: accept. The owner records it; ownership has not moved yet. */
	accept(nodeId: string): Promise<void> {
		return this.exclusive(async () => {
			const handoff = this.openHandoff(nodeId);
			if (handoff.role !== "recipient") throw new Error("Only the person it was offered to can accept.");
			if (!this.channels.has(handoff.from)) throw new Error(`${handoff.from} is offline. A handoff needs both of you online.`);
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
				this.appendOwn(nodeId, event);
				return;
			}
			if (!this.channels.has(handoff.from)) throw new Error(`${handoff.from} is offline. Try again when they are back.`);
			const { record } = await this.request<{ record: NodeRecord }>(handoff.from, "cancel", { nodeId, event });
			this.consider(record);
			this.emit("changed");
		});
	}

	/**
	 * Step 3, by the owner: confirm the release. This is the commit point. The session is
	 * stopped, the signed confirmation is recorded, and the conversation and branch are sent
	 * straight to the new owner. If the connection drops first, the package is kept and sent
	 * again when they are next reachable; it is deleted only on their signed receipt.
	 */
	confirm(nodeId: string): Promise<void> {
		return this.exclusive(async () => {
			const handoff = this.openHandoff(nodeId);
			if (handoff.role !== "owner") throw new Error("Only the current owner confirms a release.");
			if (handoff.state !== "accepted") throw new Error(`${handoff.to} has not accepted yet.`);
			if (!this.channels.has(handoff.to)) throw new Error(`${handoff.to} is offline. A handoff needs both of you online.`);
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
		this.emit("log", "info", `You now own "${record.meta.body.name}".`);
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

/** A reachable address for this machine: the first non-internal IPv4, else loopback. */
function guessHost(): string {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return "127.0.0.1";
}
