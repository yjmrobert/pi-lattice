/**
 * The lattice host: source of truth for the session tree. It creates nodes, runs each one
 * as a Pi child process, routes and journals every envelope between them, and surfaces
 * anything that needs a human (blocked dialogs, mail awaiting approval).
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Channel,
	childrenOf,
	DEFAULT_LIMITS,
	depthOf,
	type Envelope,
	HOST_ENV,
	type InboundState,
	isRelativeAddress,
	type Limits,
	newNodeId,
	type NodeMeta,
	type NodeStatus,
	type PeerInfo,
	type RequestMap,
	type RequestOp,
	type SpawnSpec,
	treeOf,
	validateEnvelope,
	WORKSPACE_MODES,
} from "@pi-lattice/protocol";
import { type ExitInfo, PiProcess, type RpcRecord } from "./pi-process.ts";
import { type Connection, type Hello, SocketServer } from "./socket-server.ts";
import { type JournalRecord, SqliteStore, type Store } from "./store.ts";
import { createWorktree } from "./workspace.ts";

export interface HostOptions {
	/** Directory for the database, sessions and child mailboxes. One host per directory. */
	stateDir: string;
	/** Who owns the nodes this host creates. Defaults to the OS user. */
	owner?: string;
	/** How to start Pi. Defaults to `LATTICE_PI_BIN`, else `pi` on PATH. */
	piCommand?: string[];
	/** Extra arguments for every session, for example a provider and model. */
	piArgs?: string[];
	/** Extension paths loaded into every session. Defaults to the lattice a2a, roles and graph packages. */
	extensionPaths?: string[];
	/** Extra environment for every session. */
	env?: Record<string, string>;
	limits?: Partial<Limits>;
	/** Directory for the unix socket. Defaults to a private directory under XDG_RUNTIME_DIR or the temp dir. */
	socketDir?: string;
	/** Milliseconds to wait for a session to start and connect. */
	startTimeoutMs?: number;
}

/** A dialog a session is blocked on until a human answers. */
export interface Dialog {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
}

export interface RootSpec {
	name: string;
	cwd: string;
	kind?: string;
	brief?: string;
	fragments?: string[];
}

export interface HostEvents {
	/** A node was created or changed. */
	node: [node: NodeMeta];
	/** An envelope was routed. */
	envelope: [envelope: Envelope, recipients: string[]];
	/** An inbound envelope changed state in a node's mailbox. */
	mail: [nodeId: string, envelope: Envelope, state: InboundState];
	/** The set of dialogs blocking a node changed. */
	dialog: [nodeId: string];
	/** A raw session event or UI request from a node's Pi process. */
	session: [nodeId: string, event: RpcRecord];
	log: [level: "info" | "warn" | "error", message: string];
}

interface Runtime {
	proc: PiProcess;
	token: string;
	channels: Map<Channel, Connection>;
	dialogs: Map<string, Dialog>;
	streaming: boolean;
	/** Envelope ids sent on the current a2a connection and not yet acknowledged. */
	inflight: Set<string>;
	lastActive: number;
	connected: Promise<void>;
	markConnected: () => void;
	failConnect: (error: Error) => void;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function defaultExtensionPaths(): string[] {
	return ["@pi-lattice/a2a", "@pi-lattice/roles", "@pi-lattice/graph"].map((name) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class LatticeHost extends EventEmitter<HostEvents> {
	readonly stateDir: string;
	readonly owner: string;
	readonly limits: Limits;
	readonly socketPath: string;
	private readonly options: HostOptions;
	private readonly store: Store;
	private readonly server: SocketServer;
	private readonly runtimes = new Map<string, Runtime>();
	private readonly starting = new Map<string, Promise<void>>();
	private readonly pinned = new Set<string>();
	private remoteRouter: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined;
	private stopped = false;

	private constructor(options: HostOptions) {
		super();
		this.options = options;
		this.stateDir = resolve(options.stateDir);
		this.owner = options.owner ?? process.env[HOST_ENV.owner] ?? userInfo().username;
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		mkdirSync(this.stateDir, { recursive: true });

		const socketDir = options.socketDir ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `pi-lattice-${userInfo().uid}`);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });
		chmodSync(socketDir, 0o700);
		this.socketPath = join(socketDir, `${createHash("sha256").update(this.stateDir).digest("hex").slice(0, 16)}.sock`);

		this.store = new SqliteStore(join(this.stateDir, "host.db"));
		this.server = new SocketServer(this.socketPath, {
			authenticate: (token, nodeId) => this.runtimes.get(nodeId)?.token === token,
			onHello: (connection, hello) => this.onHello(connection, hello),
			onRequest: (connection, op, params) => this.onRequest(connection, op, params),
			onAck: (connection, envelopeId) => {
				this.store.markAcked(envelopeId, connection.nodeId);
				this.runtimes.get(connection.nodeId)?.inflight.delete(envelopeId);
			},
			onMail: (connection, envelope, state) => {
				this.store.setMailState(envelope.id, connection.nodeId, state);
				this.emit("mail", connection.nodeId, envelope, state);
			},
			onClose: (connection) => {
				const runtime = this.runtimes.get(connection.nodeId);
				if (runtime?.channels.get(connection.channel) === connection) runtime.channels.delete(connection.channel);
			},
		});
	}

