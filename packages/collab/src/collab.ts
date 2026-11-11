/**
 * Sharing a session tree between people. Each person runs their own host; this keeps the
 * hosts in agreement through a shared store:
 *
 *   people/<name>.json                              a person's public key, self-signed
 *   trees/<root>/nodes/<node>.json                  metadata plus the signed ownership log
 *   trees/<root>/mail/<owner>/<env>--<node>.json    signed envelopes for nodes that owner holds
 *   trees/<root>/transfer/<node>/<handoff>/         session and branch shipped by a confirmed handoff
 *
 * Nothing from another person is believed until the human has trusted that person's key,
 * and nothing from another person reaches a model without passing the recipient's inbox.
 */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type Envelope, type LeaseEvent, newHandoffId, type NodeMeta, validateEnvelope } from "@pi-lattice/protocol";
import { fingerprint, type Identity, isPersonName, type Signed, type TrustState, type TrustStore, verifySigned } from "./identity.ts";
import { appendEvent, foldRecord, type KeyLookup, type NodeRecord, parseRecord, type SharedMeta, toSharedMeta } from "./ledger.ts";
import type { SharedStore, Tx } from "./shared-store.ts";

/** The part of a lattice host that sharing needs. `LatticeHost` satisfies it. */
export interface HostPort {
	readonly owner: string;
	nodes(): NodeMeta[];
	node(id: string): NodeMeta | undefined;
	sleep(id: string): Promise<void>;
	setRemoteRouter(router: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined): void;
	importRemoteNode(node: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "owner" | "version" | "status" | "workspace" | "branch" | "createdAt">): void;
	deliverExternal(envelope: unknown, recipientId: string): void;
	releaseNode(id: string, toOwner: string, version: number): Promise<void>;
	adoptNode(id: string, options: { cwd: string; branch: string | null; workspace: NodeMeta["workspace"]; version: number; sessionFile?: string }): NodeMeta;
}

export interface CollabOptions {
	host: HostPort;
	store: SharedStore;
	identity: Identity;
	trust: TrustStore;
	/** Private working directory for queued mail. */
	dir: string;
	/** The local checkout of the project, where adopted nodes work. */
	projectDir: string;
	/** How often to synchronise, in milliseconds. 0 disables the timer; call sync() yourself. */
	pollMs?: number;
	/** How long an offer stays open, in milliseconds. */
	offerTtlMs?: number;
	now?: () => number;
}

export interface PersonView {
	name: string;
	publicKey: string;
	fingerprint: string;
	trust: TrustState;
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
	/** What this person is in the handoff. */
	role: "owner" | "recipient";
}

interface PersonRecord {
	name: string;
	publicKey: string;
	at: string;
}
interface MailRecord {
	envelope: Envelope;
	recipient: string;
}
interface OutboxItem extends MailRecord {
	rootId: string;
	toOwner: string;
}
interface TransferMeta {
	branch: string | null;
	workspace: NodeMeta["workspace"];
}
interface Adoption {
	nodeId: string;
	meta: SharedMeta;
	version: number;
	transferDir: string;
}
interface Plan {
	imports: Array<Parameters<HostPort["importRemoteNode"]>[0]>;
	releases: Array<{ nodeId: string; owner: string; version: number }>;
	adoptions: Adoption[];
	sentOutbox: string[];
	people: PersonView[];
	handoffs: HandoffView[];
	notes: string[];
}

const nodePath = (rootId: string, nodeId: string): string => `trees/${rootId}/nodes/${nodeId}.json`;
const transferPath = (rootId: string, nodeId: string, handoffId: string): string => `trees/${rootId}/transfer/${nodeId}/${handoffId}`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolvePromise(stdout.trim());
		});
	});
}

export interface CollabEvents {
	/** Shared state was synchronised; views may have changed. */
	changed: [];
	log: [level: "info" | "warn" | "error", message: string];
}

export class CollabSession extends EventEmitter<CollabEvents> {
	private readonly options: CollabOptions;
	private readonly host: HostPort;
	private readonly store: SharedStore;
	private readonly identity: Identity;
	private readonly trust: TrustStore;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;
	private chain: Promise<unknown> = Promise.resolve();
	private peopleView: PersonView[] = [];
	private handoffView: HandoffView[] = [];
	private soon: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(options: CollabOptions) {
		super();
		this.options = options;
		this.host = options.host;
		this.store = options.store;
		this.identity = options.identity;
		this.trust = options.trust;
		this.now = options.now ?? Date.now;
		if (this.identity.name !== this.host.owner) throw new Error(`The sharing identity "${this.identity.name}" must match the host owner "${this.host.owner}".`);
		for (const name of ["outbox", "inbox"]) mkdirSync(join(options.dir, name), { recursive: true });
		// A person always trusts their own key.
		if (this.trust.state(this.identity.name, this.identity.publicKey) !== "trusted") this.trust.trust(this.identity.name, this.identity.publicKey);
	}