	/** Start a host for a state directory. Fails if another live host already serves it. */
	static async start(options: HostOptions): Promise<LatticeHost> {
		const lockPath = join(resolve(options.stateDir), "host.lock");
		mkdirSync(dirname(lockPath), { recursive: true });
		if (existsSync(lockPath)) {
			const pid = Number(readFileSync(lockPath, "utf8").trim());
			if (pid !== process.pid && Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
				throw new Error(`Another lattice host (pid ${pid}) is already running for ${resolve(options.stateDir)}.`);
			}
		}
		writeFileSync(lockPath, String(process.pid));
		const host = new LatticeHost(options);
		// Sessions die with the host that ran them, so nothing recorded as live is live now.
		for (const node of host.store.listNodes()) {
			if (node.status !== "dormant" && node.status !== "exited" && node.status !== "failed") host.store.updateNode(node.id, { status: "dormant" });
		}
		await host.server.listen();
		return host;
	}

	// --- queries ---------------------------------------------------------------

	nodes(): NodeMeta[] {
		return this.store.listNodes();
	}

	node(id: string): NodeMeta | undefined {
		return this.store.getNode(id);
	}

	isRunning(id: string): boolean {
		return this.runtimes.has(id);
	}

	/** Dialogs currently blocking a node. */
	dialogs(id: string): Dialog[] {
		return [...(this.runtimes.get(id)?.dialogs.values() ?? [])];
	}

	/** Journal records, newest first. */
	traffic(options?: { limit?: number; mailState?: InboundState; node?: string }): JournalRecord[] {
		return this.store.traffic(options);
	}

	/** Mail waiting for a human decision anywhere in the tree. */
	pendingMail(): JournalRecord[] {
		return this.store.traffic({ mailState: "pending", limit: 1000 }).reverse();
	}

	// --- tree ------------------------------------------------------------------

	/** Create a root node and start its session. A brief, if given, is sent as its first prompt. */
	async createRoot(spec: RootSpec): Promise<NodeMeta> {
		const id = newNodeId();
		const node = this.insert({
			id, parentId: null, rootId: id, kind: spec.kind ?? "feature", name: clean(spec.name, id), brief: spec.brief ?? "",
			fragments: spec.fragments ?? [], cwd: resolve(spec.cwd), workspace: "shared", branch: null,
		});
		await this.ensureRunning(node.id);
		if (node.brief.trim() !== "") await this.prompt(node.id, node.brief);
		return this.must(node.id);
	}