	// --- lifecycle -------------------------------------------------------------

	/** Begin sharing: route mail for other owners through the shared store and synchronise on a timer. */
	async start(): Promise<void> {
		this.host.setRemoteRouter((envelope, recipient) => this.queueOutbound(envelope, recipient));
		await this.sync();
		const pollMs = this.options.pollMs ?? 5000;
		if (pollMs > 0) {
			this.timer = setInterval(() => void this.sync().catch((error: unknown) => this.emit("log", "warn", `Sharing sync failed: ${error instanceof Error ? error.message : String(error)}`)), pollMs);
			this.timer.unref();
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.soon) clearTimeout(this.soon);
		this.host.setRemoteRouter(undefined);
		await this.chain.catch(() => {});
		await this.store.close();
	}

	/** Run one piece of shared-state work at a time. */
	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.catch(() => {});
		return run;
	}

	private syncSoon(): void {
		if (this.soon || this.stopped) return;
		this.soon = setTimeout(() => {
			this.soon = undefined;
			void this.sync().catch(() => {});
		}, 50);
		this.soon.unref();
	}

	// --- views -----------------------------------------------------------------

	/** Everyone who has published a key, with whether this human trusts them. */
	people(): PersonView[] {
		return this.peopleView;
	}

	/** Open handoffs this person is part of. */
	handoffs(): HandoffView[] {
		return this.handoffView;
	}

	/** Pin a person's currently published key. Call only after the human has checked the fingerprint. */
	async trustPerson(name: string): Promise<void> {
		const person = this.peopleView.find((candidate) => candidate.name === name);
		if (!person) throw new Error(`Nobody called "${name}" has joined this shared tree.`);
		this.trust.trust(name, person.publicKey);
		await this.sync();
	}

	private keys(published: Map<string, string>): KeyLookup {
		return (person) => {
			if (person === this.identity.name) return this.identity.publicKey;
			const key = published.get(person);
			return key !== undefined && this.trust.state(person, key) === "trusted" ? key : undefined;
		};
	}

	// --- synchronisation -------------------------------------------------------

	/** One round: publish what is ours, take in what is theirs, move mail both ways. */
	sync(): Promise<void> {
		return this.exclusive(() => this.round());
	}

	private async round(): Promise<void> {
		if (this.stopped) return;
		let plan: Plan | undefined;
		await this.store.commit(`sync by ${this.identity.name}`, (tx) => {
			plan = this.reconcile(tx);
		});
		if (!plan) return;
		await this.apply(plan);
		this.emit("changed");
	}

	/** Run a handoff step against fresh shared state, then bring local state in line with the result. */
	private step(work: () => Promise<void>): Promise<void> {
		return this.exclusive(async () => {
			await this.round();
			await work();
			await this.round();
		});
	}

	private readPeople(tx: Tx): Map<string, string> {
		const published = new Map<string, string>();
		for (const file of tx.list("people")) {
			if (!file.endsWith(".json")) continue;
			try {
				const signed = JSON.parse(tx.read(`people/${file}`) ?? "") as Signed<PersonRecord>;
				const name = signed.body?.name;
				if (!isPersonName(name) || `${name}.json` !== file || signed.by !== name) continue;
				if (verifySigned(signed, signed.body.publicKey)) published.set(name, signed.body.publicKey);
			} catch {
				// Unreadable entry: that person simply is not known.
			}
		}
		return published;
	}

	private reconcile(tx: Tx): Plan {
		const me = this.identity.name;
		const now = this.now();
		const plan: Plan = { imports: [], releases: [], adoptions: [], sentOutbox: [], people: [], handoffs: [], notes: [] };

		// People.
		const mine = this.identity.sign<PersonRecord>({ name: me, publicKey: this.identity.publicKey, at: new Date(now).toISOString() });
		const published = this.readPeople(tx);
		if (published.get(me) !== this.identity.publicKey) {
			tx.write(`people/${me}.json`, json(mine));
			published.set(me, this.identity.publicKey);
		}
		const keys = this.keys(published);
		plan.people = [...published].sort(([a], [b]) => a.localeCompare(b)).map(([name, publicKey]) => ({
			name, publicKey, fingerprint: fingerprint(publicKey), self: name === me, trust: name === me ? "trusted" : this.trust.state(name, publicKey),
		}));

		// Publish the nodes held here.
		const local = new Map(this.host.nodes().map((node) => [node.id, node]));
		for (const node of local.values()) {
			if (node.owner !== me) continue;
			const path = nodePath(node.rootId, node.id);
			const record = parseRecord(tx.read(path));
			const meta = toSharedMeta(node);
			if (!record) {
				const created: NodeRecord = { genesis: this.identity.sign({ nodeId: node.id, owner: me, at: node.createdAt }), meta: this.identity.sign(meta), events: [] };
				tx.write(path, json(created));
				continue;
			}
			const folded = foldRecord(record, keys, now);
			if (!folded.valid) continue;
			if (folded.ownership.owner !== me) {
				plan.releases.push({ nodeId: node.id, owner: folded.ownership.owner, version: folded.ownership.version });
				continue;
			}
			if (JSON.stringify(record.meta.body) !== JSON.stringify(meta) || record.meta.by !== me) tx.write(path, json({ ...record, meta: this.identity.sign(meta) }));
			if (tx.exists(`trees/${node.rootId}/transfer/${node.id}`)) tx.remove(`trees/${node.rootId}/transfer/${node.id}`); // adopted; the copy is no longer needed
		}

		// Take in every shared node.
		const owners = new Map<string, string>(); // node id -> verified owner
		const needTrust = new Set<string>();
		for (const rootId of tx.list("trees")) {
			for (const file of tx.list(`trees/${rootId}/nodes`)) {
				const record = parseRecord(tx.read(`trees/${rootId}/nodes/${file}`));
				if (!record || `${record.meta.body.id}.json` !== file || record.genesis.body.nodeId !== record.meta.body.id) continue;
				const folded = foldRecord(record, keys, now);
				for (const person of folded.unverified) needTrust.add(person);
				if (!folded.valid || !folded.metaTrusted) continue;
				const meta = record.meta.body;
				const { owner, version, handoff } = folded.ownership;
				owners.set(meta.id, owner);
				const here = local.get(meta.id);
				if (owner !== me) {
					if (!here || here.owner !== me) plan.imports.push({ ...meta, owner, version });
				} else if (!here || here.owner !== me) {
					const handoffId = folded.ownership.lastHandoffId;
					if (handoffId) plan.adoptions.push({ nodeId: meta.id, meta, version, transferDir: tx.resolve(transferPath(rootId, meta.id, handoffId)) });
				}
				if (handoff && (handoff.from === me || handoff.to === me)) {
					plan.handoffs.push({
						nodeId: meta.id, nodeName: meta.name, handoffId: handoff.id, from: handoff.from, to: handoff.to, state: handoff.state,
						expiresAt: handoff.expiresAt, role: handoff.from === me ? "owner" : "recipient",
					});
				}
			}
		}
		if (needTrust.size > 0) plan.notes.push(`Not showing everything: you have not trusted ${[...needTrust].sort().join(", ")} yet.`);

		// Mail out.
		for (const file of readdirSync(join(this.options.dir, "outbox")).sort()) {
			if (!file.endsWith(".json")) continue;
			try {
				const item = JSON.parse(readFileSync(join(this.options.dir, "outbox", file), "utf8")) as OutboxItem;
				if (isPersonName(item.toOwner)) {
					tx.write(`trees/${item.rootId}/mail/${item.toOwner}/${file}`, json(this.identity.sign<MailRecord>({ envelope: item.envelope, recipient: item.recipient })));
				}
				plan.sentOutbox.push(file);
			} catch {
				plan.sentOutbox.push(file);
			}
		}

		// Mail in. Verified mail is copied to a local inbox before it is removed from the shared store.
		for (const rootId of tx.list("trees")) {
			for (const file of tx.list(`trees/${rootId}/mail/${me}`)) {
				const path = `trees/${rootId}/mail/${me}/${file}`;
				let signed: Signed<MailRecord> | undefined;
				try {
					signed = JSON.parse(tx.read(path) ?? "") as Signed<MailRecord>;
				} catch {
					signed = undefined;
				}
				const checked = signed ? validateEnvelope(signed.body?.envelope) : undefined;
				if (!signed || !checked?.ok) {
					tx.remove(path);
					plan.notes.push("Discarded a malformed message from the shared store.");
					continue;
				}
				const envelope = checked.envelope;
				const key = keys(signed.by);
				if (!key) {
					plan.notes.push(`A message from ${signed.by} is waiting, but you have not trusted ${signed.by} yet.`);
					continue; // stays in the shared store until the human decides
				}
				const genuine = verifySigned(signed, key) && envelope.fromOwner === signed.by && owners.get(envelope.from) === signed.by && owners.get(signed.body.recipient) === me;
				if (genuine) writeFileSync(join(this.options.dir, "inbox", file), JSON.stringify(signed.body));
				else plan.notes.push(`Discarded a message claiming to be from ${signed.by}: it did not verify.`);
				tx.remove(path);
			}
		}
		return plan;
	}

	private async apply(plan: Plan): Promise<void> {
		this.peopleView = plan.people;
		this.handoffView = plan.handoffs;
		for (const file of plan.sentOutbox) {
			try {
				unlinkSync(join(this.options.dir, "outbox", file));
			} catch {
				// Already gone.
			}
		}
		for (const node of plan.imports) this.host.importRemoteNode(node);
		for (const release of plan.releases) await this.host.releaseNode(release.nodeId, release.owner, release.version);
		for (const adoption of plan.adoptions) {
			try {
				await this.adopt(adoption);
			} catch (error) {
				this.emit("log", "error", `Could not take over "${adoption.meta.name}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const inbox = join(this.options.dir, "inbox");
		for (const file of readdirSync(inbox).sort()) {
			try {
				const mail = JSON.parse(readFileSync(join(inbox, file), "utf8")) as MailRecord;
				this.host.deliverExternal(mail.envelope, mail.recipient);
			} catch (error) {
				this.emit("log", "warn", `Dropped a shared message: ${error instanceof Error ? error.message : String(error)}`);
			}
			unlinkSync(join(inbox, file));
		}
		for (const note of plan.notes) this.emit("log", "info", note);
	}

	private queueOutbound(envelope: Envelope, recipient: NodeMeta): void {
		const item: OutboxItem = { envelope, recipient: recipient.id, rootId: recipient.rootId, toOwner: recipient.owner };
		const path = join(this.options.dir, "outbox", `${envelope.id}--${recipient.id}.json`);
		writeFileSync(`${path}.tmp`, JSON.stringify(item));
		renameSync(`${path}.tmp`, path);
		this.syncSoon();
	}

	// --- handoff ---------------------------------------------------------------

	/** Append an ownership event to a node's log, atomically, and optionally change other shared files with it. */
	private async lease(nodeId: string, build: () => LeaseEvent, alongside?: (tx: Tx, rootId: string) => void): Promise<void> {
		const node = this.host.node(nodeId);
		if (!node) throw new Error(`No node ${nodeId} in this tree.`);
		let failure: string | undefined;
		await this.store.commit(`${build().type} ${node.name} by ${this.identity.name}`, (tx) => {
			failure = undefined;
			const path = nodePath(node.rootId, nodeId);
			const record = parseRecord(tx.read(path));
			if (!record) {
				failure = `"${node.name}" has not been shared yet.`;
				return false;
			}
			const result = appendEvent(record, this.identity.sign(build()), this.keys(this.readPeople(tx)), this.now());
			if (!result.ok) {
				failure = result.error;
				return false;
			}
			if (!result.changed) return false;
			tx.write(path, json(result.record));
			alongside?.(tx, node.rootId);
			return true;
		});
		if (failure) throw new Error(failure);
	}

	private openHandoff(nodeId: string): HandoffView {
		const handoff = this.handoffView.find((candidate) => candidate.nodeId === nodeId);
		if (!handoff) throw new Error("There is no open handoff for this session.");
		return handoff;
	}

	/** Step 1, by the owner: offer a node to a named, trusted person. */
	offer(nodeId: string, to: string): Promise<void> {
		return this.step(async () => {
			const node = this.host.node(nodeId);
			if (!node) throw new Error(`No node ${nodeId} in this tree.`);
			if (node.owner !== this.identity.name) throw new Error(`"${node.name}" is owned by ${node.owner}; only its owner can offer it.`);
			const person = this.peopleView.find((candidate) => candidate.name === to);
			if (!person) throw new Error(`Nobody called "${to}" has joined this shared tree.`);
			if (person.trust !== "trusted") throw new Error(`Trust ${to} first: compare their key fingerprint (${person.fingerprint}) with them directly.`);
			const id = newHandoffId(this.now());
			const now = this.now();
			await this.lease(nodeId, () => ({ type: "offer", id, by: this.identity.name, to, expectedVersion: node.version, expiresAt: now + (this.options.offerTtlMs ?? 24 * 3600_000), now }));
		});
	}

	/** Step 2, by the recipient: accept an offer. Ownership has not moved yet. */
	accept(nodeId: string): Promise<void> {
		return this.step(async () => {
			const handoff = this.openHandoff(nodeId);
			await this.lease(nodeId, () => ({ type: "accept", id: handoff.handoffId, by: this.identity.name, now: this.now() }));
		});
	}

	/** Either side, any time before the release is confirmed: call the handoff off. */
	cancel(nodeId: string): Promise<void> {
		return this.step(async () => {
			const handoff = this.openHandoff(nodeId);
			await this.lease(nodeId, () => ({ type: "cancel", id: handoff.handoffId, by: this.identity.name, now: this.now() }));
		});
	}

	/**
	 * Step 3, by the owner: confirm the release. The session is stopped, its conversation and
	 * branch are shipped, and the ownership flip is committed together with them. Only when
	 * that commit lands does this host give the node up.
	 */
	confirm(nodeId: string): Promise<void> {
		return this.step(async () => {
			const handoff = this.openHandoff(nodeId);
			if (handoff.role !== "owner") throw new Error("Only the current owner confirms a release.");
			if (handoff.state !== "accepted") throw new Error(`${handoff.to} has not accepted yet.`);
			await this.host.sleep(nodeId);
			const node = this.host.node(nodeId);
			if (!node) throw new Error(`No node ${nodeId} in this tree.`);
			const session = node.sessionFile && existsSync(node.sessionFile) ? readFileSync(node.sessionFile) : undefined;
			const bundle = node.branch ? await this.bundleBranch(node) : undefined;
			const transfer: TransferMeta = { branch: bundle ? node.branch : null, workspace: bundle ? "worktree" : "shared" };
			await this.lease(
				nodeId,
				() => ({ type: "confirm", id: handoff.handoffId, by: this.identity.name, now: this.now() }),
				(tx, rootId) => {
					const dir = transferPath(rootId, nodeId, handoff.handoffId);
					tx.write(`${dir}/meta.json`, json(transfer));
					if (session) tx.write(`${dir}/session.jsonl`, session);
					if (bundle) tx.write(`${dir}/branch.bundle`, bundle);
				},
			);
			await this.host.releaseNode(nodeId, handoff.to, node.version + 1);
		});
	}

	/** Pack a node's branch so the new owner can recreate it without a shared code remote. */
	private async bundleBranch(node: NodeMeta): Promise<Buffer | undefined> {
		if (!node.branch || !node.cwd || !existsSync(node.cwd)) return undefined;
		const out = join(this.options.dir, `bundle-${node.id}.tmp`);
		try {
			await git(node.cwd, "bundle", "create", out, node.branch);
			return readFileSync(out);
		} catch (error) {
			this.emit("log", "warn", `Could not pack branch ${node.branch}; handing off the conversation only. ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		} finally {
			if (existsSync(out)) unlinkSync(out);
		}
	}

	private async adopt(adoption: Adoption): Promise<void> {
		const project = resolve(this.options.projectDir);
		let cwd = project;
		let branch: string | null = null;
		let workspace: NodeMeta["workspace"] = "shared";
		let transfer: TransferMeta = { branch: null, workspace: "shared" };
		try {
			transfer = JSON.parse(readFileSync(join(adoption.transferDir, "meta.json"), "utf8")) as TransferMeta;
		} catch {
			// No transfer metadata: adopt with the conversation only, or with nothing.
		}
		const bundle = join(adoption.transferDir, "branch.bundle");
		if (transfer.branch && existsSync(bundle)) {
			const common = await git(project, "rev-parse", "--git-common-dir");
			const mainRoot = dirname(isAbsolute(common) ? common : resolve(project, common));
			const path = join(mainRoot, ".lattice", "worktrees", adoption.nodeId);
			await git(project, "fetch", "-q", bundle, `+refs/heads/${transfer.branch}:refs/heads/${transfer.branch}`);
			if (!existsSync(path)) {
				mkdirSync(dirname(path), { recursive: true });
				await git(project, "worktree", "add", path, transfer.branch);
			}
			cwd = path;
			branch = transfer.branch;
			workspace = "worktree";
		}
		const session = join(adoption.transferDir, "session.jsonl");
		if (!this.host.node(adoption.nodeId)) this.host.importRemoteNode({ ...adoption.meta, owner: "unknown", version: adoption.version });
		this.host.adoptNode(adoption.nodeId, { cwd, branch, workspace, version: adoption.version, ...(existsSync(session) ? { sessionFile: session } : {}) });
		this.emit("log", "info", `You now own "${adoption.meta.name}".`);
	}
}