	/** Create a child under a node, start it and hand it its brief. Enforces the tree limits. */
	async spawnChild(parentId: string, spec: SpawnSpec): Promise<NodeMeta> {
		const parent = this.store.getNode(parentId);
		if (!parent) throw new Error(`No node ${parentId} in this tree.`);
		if (parent.owner !== this.owner) throw new Error(`"${parent.name}" is owned by ${parent.owner}. Children can only be added under sessions you own.`);
		const all = this.store.listNodes();
		if (typeof spec.name !== "string" || spec.name.trim() === "") throw new Error("A child session needs a name.");
		if (typeof spec.brief !== "string" || spec.brief.trim() === "") throw new Error("A child session needs a brief.");
		if (depthOf(all, parentId) + 1 > this.limits.maxDepth) {
			throw new Error(`Not spawned: the tree is limited to ${this.limits.maxDepth} levels below the root. Do this work in the current session, or ask the user to raise the limit.`);
		}
		if (childrenOf(all, parentId).length >= this.limits.maxChildren) {
			throw new Error(`Not spawned: this session already has ${this.limits.maxChildren} children, the limit. Reuse an existing child or ask the user to raise the limit.`);
		}
		if (treeOf(all, parent.rootId).length >= this.limits.maxNodes) {
			throw new Error(`Not spawned: the tree already has ${this.limits.maxNodes} sessions, the limit. Ask the user before growing it further.`);
		}
		const workspace = spec.workspace ?? "shared";
		if (!(WORKSPACE_MODES as readonly string[]).includes(workspace)) throw new Error(`Unknown workspace "${workspace}". Use shared or worktree.`);
		const fragments = (spec.fragments ?? []).filter((name) => typeof name === "string" && name.trim() !== "").map((name) => name.trim());

		const id = newNodeId();
		const name = clean(spec.name, id);
		let cwd = parent.cwd;
		let branch: string | null = null;
		if (workspace === "worktree") {
			const worktree = createWorktree(parent.cwd, id, name);
			cwd = worktree.cwd;
			branch = worktree.branch;
		}
		const node = this.insert({
			id, parentId, rootId: parent.rootId, kind: (spec.kind ?? "task").trim() || "task", name, brief: spec.brief, fragments, cwd, workspace, branch,
		});
		try {
			await this.ensureRunning(node.id);
			await this.prompt(node.id, briefPrompt(parent, node));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`The child "${name}" (${id}) was created but could not be started: ${message}`);
		}
		return this.must(node.id);
	}

	private insert(fields: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "cwd" | "workspace" | "branch">): NodeMeta {
		const now = new Date().toISOString();
		const node: NodeMeta = { ...fields, owner: this.owner, version: 1, status: "dormant", sessionId: null, sessionFile: null, createdAt: now, updatedAt: now };
		this.store.insertNode(node);
		this.emit("node", node);
		return node;
	}

	private must(id: string): NodeMeta {
		const node = this.store.getNode(id);
		if (!node) throw new Error(`No node ${id} in this tree.`);
		return node;
	}

	private update(id: string, patch: Partial<Omit<NodeMeta, "id">>): NodeMeta {
		const node = this.store.updateNode(id, patch);
		this.emit("node", node);
		return node;
	}

	// --- supervision -----------------------------------------------------------

	/** Keep a node's process from being stopped to make room for others, for example while attached. */
	pin(id: string): void {
		this.pinned.add(id);
	}

	unpin(id: string): void {
		this.pinned.delete(id);
	}

	/** Make sure a node's session process is running and connected. Starts or resumes it if needed. */
	ensureRunning(id: string): Promise<void> {
		const runtime = this.runtimes.get(id);
		if (runtime) return runtime.connected;
		const inFlight = this.starting.get(id);
		if (inFlight) return inFlight;
		const started = this.startNode(id).finally(() => this.starting.delete(id));
		this.starting.set(id, started);
		return started;
	}

	private async startNode(id: string): Promise<void> {
		if (this.stopped) throw new Error("The lattice host is shutting down.");
		const node = this.must(id);
		if (node.owner !== this.owner) {
			throw new Error(`"${node.name}" is owned by ${node.owner} and runs on their machine. You can see it here, but not run it.`);
		}
		await this.makeRoom(id);

		const token = randomBytes(24).toString("hex");
		const sessionDir = join(this.stateDir, "sessions", id);
		mkdirSync(sessionDir, { recursive: true });
		const args = [
			...(this.options.piArgs ?? []),
			...(this.options.extensionPaths ?? defaultExtensionPaths()).flatMap((path) => ["-e", path]),
			"--session-dir", sessionDir,
		];
		if (node.sessionFile && existsSync(node.sessionFile)) args.push("--session", node.sessionFile);
		else if (existsSync(this.adoptPath(id))) args.push("--fork", this.adoptPath(id), "--name", node.name);
		else args.push("--name", node.name);

		const proc = new PiProcess({
			command: this.options.piCommand ?? (process.env.LATTICE_PI_BIN ? [process.env.LATTICE_PI_BIN] : ["pi"]),
			args,
			cwd: existsSync(node.cwd) ? node.cwd : process.cwd(),
			env: {
				...process.env,
				...this.options.env,
				[HOST_ENV.socket]: this.socketPath,
				[HOST_ENV.token]: token,
				[HOST_ENV.nodeId]: node.id,
				[HOST_ENV.parentId]: node.parentId ?? "",
				[HOST_ENV.rootId]: node.rootId,
				[HOST_ENV.kind]: node.kind,
				[HOST_ENV.name]: node.name,
				[HOST_ENV.fragments]: node.fragments.join(","),
				[HOST_ENV.owner]: node.owner,
				[HOST_ENV.home]: join(this.stateDir, "home"),
			},
		});
		let markConnected!: () => void;
		let failConnect!: (error: Error) => void;
		const connected = new Promise<void>((resolveConnected, rejectConnected) => {
			markConnected = resolveConnected;
			failConnect = rejectConnected;
		});
		connected.catch(() => {});
		const runtime: Runtime = {
			proc, token, channels: new Map(), dialogs: new Map(), streaming: false, inflight: new Set(), lastActive: Date.now(), connected, markConnected, failConnect,
		};
		this.runtimes.set(id, runtime);
		this.update(id, { status: "starting" });

		proc.on("event", (event: RpcRecord) => this.onSessionEvent(id, runtime, event));
		proc.on("exit", (info: ExitInfo) => this.onExit(id, runtime, info));
		proc.start();

		const timeout = setTimeout(
			() => failConnect(new Error(`session did not connect within ${this.options.startTimeoutMs ?? 30_000} ms. ${proc.stderrTail.trim().slice(-400)}`)),
			this.options.startTimeoutMs ?? 30_000,
		);
		try {
			await connected;
		} catch (error) {
			await proc.stop(1000);
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	/** Enforce the cap on running sessions by putting the least recently active idle one to sleep. */
	private async makeRoom(forId: string): Promise<void> {
		while (this.runtimes.size >= this.limits.maxRunning) {
			const idle = [...this.runtimes.entries()]
				.filter(([id, runtime]) => id !== forId && !this.pinned.has(id) && !runtime.streaming && runtime.dialogs.size === 0 && this.store.unacked(id).length === 0)
				.sort(([, a], [, b]) => a.lastActive - b.lastActive)[0];
			if (!idle) {
				throw new Error(`${this.limits.maxRunning} sessions are already running and none is idle. Wait for one to finish, or raise the limit.`);
			}
			await this.sleep(idle[0]);
		}
	}

	/** Stop a node's process. The node stays in the tree as dormant and resumes on demand. */
	async sleep(id: string): Promise<void> {
		const runtime = this.runtimes.get(id);
		if (runtime) await runtime.proc.stop();
	}

	private status(runtime: Runtime): NodeStatus {
		if (runtime.dialogs.size > 0) return "blocked";
		return runtime.streaming ? "running" : "idle";
	}

	private refresh(id: string, runtime: Runtime): void {
		if (this.runtimes.get(id) !== runtime || !runtime.channels.has("a2a")) return;
		const status = this.status(runtime);
		if (this.store.getNode(id)?.status !== status) this.update(id, { status });
	}

	private onSessionEvent(id: string, runtime: Runtime, event: RpcRecord): void {
		runtime.lastActive = Date.now();
		if (event.type === "agent_start") {
			runtime.streaming = true;
			this.refresh(id, runtime);
		} else if (event.type === "agent_settled") {
			runtime.streaming = false;
			this.refresh(id, runtime);
			this.wakeQueued();
		} else if (event.type === "extension_ui_request" && DIALOG_METHODS.has(event.method)) {
			const dialog: Dialog = { id: String(event.id), method: event.method, title: String(event.title ?? "") };
			if (typeof event.message === "string") dialog.message = event.message;
			if (Array.isArray(event.options)) dialog.options = event.options.map(String);
			if (typeof event.placeholder === "string") dialog.placeholder = event.placeholder;
			if (typeof event.prefill === "string") dialog.prefill = event.prefill;
			runtime.dialogs.set(dialog.id, dialog);
			this.refresh(id, runtime);
			this.emit("dialog", id);
		}
		this.emit("session", id, event);
	}

	private onExit(id: string, runtime: Runtime, info: ExitInfo): void {
		if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
		for (const connection of runtime.channels.values()) connection.close();
		const detail = info.error ?? runtime.proc.stderrTail.trim().slice(-400);
		runtime.failConnect(new Error(`Pi exited before the session connected${detail ? `: ${detail}` : "."}`));
		const hadDialogs = runtime.dialogs.size > 0;
		runtime.dialogs.clear();
		if (hadDialogs) this.emit("dialog", id);
		if (!this.store.getNode(id)) return;
		if (runtime.proc.stopRequested) {
			this.update(id, { status: "dormant" });
		} else if (info.code === 0) {
			this.update(id, { status: "exited" });
		} else {
			this.update(id, { status: "failed" });
			this.emit("log", "error", `Session ${id} exited unexpectedly (code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""}). ${detail}`);
		}
		this.wakeQueued();
	}

	/**
	 * Start sessions that have mail waiting but could not be woken earlier, typically because
	 * the running cap was reached. Called whenever capacity may have been freed.
	 */
	private wakeQueued(): void {
		if (this.stopped) return;
		for (const id of this.store.recipientsWithUnacked()) {
			if (this.runtimes.has(id) || this.starting.has(id)) continue;
			const node = this.store.getNode(id);
			if (!node || node.status === "failed") continue;
			this.ensureRunning(id).catch(() => {
				// Still no room; the next freed slot retries.
			});
		}
	}

	// --- human interaction -----------------------------------------------------

	/**
	 * Send human input to a node, starting it if needed. While the agent is working the
	 * input is queued: `steer` delivers it at the next step, `followUp` after it finishes.
	 */
	async prompt(id: string, message: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<void> {
		await this.ensureRunning(id);
		const runtime = this.runtimes.get(id);
		if (!runtime) throw new Error(`Session ${id} is not running.`);
		const result = await runtime.proc.request<{ disposition?: string } | undefined>({ type: "prompt", message, streamingBehavior: whenBusy });
		// A run has been accepted; reflect it now instead of waiting for the agent_start event.
		if (result?.disposition === "started" && this.runtimes.get(id) === runtime) {
			runtime.streaming = true;
			this.refresh(id, runtime);
		}
	}

	/** Stop the agent's current work in a node. */
	async abort(id: string): Promise<void> {
		await this.runtimes.get(id)?.proc.request({ type: "abort" });
	}

	/** Send any Pi RPC command to a running node, for example `get_messages` or `get_state`. */
	async rpc<T = unknown>(id: string, command: RpcRecord): Promise<T> {
		const runtime = this.runtimes.get(id);
		if (!runtime) throw new Error(`Session ${id} is not running.`);
		return runtime.proc.request<T>(command);
	}

	/** Answer a dialog a node is blocked on. Nothing answers dialogs automatically. */
	answerDialog(id: string, dialogId: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		const runtime = this.runtimes.get(id);
		if (!runtime?.dialogs.has(dialogId)) throw new Error(`No open dialog ${dialogId} on session ${id}.`);
		runtime.proc.respondUI(dialogId, answer);
		runtime.dialogs.delete(dialogId);
		this.refresh(id, runtime);
		this.emit("dialog", id);
	}

	/** Approve or reject mail that is waiting in a node's inbox. Wakes the node if it is dormant. */
	async decideMail(nodeId: string, envelopeId: string, action: "approve" | "reject"): Promise<void> {
		await this.ensureRunning(nodeId);
		const connection = this.runtimes.get(nodeId)?.channels.get("a2a");
		if (!connection) throw new Error(`Session ${nodeId} has no messaging connection.`);
		connection.send({ t: "decide", envelopeId, action });
	}

	// --- broker ----------------------------------------------------------------

	private onHello(connection: Connection, hello: Hello): void {
		const runtime = this.runtimes.get(connection.nodeId);
		if (!runtime) {
			connection.close();
			return;
		}
		runtime.channels.get(connection.channel)?.close();
		runtime.channels.set(connection.channel, connection);
		if (hello.sessionId !== undefined || hello.sessionFile !== undefined) {
			const node = this.store.getNode(connection.nodeId);
			const patch: Partial<NodeMeta> = {};
			if (hello.sessionId !== undefined && node?.sessionId !== hello.sessionId) patch.sessionId = hello.sessionId;
			if (hello.sessionFile !== undefined && node?.sessionFile !== hello.sessionFile) patch.sessionFile = hello.sessionFile;
			if (Object.keys(patch).length > 0) this.update(connection.nodeId, patch);
			// A transferred session has now been forked into a local one; the transfer copy is no longer needed.
			if (hello.sessionFile !== undefined && existsSync(this.adoptPath(connection.nodeId))) unlinkSync(this.adoptPath(connection.nodeId));
		}
		if (connection.channel === "a2a") {
			runtime.inflight.clear();
			runtime.markConnected();
			this.refresh(connection.nodeId, runtime);
			this.flush(connection.nodeId);
		}
	}

	/** Push unacknowledged envelopes to a node if it is connected. Returns false when it is not. */
	private flush(nodeId: string): boolean {
		const runtime = this.runtimes.get(nodeId);
		const connection = runtime?.channels.get("a2a");
		if (!runtime || !connection) return false;
		for (const envelope of this.store.unacked(nodeId)) {
			if (runtime.inflight.has(envelope.id)) continue;
			runtime.inflight.add(envelope.id);
			connection.send({ t: "deliver", envelope });
		}
		return true;
	}

	private async onRequest(connection: Connection, op: RequestOp, params: unknown): Promise<unknown> {
		const self = this.must(connection.nodeId);
		switch (op) {
			case "send":
				return this.route(self, (params as RequestMap["send"]["params"]).envelope) satisfies RequestMap["send"]["result"];
			case "peers":
				return { peers: this.peersOf(self) } satisfies RequestMap["peers"]["result"];
			case "list":
				return { self: self.id, nodes: treeOf(this.store.listNodes(), self.rootId) } satisfies RequestMap["list"]["result"];
			case "spawn":
				return { node: await this.spawnChild(self.id, (params as RequestMap["spawn"]["params"]).spec) } satisfies RequestMap["spawn"]["result"];
			default:
				throw new Error(`Unknown request "${String(op)}".`);
		}
	}

	private peersOf(self: NodeMeta): PeerInfo[] {
		return treeOf(this.store.listNodes(), self.rootId)
			.filter((node) => node.id !== self.id)
			.map((node) => ({
				id: node.id,
				name: node.name,
				owner: node.owner,
				kind: node.kind,
				cwd: node.cwd,
				status: node.status,
				relation:
					node.id === self.parentId ? "parent" : node.parentId === self.id ? "child" : node.id === self.rootId ? "root" : node.parentId === self.parentId ? "sibling" : "other",
			}));
	}

	/** Validate, resolve, journal and deliver an envelope sent by a node. */
	private route(sender: NodeMeta, value: unknown): { recipients: string[] } {
		const checked = validateEnvelope(value, this.limits);
		if (!checked.ok) throw new Error(`Not sent: ${checked.errors.join("; ")}`);
		const envelope = checked.envelope;
		if (envelope.from !== sender.id || envelope.fromOwner !== sender.owner) throw new Error("Not sent: the envelope does not match the sending session.");

		let recipients: string[];
		if (isRelativeAddress(envelope.to)) {
			if (envelope.to === "parent") {
				if (!sender.parentId) throw new Error("This session is the root of its tree and has no parent. Report to the user instead.");
				recipients = [sender.parentId];
			} else if (envelope.to === "root") {
				if (sender.rootId === sender.id) throw new Error("This session is the root of its tree.");
				recipients = [sender.rootId];
			} else {
				recipients = childrenOf(this.store.listNodes(), sender.id).map((node) => node.id);
				if (recipients.length === 0) throw new Error("This session has no children to message.");
			}
		} else {
			if (envelope.to === sender.id) throw new Error("Cannot send a message to yourself.");
			if (!this.store.getNode(envelope.to)) throw new Error(`No node ${envelope.to} in this tree. Use list_sessions to see the tree.`);
			recipients = [envelope.to];
		}

		const remote = recipients.map((id) => this.must(id)).filter((node) => node.owner !== this.owner);
		if (remote.length > 0 && !this.remoteRouter) {
			throw new Error(`Not sent: ${remote.map((node) => `"${node.name}"`).join(", ")} belongs to ${remote[0]?.owner}, and this tree is not being shared right now.`);
		}
		const local = recipients.filter((id) => !remote.some((node) => node.id === id));
		for (const recipient of local) this.store.journal(envelope, recipient);
		for (const node of remote) this.remoteRouter?.(envelope, node);
		this.emit("envelope", envelope, recipients);
		for (const recipient of local) {
			if (!this.flush(recipient)) {
				// Dormant recipient: wake it. The mail is delivered when its session connects.
				this.ensureRunning(recipient).catch((error: unknown) => {
					this.emit("log", "warn", `Mail for ${recipient} is queued; the session could not be started: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		}
		return { recipients };
	}

	// --- shared trees ----------------------------------------------------------

	private adoptPath(id: string): string {
		return join(this.stateDir, "adopt", `${id}.jsonl`);
	}

	/** Called with every envelope addressed to a node another person owns. Without one, such sends are refused. */
	setRemoteRouter(router: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined): void {
		this.remoteRouter = router;
	}

	/** Record or refresh a node that someone else owns. It appears in the tree but cannot be run here. */
	importRemoteNode(remote: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "owner" | "version" | "status" | "workspace" | "branch" | "createdAt">): void {
		if (remote.owner === this.owner) throw new Error("importRemoteNode is for nodes owned by someone else.");
		const existing = this.store.getNode(remote.id);
		if (!existing) {
			const node: NodeMeta = { ...remote, sessionId: null, sessionFile: null, cwd: "", updatedAt: new Date().toISOString() };
			this.store.insertNode(node);
			this.emit("node", node);
			return;
		}
		if (existing.owner === this.owner) return; // releasing a node is explicit; see releaseNode
		const changed = (["parentId", "kind", "name", "brief", "owner", "version", "status", "workspace", "branch"] as const).some((key) => existing[key] !== remote[key]) ||
			existing.fragments.join(",") !== remote.fragments.join(",");
		if (changed) {
			this.update(remote.id, {
				parentId: remote.parentId, kind: remote.kind, name: remote.name, brief: remote.brief, fragments: remote.fragments, owner: remote.owner,
				version: remote.version, status: remote.status, workspace: remote.workspace, branch: remote.branch,
			});
		}
	}

	/** Deliver an envelope that arrived from another person's host to a node owned here. */
	deliverExternal(value: unknown, recipientId: string): void {
		const checked = validateEnvelope(value, this.limits);
		if (!checked.ok) throw new Error(`Rejected remote mail: ${checked.errors.join("; ")}`);
		const recipient = this.must(recipientId);
		if (recipient.owner !== this.owner) throw new Error(`Rejected remote mail: ${recipientId} is not owned here.`);
		this.store.journal(checked.envelope, recipientId);
		this.emit("envelope", checked.envelope, [recipientId]);
		if (!this.flush(recipientId)) {
			this.ensureRunning(recipientId).catch((error: unknown) => {
				this.emit("log", "warn", `Mail for ${recipientId} is queued; the session could not be started: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}

	/** Give up a node after a confirmed handoff: stop its session and mark it as someone else's. */
	async releaseNode(id: string, toOwner: string, version: number): Promise<void> {
		this.must(id);
		await this.sleep(id);
		this.unpin(id);
		this.update(id, { owner: toOwner, version, status: "dormant" });
	}

	/**
	 * Take over a node after a confirmed handoff. The transferred session file is copied and
	 * forked into a local session the first time the node runs (ADR 0007).
	 */
	adoptNode(id: string, options: { cwd: string; branch: string | null; workspace: NodeMeta["workspace"]; version: number; sessionFile?: string }): NodeMeta {
		this.must(id);
		if (options.sessionFile && existsSync(options.sessionFile)) {
			mkdirSync(dirname(this.adoptPath(id)), { recursive: true });
			copyFileSync(options.sessionFile, this.adoptPath(id));
		}
		return this.update(id, {
			owner: this.owner, version: options.version, cwd: resolve(options.cwd), branch: options.branch, workspace: options.workspace,
			sessionFile: null, sessionId: null, status: "dormant",
		});
	}

	// --- shutdown --------------------------------------------------------------

	/** Stop every session in an orderly way and release the state directory. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		await Promise.all([...this.runtimes.values()].map((runtime) => runtime.proc.stop()));
		await this.server.close();
		this.store.close();
		try {
			unlinkSync(join(this.stateDir, "host.lock"));
		} catch {
			// Already gone.
		}
	}
}

function clean(name: string, fallback: string): string {
	return name.replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
}

/** The first prompt a spawned child receives. It comes from an agent, and says so. */
function briefPrompt(parent: NodeMeta, node: NodeMeta): string {
	return [
		`[pi-lattice] This session was created by another agent session, "${parent.name}" (${parent.id}), as its child "${node.name}" (kind: ${node.kind}).`,
		"The brief below is from that agent, not typed by the user. The user can see this session and may join it at any time; their instructions take priority.",
		node.branch ? `You are working in your own git worktree on branch ${node.branch}. Commit your work there.` : "",
		"",
		"Brief:",
		node.brief,
	].filter((line, index) => line !== "" || index >= 3).join("\n");
}
