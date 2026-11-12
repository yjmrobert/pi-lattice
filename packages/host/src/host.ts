/**
 * The lattice host: source of truth for the session tree. It creates nodes, runs each one
 * as a Pi child process, routes and journals every envelope between them, and surfaces
 * anything that needs a human (blocked dialogs, mail awaiting approval).
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	ancestorsOf,
	assignmentToEnv,
	type Channel,
	childrenOf,
	createEnvelope,
	type DialogInfo,
	depthOf,
	type Envelope,
	HOST_ENV,
	type HostAssignment,
	type InboundState,
	isHeld,
	isPlanned,
	isRelativeAddress,
	latticeHome,
	type Limits,
	limitsOf,
	newNodeId,
	parseSettings,
	repoConfigPath,
	renderTemplate,
	reportsTo,
	resolveSettings,
	rolesFor,
	SETTINGS,
	type Settings,
	type SettingsFile,
	type TemplateName,
	TEMPLATES,
	templatePaths,
	textSetting,
	toggleSetting,
	userConfigPath,
	type NodeMeta,
	type NodeStatus,
	type PeerInfo,
	type RequestMap,
	type RequestOp,
	type SpawnSpec,
	treeOf,
	type UiApi,
	type UiMethod,
	type UiState,
	validateEnvelope,
	WORKSPACE_MODES,
	waitingFor,
	roleOf,
	type WorkRequest,
	type WorkResult,
	type WorkSession,
	type WorkState,
} from "@pi-lattice/protocol";
import { piLibrary } from "./pi-library.ts";
import { type ExitInfo, PiProcess, type RpcRecord } from "./pi-process.ts";
import { type Connection, type Hello, SocketServer } from "./socket-server.ts";
import { type JournalRecord, SqliteStore, type Store } from "./store.ts";
import { createWorktree, repoName, worktreeSource } from "./workspace.ts";

export interface HostOptions {
	/** Directory for the database, sessions and child mailboxes. One host per directory. */
	stateDir: string;
	/** Who owns the nodes this host creates. Defaults to the OS user. */
	owner?: string;
	/** How to start Pi. Defaults to `LATTICE_PI_BIN`, else `pi` on PATH. */
	piCommand?: string[];
	/** Extra arguments for every session, for example a provider and model. */
	piArgs?: string[];
	/** Extension paths loaded into every headless session: normally the lattice messaging, roles and tree extensions. */
	extensionPaths?: string[];
	/** Extra environment for every session. */
	env?: Record<string, string>;
	/** Limits that hold whatever the settings say. */
	limits?: Partial<Limits>;
	/** Where the person's own settings and templates are kept. Defaults to their lattice home. */
	userDir?: string;
	/** Directory for the unix socket. Defaults to a private directory under XDG_RUNTIME_DIR or the temp dir. */
	socketDir?: string;
	/** Milliseconds to wait for a session to start and connect. */
	startTimeoutMs?: number;
}

/** A dialog a session is blocked on until a human answers. */
export type Dialog = DialogInfo;

/** What the host needs from sharing, when the tree is shared. Supplied by whoever composes host and collab. */
export interface SharingPort {
	/** Null while sharing is switched off. */
	state(): UiState["sharing"];
	/** Whether this person has said what name they go by, rather than being called after their OS user. */
	named(): boolean;
	/** Run a sharing action named by the pane and return text to show. */
	run(action: string, args: string[]): Promise<string>;
	/** A teammate's session's conversation, in this repository or another. */
	fetchMessages(nodeId: string): Promise<unknown[]>;
	/** The same, kept up to date by its owner for as long as this keeps being called. */
	follow(nodeId: string): Promise<unknown[]>;
	/** Call the listener whenever sharing state changes. */
	onChanged(listener: () => void): void;
}

/** The team's work on a server, as the host uses it. The host knows nothing of HTTP: this is supplied. */
export interface WorkPort {
	/** Null while this person has joined no server. */
	state(): WorkState | null;
	/** Read or change issues. `on` never comes here: which session is on what is the host's to keep. */
	run(request: WorkRequest): Promise<WorkResult>;
	/** A session was put on an issue, or reported its result. */
	session(number: number, event: "start" | "report"): Promise<void>;
	/** What this host runs, for the server to tell everyone. */
	publish(sessions: Array<Omit<WorkSession, "host" | "owner" | "repo">>): void;
	/** Join or leave a server, or say which one this is. Returns text to show. */
	server(action: string, args: string[]): Promise<string>;
	onChanged(listener: () => void): void;
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
	/** What a background node's agent is doing changed. */
	activity: [nodeId: string];
	/** A raw session event or UI request from a node's Pi process, numbered in stream order per process. */
	session: [nodeId: string, event: RpcRecord, seq: number];
	/** Everything but `info` is shown to the person in their terminal; `notice` is news, not a problem. */
	log: [level: "info" | "notice" | "warn" | "error", message: string];
}

interface Runtime {
	/** The headless Pi process. Absent when the node is open in a person's own terminal. */
	proc?: PiProcess;
	/** The `ui` connection that has this node open in the foreground. */
	foreground?: string;
	token: string;
	channels: Map<Channel, Connection>;
	dialogs: Map<string, Dialog>;
	streaming: boolean;
	/** A person stopped the agent, so the end of this turn is not the agent going quiet by itself. */
	interrupted?: boolean;
	/** Envelope ids sent on the current a2a connection and not yet acknowledged. */
	inflight: Set<string>;
	lastActive: number;
	/** The last few things the agent said and did, one line each, and when the latest happened. */
	recent: string[];
	recentAt: number;
	connected: Promise<void>;
	markConnected: () => void;
	failConnect: (error: Error) => void;
}

const RECENT_LINES = 12;
/** How long a message stays in what the interface is told has just been sent. */
const TRAFFIC_MS = 10_000;
/** How long a session is taken to still be on the item it last touched. */
const FOCUS_MS = 5 * 60_000;
/** How many planned items a tree may hold for each session it may run. Planned work costs nothing to keep, but a plan is still bounded. */
const PLANNED_PER_SESSION = 10;

/** What a session is started with: the tree's settings, then anything chosen for the session itself. */
export function sessionLaunch(node: Pick<NodeMeta, "model">, settings: Settings): { args: string[]; env: Record<string, string> } {
	const model = node.model ?? textSetting(settings, "model");
	const thinking = textSetting(settings, "thinking");
	// What the session's own extensions enforce reaches them through the environment, under the same names a person would use.
	const passed: Record<string, string> = {};
	for (const setting of SETTINGS) {
		const value = settings.values[setting.key];
		if (setting.env && SESSION_SETTINGS.has(setting.key) && settings.sources[setting.key] !== "default" && value !== undefined) passed[setting.env] = String(value);
	}
	return {
		args: [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])],
		env: { ...settings.env, ...passed },
	};
}

/** The settings a session's messaging extension enforces itself. */
const SESSION_SETTINGS = new Set(["approval", "limits.maxHops", "limits.maxSendsPerMinute", "limits.maxPayloadBytes"]);

const brief = (text: string, width = 200): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return [...line].length > width ? `${[...line].slice(0, width - 1).join("")}…` : line;
};

/** A tool call in one line: its name and the argument that says most. */
export function toolLine(name: string, args: unknown): string {
	const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
	const value = ["command", "path", "file_path", "name", "to", "pattern", "query", "url"].map((key) => record[key]).find((candidate) => typeof candidate === "string") ?? Object.values(record).find((candidate) => typeof candidate === "string");
	return brief(`→ ${name}${typeof value === "string" && value !== "" ? `: ${value}` : ""}`);
}

const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("") : "";

/** The end of a conversation, one line per thing said or done, oldest first. */
export function tailOf(messages: RpcRecord[], limit: number): string[] {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = brief(textOf(message.content));
			if (text) lines.push(`> ${text}`);
		} else if (message.role === "assistant") {
			const text = brief(textOf(message.content));
			if (text) lines.push(text);
			for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "toolCall") lines.push(toolLine(String(part.name ?? "tool"), part.arguments));
		}
	}
	return lines.slice(-limit);
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

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
	/** Where the person's own settings and templates are kept. */
	readonly userDir: string;
	readonly socketPath: string;
	private readonly options: HostOptions;
	private readonly store: Store;
	private readonly server: SocketServer;
	private readonly runtimes = new Map<string, Runtime>();
	private readonly starting = new Map<string, Promise<void>>();
	private readonly pinned = new Set<string>();
	private remoteRouter: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined;
	private readonly uiToken = randomBytes(24).toString("hex");
	private readonly uiClients = new Map<string, Connection>();
	/** Terminals that only watch this tree from another repository. They do not keep the host awake. */
	private readonly watchers = new Set<string>();
	/**
	 * Children that have been given work and have not answered their parent since. `reminded`
	 * says the child has already been told once that its parent is waiting.
	 */
	private readonly owing = new Map<string, { reminded: boolean }>();
	/** Sessions that waited on others and are being started right now. */
	private readonly releasing = new Map<string, Promise<void>>();
	/** Messages sent a moment ago, for an interface that shows them moving. */
	private recentTraffic: Array<{ from: string; to: string; intent: string; at: number }> = [];
	/** Per session, the item below it that it last placed, wrote to or heard from. */
	private readonly focus = new Map<string, { nodeId: string; at: number }>();
	/** Why a waiting session could not be started when its turn came, so it is said once and not at every retry. */
	private readonly releaseComplaints = new Map<string, string>();
	private sharing: SharingPort | undefined;
	private work: WorkPort | undefined;
	private publishTimer: NodeJS.Timeout | undefined;
	/** The name this person's sessions here were under until this start, when it changed. */
	readonly renamedFrom: string | undefined;
	private notifyTimer: NodeJS.Timeout | undefined;
	private stopped = false;

	/**
	 * A person who changed the name they go by still owns what they owned. The name this tree
	 * was last run under is kept beside it; where none was kept, it was the OS user name.
	 */
	private carryName(): string | undefined {
		const path = join(this.stateDir, "owner");
		let before: string;
		try {
			before = readFileSync(path, "utf8").trim() || userInfo().username;
		} catch {
			before = userInfo().username;
		}
		if (before !== this.owner) for (const node of this.store.listNodes()) if (node.owner === before) this.store.updateNode(node.id, { owner: this.owner });
		writeFileSync(path, this.owner);
		return before !== this.owner ? before : undefined;
	}

	private constructor(options: HostOptions) {
		super();
		this.options = options;
		this.stateDir = resolve(options.stateDir);
		this.owner = (options.owner ?? process.env[HOST_ENV.owner]) || userInfo().username;
		this.userDir = resolve(options.userDir ?? latticeHome(process.env, homedir()));
		mkdirSync(this.stateDir, { recursive: true });

		const socketDir = options.socketDir ?? join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `pi-lattice-${userInfo().uid}`);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });
		chmodSync(socketDir, 0o700);
		this.socketPath = join(socketDir, `${createHash("sha256").update(this.stateDir).digest("hex").slice(0, 16)}.sock`);

		this.store = new SqliteStore(join(this.stateDir, "host.db"));
		this.renamedFrom = this.carryName();
		this.server = new SocketServer(this.socketPath, {
			authenticate: (hello) => (hello.channel === "ui" ? hello.token === this.uiToken : this.runtimes.get(hello.nodeId)?.token === hello.token),
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
				if (connection.channel === "ui") {
					this.uiClients.delete(connection.id);
					this.watchers.delete(connection.id);
					// A terminal that goes away gives its nodes back.
					for (const [id, runtime] of this.runtimes) if (runtime.foreground === connection.id) this.detachForeground(id, connection.id);
					return;
				}
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
		// The state directory usually sits inside a checkout; keep it out of `git status` there.
		const ignore = join(resolve(options.stateDir), ".gitignore");
		if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
		const host = new LatticeHost(options);
		// Sessions die with the host that ran them, so nothing recorded as live is live now.
		for (const node of host.store.listNodes()) {
			if (node.status !== "dormant" && node.status !== "exited" && node.status !== "failed") host.store.updateNode(node.id, { status: "dormant" });
		}
		await host.server.listen();
		// A session whose wait ended as the host last stopped starts now.
		host.releaseReady();
		// A person's own Pi proves it is the same user by reading this file.
		writeFileSync(join(host.stateDir, "ui.token"), host.uiToken, { mode: 0o600 });
		chmodSync(join(host.stateDir, "ui.token"), 0o600);
		writeFileSync(join(host.stateDir, "host.json"), JSON.stringify({ socket: host.socketPath, pid: process.pid, owner: host.owner }));
		for (const name of ["node", "mail", "dialog", "envelope", "activity"] as const) host.on(name, () => host.notifyUi());
		host.on("log", (level, message) => {
			if (level === "info") return;
			for (const client of host.uiClients.values()) client.send({ t: "event", kind: "log", message });
		});
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

	/**
	 * The settings in effect: the environment, then this repository's file, then the person's own.
	 * Read again whenever a file changes, so a change needs no restart. A file that cannot be
	 * read is reported once and counts as empty.
	 */
	settings(): Settings {
		const paths = { user: userConfigPath(this.userDir), repo: repoConfigPath(this.stateDir) };
		const stamp = (path: string): string => {
			try {
				const stat = statSync(path);
				return `${stat.mtimeMs}:${stat.size}`;
			} catch {
				return "";
			}
		};
		const stamps = `${stamp(paths.user)}|${stamp(paths.repo)}`;
		if (this.settingsCache?.stamps === stamps) return this.settingsCache.settings;
		const complaints: string[] = [];
		const read = (path: string): SettingsFile | undefined => {
			if (!existsSync(path)) return undefined;
			try {
				const file = parseSettings(readFileSync(path, "utf8"));
				if (file.problems.length > 0) complaints.push(`Settings in ${path}: ${file.problems.join(" ")}`);
				return file;
			} catch (error) {
				complaints.push(`Settings in ${path} were ignored: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		};
		const settings = resolveSettings({ user: read(paths.user), repo: read(paths.repo), env: process.env });
		const said = complaints.join(" ");
		if (said && said !== this.settingsComplaint) this.emit("log", "warn", said);
		this.settingsComplaint = said;
		this.settingsCache = { stamps, settings };
		return settings;
	}

	private settingsCache: { stamps: string; settings: Settings } | undefined;
	/** The last problem reported about the settings, so it is said once and not at every session start. */
	private settingsComplaint = "";

	/**
	 * A text pi-lattice writes into a session, filled in. A person's own version of it, in this
	 * repository's templates folder or their own, is used in place of the built-in one.
	 */
	template(name: TemplateName, values: Record<string, string | undefined | null> = {}): string {
		let text: string = TEMPLATES[name].text;
		for (const { path } of templatePaths(name, { stateDir: this.stateDir, userDir: this.userDir })) {
			try {
				const own = readFileSync(path, "utf8");
				if (own.trim() === "") continue;
				text = own;
				break;
			} catch {
				// Not replaced there.
			}
		}
		return renderTemplate(text, values);
	}

	/** The limits in effect now. */
	get limits(): Limits {
		return { ...limitsOf(this.settings()), ...this.options.limits };
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
			fragments: rolesFor(this.settings(), "root", spec.fragments), cwd: resolve(spec.cwd), workspace: "shared", branch: null,
		});
		await this.ensureRunning(node.id);
		if (node.brief.trim() !== "") await this.prompt(node.id, node.brief);
		return this.must(node.id);
	}

	/** Create a child under a node, start it and hand it its brief. Enforces the tree limits. */
	async spawnChild(askerId: string, spec: SpawnSpec): Promise<NodeMeta> {
		const all = this.store.listNodes();
		const parentId = this.resolveUnder(all, askerId, spec.under);
		const parent = this.store.getNode(parentId);
		if (!parent) throw new Error(`No node ${parentId} in this tree.`);
		if (parent.owner !== this.owner) throw new Error(`"${parent.name}" is owned by ${parent.owner}. Children can only be added under sessions you own.`);
		const planned = spec.planned === true;
		// Without an issue of its own, a child is on the one its parent is on: it is there to help with it.
		const issue = spec.issue ?? parent.issue;
		if (spec.issue !== undefined && !this.work?.state()?.issues.some((entry) => entry.number === spec.issue)) {
			throw new Error(this.work?.state() ? `There is no issue #${spec.issue}.` : "There is no server, so there is no issue to put it on. Leave the issue out.");
		}
		if (typeof spec.name !== "string" || spec.name.trim() === "") throw new Error("A child session needs a name.");
		if (typeof spec.brief !== "string" || spec.brief.trim() === "") throw new Error("A child session needs a brief.");
		if (depthOf(all, parentId) + 1 > this.limits.maxDepth) {
			throw new Error(`Not spawned: the tree is limited to ${this.limits.maxDepth} levels below the root. Do this work in the current session, or ask the user to raise the limit.`);
		}
		if (childrenOf(all, parentId).length >= this.limits.maxChildren) {
			throw new Error(`Not spawned: this session already has ${this.limits.maxChildren} children, the limit. Reuse an existing child or ask the user to raise the limit.`);
		}
		// Planned work has no session, so it does not count against the number of sessions. It is still bounded.
		const tree = treeOf(all, parent.rootId);
		if (planned && tree.filter(isPlanned).length >= this.limits.maxNodes * PLANNED_PER_SESSION) {
			throw new Error(`Not planned: the tree already has ${this.limits.maxNodes * PLANNED_PER_SESSION} planned items, the limit. Start or archive some first.`);
		}
		if (!planned && tree.filter((node) => !isPlanned(node)).length >= this.limits.maxNodes) {
			throw new Error(`Not spawned: the tree already has ${this.limits.maxNodes} sessions, the limit. Ask the user before growing it further.`);
		}
		const workspace = spec.workspace ?? "shared";
		if (!(WORKSPACE_MODES as readonly string[]).includes(workspace)) throw new Error(`Unknown workspace "${workspace}". Use shared or worktree.`);
		const chosen = (spec.fragments ?? []).filter((name) => typeof name === "string" && name.trim() !== "").map((name) => name.trim());
		// Every child is told how to talk to the tree and how to answer its parent, whatever else it was given.
		const fragments = rolesFor(this.settings(), "child", chosen);
		const model = typeof spec.model === "string" && spec.model.trim() !== "" ? spec.model.trim() : undefined;
		const waitsOn = this.resolveWaitsOn(all, parent, spec.waitsOn);
		const held = planned || waitsOn.some((other) => !other.done);

		const id = newNodeId();
		const name = clean(spec.name, id);
		let cwd = parent.cwd;
		let branch: string | null = null;
		if (workspace === "worktree") {
			if (held) {
				// Its worktree is made when it starts, from what is checked out then: the work it waits on may be there by that time.
				worktreeSource(parent.cwd);
			} else {
				const worktree = createWorktree(parent.cwd, id, name);
				cwd = worktree.cwd;
				branch = worktree.branch;
			}
		}
		const node = this.insert({
			id, parentId, rootId: parent.rootId, kind: (spec.kind ?? "task").trim() || "task", name, brief: spec.brief, fragments, cwd, workspace, branch,
			...(model ? { model } : {}),
			...(waitsOn.some((other) => !other.done) ? { waitsOn: waitsOn.map((other) => other.id) } : {}),
			...(planned ? { planned: true } : {}),
			...(issue !== undefined ? { issue } : {}),
		});
		this.touch(askerId, node.id);
		if (held) return node;
		try {
			await this.giveBrief(node, waitsOn.map((other) => other.name));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`The child "${name}" (${id}) was created but could not be started: ${message}`);
		}
		return this.must(node.id);
	}

	/** Note that a session has just worked on an item below it. Anything else is not a focus: a worker writing to its parent is still on its own task. */
	private touch(sessionId: string, itemId: string, all: NodeMeta[] = this.store.listNodes()): void {
		if (sessionId === itemId || !ancestorsOf(all, itemId).some((above) => above.id === sessionId)) return;
		this.focus.set(sessionId, { nodeId: itemId, at: Date.now() });
	}

	/** Start a child and hand it its brief. `waited` names the sessions it was kept back for, when they have all finished. */
	private async giveBrief(node: NodeMeta, waited: string[] = []): Promise<void> {
		const parent = reportsTo(this.store.listNodes(), node);
		// It owes its parent an answer from the moment it has the brief.
		this.owing.set(node.id, { reminded: false });
		void this.noteWork(node.issue, "start");
		await this.ensureRunning(node.id);
		await this.prompt(node.id, this.template("brief", {
			"parent.name": parent?.name ?? "", "parent.id": parent?.id ?? "", name: node.name, kind: node.kind, branch: node.branch, waited: waited.map((name) => `"${name}"`).join(", "), brief: node.brief,
		}));
	}

	/**
	 * Where a new item goes: under the session asking, or under the item it names, which must be
	 * the asker or something below it.
	 */
	private resolveUnder(all: NodeMeta[], askerId: string, under: unknown): string {
		if (under === undefined || under === null || under === "") return askerId;
		if (typeof under !== "string") throw new Error("Not created: under is the id or the name of an item below this session.");
		const wanted = under.trim();
		const below = all.filter((node) => !node.archived && (node.id === askerId || ancestorsOf(all, node.id).some((above) => above.id === askerId)));
		const named = below.filter((node) => node.name.toLowerCase() === wanted.toLowerCase());
		const found = below.find((node) => node.id === wanted) ?? (named.length === 1 ? named[0] : undefined);
		if (found) return found.id;
		if (named.length > 1) throw new Error(`Not created: ${named.length} items below this session are named "${wanted}" (${named.map((node) => node.id).join(", ")}). Say which by id.`);
		throw new Error(`Not created: there is no item "${wanted}" below this session to put it under. Use list_sessions to see the tree.`);
	}

	// --- sessions that wait on others ------------------------------------------

	/**
	 * The sessions a new child of `parent` is to wait on, from the ids or names it was given.
	 * A name must be the only one of its kind in the tree. Nothing above the child can be waited
	 * on, because a parent finishes after its children; nor can a teammate's session, whose
	 * result this host does not see.
	 */
	private resolveWaitsOn(all: NodeMeta[], parent: NodeMeta, given: unknown): NodeMeta[] {
		if (given === undefined || given === null) return [];
		if (!Array.isArray(given) || given.some((entry) => typeof entry !== "string")) throw new Error("Not spawned: waits_on is a list of session ids or names.");
		const tree = treeOf(all, parent.rootId).filter((node) => !node.archived);
		const above = new Set([parent.id, ...ancestorsOf(all, parent.id).map((node) => node.id)]);
		const out: NodeMeta[] = [];
		for (const entry of given as string[]) {
			const wanted = entry.trim();
			if (wanted === "") continue;
			const named = tree.filter((node) => node.name.toLowerCase() === wanted.toLowerCase());
			const found = tree.find((node) => node.id === wanted) ?? (named.length === 1 ? named[0] : undefined);
			if (!found) {
				if (named.length > 1) throw new Error(`Not spawned: ${named.length} sessions are named "${wanted}" (${named.map((node) => node.id).join(", ")}). Say which to wait on by id.`);
				throw new Error(`Not spawned: there is no session "${wanted}" in this tree to wait on. Use list_sessions to see the tree.`);
			}
			if (above.has(found.id)) throw new Error(`Not spawned: "${found.name}" is above the new session in the tree, and finishes only after its children. Wait on a session beside it instead.`);
			if (found.owner !== this.owner) throw new Error(`Not spawned: "${found.name}" belongs to ${found.owner}. Only sessions you run can be waited on.`);
			if (!out.includes(found)) out.push(found);
		}
		return out;
	}

	/** Start every waiting session whose wait is over. Called whenever a session finishes, and whenever room may have been freed. */
	private releaseReady(): void {
		if (this.stopped) return;
		const all = this.store.listNodes();
		for (const node of all) {
			// Planned work is started by someone, never by the host.
			if (!isHeld(node) || isPlanned(node) || node.archived || node.owner !== this.owner || waitingFor(all, node).length > 0) continue;
			this.release(node.id).catch(() => {
				// Said by release; the next freed slot retries.
			});
		}
	}

	/**
	 * Give a waiting session its brief: because what it waited on has finished, or, with
	 * `early`, because a person or another session wants it started without that.
	 */
	private release(id: string, early = false): Promise<void> {
		const inFlight = this.releasing.get(id);
		if (inFlight) return inFlight;
		const run = async (): Promise<void> => {
			let node = this.must(id);
			if (!isHeld(node)) return;
			const all = this.store.listNodes();
			const waited = early && waitingFor(all, node).length > 0 ? [] : (node.waitsOn ?? []).flatMap((other) => all.find((candidate) => candidate.id === other)?.name ?? []);
			try {
				if (isPlanned(node) && treeOf(all, node.rootId).filter((other) => !isPlanned(other)).length >= this.limits.maxNodes) {
					throw new Error(`the tree already has ${this.limits.maxNodes} sessions, the limit`);
				}
				if (node.workspace === "worktree" && !node.branch) {
					const from = (node.parentId ? this.store.getNode(node.parentId)?.cwd : undefined) ?? node.cwd;
					const worktree = createWorktree(from, node.id, node.name);
					node = this.update(id, { cwd: worktree.cwd, branch: worktree.branch });
				}
				await this.giveBrief(node, waited);
				this.update(id, { waitsOn: [], planned: false });
				this.releaseComplaints.delete(id);
			} catch (error) {
				this.owing.delete(id);
				const message = error instanceof Error ? error.message : String(error);
				if (this.releaseComplaints.get(id) !== message) this.emit("log", "warn", `"${node.name}" was due to start, and could not be: ${message}`);
				this.releaseComplaints.set(id, message);
				throw error;
			}
		};
		// Mail that came for it meanwhile, such as the message that started it, follows the brief.
		const started = run().finally(() => {
			this.releasing.delete(id);
			this.flush(id);
		});
		this.releasing.set(id, started);
		return started;
	}

	/** Start a waiting session now, on a person's say-so. */
	async startHeld(id: string): Promise<void> {
		const node = this.must(id);
		if (node.owner !== this.owner) throw new Error(`"${node.name}" is owned by ${node.owner}. Only they can start it.`);
		if (!isHeld(node)) throw new Error(`"${node.name}" has already started: it is not waiting on anything.`);
		await this.release(id, true);
	}

	/** Start a session because it has mail. One that was waiting on others gets its brief with it. */
	private wake(id: string): Promise<void> {
		const node = this.store.getNode(id);
		return node && isHeld(node) ? this.release(id, true) : this.ensureRunning(id);
	}

	private insert(fields: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "cwd" | "workspace" | "branch"> & Pick<Partial<NodeMeta>, "model" | "waitsOn" | "planned" | "issue">): NodeMeta {
		const now = new Date().toISOString();
		const node: NodeMeta = {
			...fields, owner: this.owner, version: 1, status: "dormant", sessionId: null, sessionFile: null, createdAt: now, updatedAt: now, repo: repoName(fields.cwd),
		};
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
		const launch = sessionLaunch(node, this.settings());
		const args = [
			...(this.options.piArgs ?? []),
			...launch.args,
			...(this.options.extensionPaths ?? []).flatMap((path) => ["-e", path]),
			"--session-dir", sessionDir,
		];
		if (node.sessionFile && existsSync(node.sessionFile)) args.push("--session", node.sessionFile);
		else if (existsSync(this.adoptPath(id))) args.push("--fork", this.adoptPath(id), "--name", node.name);
		else args.push("--name", node.name);

		const proc = new PiProcess({
			command: this.options.piCommand ?? (process.env.LATTICE_PI_BIN ? [process.env.LATTICE_PI_BIN] : ["pi"]),
			args,
			cwd: existsSync(node.cwd) ? node.cwd : process.cwd(),
			// LATTICE_HEADLESS tells the pane extension it is inside a host-run session and must stay out of the way.
			env: { ...process.env, ...this.options.env, ...launch.env, ...assignmentToEnv(this.assignment(node, token)), LATTICE_HEADLESS: "1" },
		});
		let markConnected!: () => void;
		let failConnect!: (error: Error) => void;
		const connected = new Promise<void>((resolveConnected, rejectConnected) => {
			markConnected = resolveConnected;
			failConnect = rejectConnected;
		});
		connected.catch(() => {});
		const runtime: Runtime = {
			proc, token, channels: new Map(), dialogs: new Map(), streaming: false, inflight: new Set(), lastActive: Date.now(), recent: [], recentAt: 0, connected, markConnected, failConnect,
		};
		this.runtimes.set(id, runtime);
		this.update(id, { status: "starting" });

		proc.on("event", (event: RpcRecord, seq: number) => this.onSessionEvent(id, runtime, event, seq));
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

	/** What a session needs to speak as a node, whether the host starts it or a person opens it. */
	private assignment(node: NodeMeta, token: string): HostAssignment {
		return {
			socket: this.socketPath, token, nodeId: node.id, parentId: node.parentId, rootId: node.rootId, kind: node.kind, name: node.name,
			fragments: node.fragments, owner: node.owner, home: join(this.stateDir, "home"),
		};
	}

	/** Enforce the cap on running sessions by putting the least recently active idle one to sleep. */
	private async makeRoom(forId: string): Promise<void> {
		const headless = (): number => [...this.runtimes.values()].filter((runtime) => runtime.proc).length;
		while (headless() >= this.limits.maxRunning) {
			const idle = [...this.runtimes.entries()]
				.filter(([id, runtime]) => runtime.proc && id !== forId && !this.pinned.has(id) && !runtime.streaming && runtime.dialogs.size === 0 && this.store.unacked(id).length === 0)
				.sort(([, a], [, b]) => a.lastActive - b.lastActive)[0];
			if (!idle) {
				throw new Error(`${this.limits.maxRunning} sessions are already running and none is idle. Wait for one to finish, or raise the limit.`);
			}
			await this.sleep(idle[0]);
		}
	}

	/** Stop a node's process. The node stays in the tree as dormant and resumes on demand. */
	async sleep(id: string): Promise<void> {
		await this.runtimes.get(id)?.proc?.stop();
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

	private onSessionEvent(id: string, runtime: Runtime, event: RpcRecord, seq: number): void {
		runtime.lastActive = Date.now();
		if (event.type === "agent_start") {
			runtime.streaming = true;
			this.refresh(id, runtime);
		} else if (event.type === "agent_settled") {
			runtime.streaming = false;
			this.refresh(id, runtime);
			this.wakeQueued();
			this.afterTurn(id, runtime);
		} else if (event.type === "extension_ui_request" && DIALOG_METHODS.has(event.method)) {
			const dialog: Dialog = { id: String(event.id), method: event.method, title: String(event.title ?? "") };
			if (typeof event.message === "string") dialog.message = event.message;
			if (Array.isArray(event.options)) dialog.options = event.options.map(String);
			if (typeof event.placeholder === "string") dialog.placeholder = event.placeholder;
			if (typeof event.prefill === "string") dialog.prefill = event.prefill;
			runtime.dialogs.set(dialog.id, dialog);
			this.refresh(id, runtime);
			this.emit("dialog", id);
		} else if (event.type === "tool_execution_start") {
			this.note(id, runtime, toolLine(String(event.toolName ?? "tool"), event.args));
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = brief(textOf(event.message.content));
			if (text) this.note(id, runtime, text);
			const usage = event.message.usage as { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined;
			if (usage) this.addUsage(id, usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0), usage.cost?.total ?? 0);
		}
		this.emit("session", id, event, seq);
	}

	/** Record the latest thing a node's agent said or did. */
	private note(id: string, runtime: Runtime, line: string): void {
		runtime.recent.push(line);
		if (runtime.recent.length > RECENT_LINES) runtime.recent.shift();
		runtime.recentAt = Date.now();
		this.emit("activity", id);
	}

	/** Add to the running total of what a node's agent has used. */
	addUsage(id: string, tokens: number, cost: number): void {
		if (!(tokens > 0) && !(cost > 0)) return;
		this.store.addUsage(id, Number.isFinite(tokens) ? tokens : 0, Number.isFinite(cost) ? cost : 0);
		this.emit("activity", id);
	}

	private onExit(id: string, runtime: Runtime, info: ExitInfo): void {
		if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
		for (const connection of runtime.channels.values()) connection.close();
		const detail = info.error ?? runtime.proc?.stderrTail.trim().slice(-400) ?? "";
		runtime.failConnect(new Error(`Pi exited before the session connected${detail ? `: ${detail}` : "."}`));
		const hadDialogs = runtime.dialogs.size > 0;
		runtime.dialogs.clear();
		if (hadDialogs) this.emit("dialog", id);
		if (!this.store.getNode(id)) return;
		if (runtime.proc?.stopRequested) {
			this.update(id, { status: "dormant" });
		} else if (info.code === 0) {
			this.update(id, { status: "exited" });
			this.tellParent(id, "its session ended", runtime);
		} else {
			this.update(id, { status: "failed" });
			this.emit("log", "error", `Session ${id} exited unexpectedly (code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""}). ${detail}`);
			this.tellParent(id, `its process failed (exit code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""})`, runtime, detail, true);
		}
		this.wakeQueued();
	}

	// --- children that go quiet --------------------------------------------------

	/**
	 * A background child's turn has ended. If it still owes its parent an answer and is not
	 * waiting on anything itself, remind it once; if it ends another turn the same way, tell
	 * its parent, which would otherwise wait for ever.
	 */
	private afterTurn(id: string, runtime: Runtime): void {
		if (runtime.interrupted) {
			runtime.interrupted = false;
			return;
		}
		const owed = this.owing.get(id);
		const node = this.store.getNode(id);
		if (!owed || !node?.parentId || this.stopped || !runtime.proc || this.runtimes.get(id) !== runtime) return;
		if (!toggleSetting(this.settings(), "reports.remind")) return;
		// It may be waiting itself: on a person, on mail not yet delivered, or on its own children.
		if (runtime.dialogs.size > 0 || this.store.unacked(id).length > 0) return;
		const waitingOn = childrenOf(this.store.listNodes(), id).some((kid) => this.owing.has(kid.id) || (isHeld(kid) && !isPlanned(kid)) || kid.status === "running" || kid.status === "starting" || kid.status === "blocked");
		if (waitingOn) return;
		if (!owed.reminded) {
			owed.reminded = true;
			const parent = reportsTo(this.store.listNodes(), node);
			this.prompt(id, this.template("reminder", { "parent.name": parent?.name ?? node.parentId })).catch(() => {
				// It could not be reminded; its parent hears about it at the next turn end or exit.
			});
			return;
		}
		this.tellParent(id, "it ended its turn twice without sending a report", runtime);
	}

	/**
	 * Tell a child's parent that the child stopped without answering it. A child that owes
	 * nothing is passed over, unless it crashed before ever reporting.
	 */
	private tellParent(id: string, reason: string, runtime: Runtime, detail = "", crashed = false): void {
		const node = this.store.getNode(id);
		const owed = this.owing.delete(id);
		if (!node?.parentId || this.stopped) return;
		if (!owed && (!crashed || node.done)) return;
		const last = detail || runtime.recent.filter((line) => !line.startsWith("→ ")).at(-1) || "";
		const held = this.store.listNodes().filter((other) => !other.archived && other.waitsOn?.includes(id)).map((other) => `"${other.name}" (${other.id})`).join(", ");
		try {
			this.route(node, createEnvelope({
				from: node.id, fromOwner: node.owner, fromName: node.name, to: "parent", intent: "stopped", seq: 1,
				text: this.template("child-stopped", { name: node.name, id: node.id, reason, last, held }),
			}));
		} catch (error) {
			this.emit("log", "warn", `"${node.name}" stopped without reporting, and its parent could not be told: ${error instanceof Error ? error.message : String(error)}`);
		}
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
			this.wake(id).catch(() => {
				// Still no room; the next freed slot retries.
			});
		}
		this.releaseReady();
	}

	// --- foreground: nodes open in a person's own Pi ----------------------------

	private foregroundRuntime(clientId: string): Runtime {
		let markConnected!: () => void;
		let failConnect!: (error: Error) => void;
		const connected = new Promise<void>((resolveConnected, rejectConnected) => {
			markConnected = resolveConnected;
			failConnect = rejectConnected;
		});
		connected.catch(() => {});
		return {
			foreground: clientId, token: randomBytes(24).toString("hex"), channels: new Map(), dialogs: new Map(), streaming: false, inflight: new Set(),
			lastActive: Date.now(), recent: [], recentAt: 0, connected, markConnected, failConnect,
		};
	}

	/**
	 * Hand a node to a person's terminal. A headless copy is stopped first, because one
	 * session file can only be driven by one process. Returns what that terminal needs to
	 * open the session and speak as the node.
	 */
	async attachForeground(id: string, clientId: string): Promise<{ node: NodeMeta; sessionFile: string; assignment: HostAssignment; wasWorking: boolean }> {
		let node = this.must(id);
		if (node.owner !== this.owner) throw new Error(`"${node.name}" is owned by ${node.owner} and runs on their machine.`);
		if (isPlanned(node)) throw new Error(`"${node.name}" is planned and nobody is on it yet. To put a session on it, press s on it in the pane or run /lattice start.`);
		if (isHeld(node)) {
			const names = waitingFor(this.store.listNodes(), node).map((other) => `"${other.name}"`).join(", ");
			throw new Error(`"${node.name}" has not started: it waits on ${names || "sessions that have finished, and starts in a moment"}. To start it now, press s on it in the pane or run /lattice start.`);
		}
		await this.starting.get(id)?.catch(() => {});
		let runtime = this.runtimes.get(id);
		if (runtime?.foreground && runtime.foreground !== clientId) throw new Error(`"${node.name}" is already open in another terminal.`);
		let wasWorking = false;
		if (runtime?.proc) {
			wasWorking = runtime.streaming;
			runtime.interrupted = true;
			await runtime.proc.request({ type: "abort" }).catch(() => {});
			await runtime.proc.stop();
			runtime = undefined;
		}
		node = this.must(id);
		if (!node.sessionFile || !existsSync(node.sessionFile)) {
			// The node has never run here (new, or just taken over from a peer): run it once so its session exists.
			await this.ensureRunning(id);
			await this.sleep(id);
			node = this.must(id);
			if (!node.sessionFile) throw new Error(`"${node.name}" has no session to open yet.`);
		}
		if (!runtime) {
			runtime = this.foregroundRuntime(clientId);
			this.runtimes.set(id, runtime);
			this.update(id, { status: "starting" });
		}
		return { node: this.must(id), sessionFile: node.sessionFile, assignment: this.assignment(node, runtime.token), wasWorking };
	}

	/**
	 * A terminal gives a node back. Normally it sleeps until it has mail. With `resume`, its
	 * agent was mid-turn when the person left, so the host runs it headless at once and tells
	 * it to carry on: switching away from a working session does not stop the work.
	 */
	detachForeground(id: string, clientId: string, resume = false): void {
		const runtime = this.runtimes.get(id);
		if (!runtime || runtime.foreground !== clientId) return;
		this.runtimes.delete(id);
		for (const connection of runtime.channels.values()) connection.close();
		if (this.store.getNode(id)) this.update(id, { status: "dormant" });
		if (resume && this.store.getNode(id) && !this.stopped) {
			this.ensureRunning(id)
				.then(() => this.prompt(id, this.template("handover")))
				.catch((error: unknown) => {
					this.emit("log", "warn", `"${this.store.getNode(id)?.name ?? id}" could not carry on in the background: ${error instanceof Error ? error.message : String(error)}`);
				});
		}
		this.wakeQueued();
	}

	/** Make a session that is already open in a person's terminal the root of a new tree. */
	adoptSession(spec: UiApi["adopt"]["params"], clientId: string): { node: NodeMeta; assignment: HostAssignment } {
		const id = newNodeId();
		const now = new Date().toISOString();
		const cwd = resolve(spec.cwd);
		const node: NodeMeta = {
			id, parentId: null, rootId: id, kind: spec.kind?.trim() || "session", name: clean(spec.name, id), brief: "", fragments: rolesFor(this.settings(), "root", spec.fragments), owner: this.owner, version: 1,
			status: "starting", sessionId: spec.sessionId, sessionFile: spec.sessionFile, cwd, workspace: "shared", branch: null, createdAt: now, updatedAt: now, repo: repoName(cwd),
		};
		this.store.insertNode(node);
		const runtime = this.foregroundRuntime(clientId);
		this.runtimes.set(id, runtime);
		this.emit("node", node);
		return { node, assignment: this.assignment(node, runtime.token) };
	}

	/** Supply sharing, so the pane can show people and run handoffs. */
	setSharing(sharing: SharingPort | undefined): void {
		this.sharing = sharing;
		sharing?.onChanged(() => this.notifyUi());
	}

	/** Supply the team's work, so sessions can be put on issues and the canopy can draw them. */
	setWork(work: WorkPort | undefined): void {
		this.work = work;
		work?.onChanged(() => {
			this.notifyUi();
			this.publishSoon();
		});
		for (const event of ["node", "activity", "dialog"] as const) this.on(event, () => this.publishSoon());
		this.publishSoon();
	}

	/** The sessions of this person here that the team should see: the ones that are live, and the ones on an issue. */
	workSessions(): Array<Omit<WorkSession, "host" | "owner" | "repo">> {
		const pending = new Map<string, number>();
		for (const record of this.pendingMail()) pending.set(record.recipient, (pending.get(record.recipient) ?? 0) + 1);
		const out: Array<Omit<WorkSession, "host" | "owner" | "repo">> = [];
		for (const node of this.store.listNodes()) {
			if (node.archived || node.owner !== this.owner || isPlanned(node)) continue;
			const runtime = this.runtimes.get(node.id);
			const live = runtime !== undefined && (runtime.proc !== undefined || runtime.foreground);
			if (!live && node.issue === undefined) continue;
			const asks = (runtime?.dialogs.size ?? 0) + (pending.get(node.id) ?? 0);
			const state = node.status === "failed" ? "failed" : asks > 0 || node.status === "blocked" ? "asking" : isHeld(node) ? "waiting" : node.status === "running" || node.status === "starting" ? "working" : "idle";
			const activity = runtime?.proc ? runtime.recent[runtime.recent.length - 1] : undefined;
			out.push({ id: node.id, name: node.name, role: roleOf(node), state, ...(node.issue !== undefined ? { issue: node.issue } : {}), ...(activity ? { activity } : {}), asks });
		}
		return out;
	}

	private publishSoon(): void {
		if (this.publishTimer || this.stopped || !this.work?.state()) return;
		this.publishTimer = setTimeout(() => {
			this.publishTimer = undefined;
			if (!this.stopped) this.work?.publish(this.workSessions());
		}, 300);
		this.publishTimer.unref();
	}

	/** Read or change the team's work. `asker` is the session asking, when one is. */
	async runWork(request: WorkRequest, asker?: string): Promise<WorkResult> {
		const state = this.work?.state();
		if (!this.work || !state) throw new Error("There is no server: you have not joined one. Start a board on this machine with /lattice server start, or join your team's with /lattice server <address>.");
		if (request.do === "look") return { work: state };
		if (request.do === "next") {
			const taker = asker ? this.must(asker) : undefined;
			if (!taker) throw new Error("Only a session takes the next issue.");
			const taken = await this.work.run(request);
			// The server has started it already: the session is put on it, and nothing more is said.
			if (taken.issue && taker.issue !== taken.issue.number) this.update(taker.id, { issue: taken.issue.number });
			return taken;
		}
		if (request.do !== "on") return this.work.run(request);
		const id = request.nodeId ?? asker;
		const node = id ? this.must(id) : undefined;
		if (!node) throw new Error("Say which session.");
		if (node.owner !== this.owner) throw new Error(`"${node.name}" is owned by ${node.owner}. Only they can say what it is on.`);
		if (request.number === null) {
			this.update(node.id, { issue: 0 });
			return {};
		}
		const issue = state.issues.find((entry) => entry.number === request.number);
		if (!issue) throw new Error(`There is no issue #${request.number}.`);
		if (node.issue !== issue.number) this.update(node.id, { issue: issue.number });
		if (!isPlanned(node)) await this.noteWork(issue.number, "start");
		return { issue: this.work.state()?.issues.find((entry) => entry.number === issue.number) ?? issue };
	}

	/** Tell the server what a session did to its issue. The server being away never stops the session's own work. */
	private async noteWork(number: number | undefined, event: "start" | "report"): Promise<void> {
		if (number === undefined || !this.work?.state()) return;
		await this.work.session(number, event).catch((error: unknown) => this.emit("log", "warn", `Issue #${number} was not updated: ${error instanceof Error ? error.message : String(error)}`));
	}

	/** Run a sharing action by name, as the pane does. */
	async runSharing(action: string, args: string[]): Promise<string> {
		if (!this.sharing) throw new Error("Sharing is not available in this host.");
		return this.sharing.run(action, args);
	}

	/** How busy the host is, for deciding when a background host may exit. */
	activity(): { terminals: number; working: number } {
		return { terminals: [...this.uiClients.keys()].filter((id) => !this.watchers.has(id)).length, working: [...this.runtimes.values()].filter((runtime) => runtime.proc && (runtime.streaming || runtime.dialogs.size > 0)).length };
	}

	/** Tell every connected terminal that what the pane shows has changed. Coalesced. */
	private notifyUi(): void {
		if (this.notifyTimer || this.stopped) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			for (const client of this.uiClients.values()) client.send({ t: "event", kind: "changed" });
		}, 40);
		this.notifyTimer.unref();
	}

	uiState(): UiState {
		const attention: UiState["attention"] = {};
		const bump = (id: string, key: "dialogs" | "pending", by: number): void => {
			const entry = attention[id] ?? { dialogs: 0, pending: 0 };
			entry[key] += by;
			attention[id] = entry;
		};
		for (const [id, runtime] of this.runtimes) if (runtime.dialogs.size > 0) bump(id, "dialogs", runtime.dialogs.size);
		for (const record of this.pendingMail()) bump(record.recipient, "pending", 1);
		const activity: NonNullable<UiState["activity"]> = {};
		for (const [id, runtime] of this.runtimes) {
			const text = runtime.recent[runtime.recent.length - 1];
			if (runtime.proc && text) activity[id] = { text, at: runtime.recentAt };
		}
		const now = Date.now();
		const traffic = this.recentTraffic.filter((entry) => now - entry.at < TRAFFIC_MS);
		const focus = Object.fromEntries([...this.focus].filter(([, entry]) => now - entry.at < FOCUS_MS));
		return {
			owner: this.owner,
			nodes: this.store.listNodes().filter((node) => !node.archived),
			attention,
			activity,
			...(traffic.length > 0 ? { traffic } : {}),
			...(Object.keys(focus).length > 0 ? { focus } : {}),
			foreground: [...this.runtimes].filter(([, runtime]) => runtime.foreground).map(([id]) => id),
			...(this.work?.state() ? { work: this.work.state() as WorkState } : {}),
			sharing: this.sharing?.state() ?? null,
			named: this.sharing?.named() ?? false,
		};
	}

	private async onUi<K extends UiMethod>(connection: Connection, method: K, params: UiApi[K]["params"]): Promise<UiApi[UiMethod]["result"]> {
		const p = params as never;
		const call = <M extends UiMethod>(_method: M): UiApi[M]["params"] => p;
		switch (method) {
			case "state":
				return this.uiState();
			case "attach":
				return this.attachForeground(call("attach").nodeId, connection.id);
			case "detach":
				this.detachForeground(call("detach").nodeId, connection.id, call("detach").resume === true);
				return {};
			case "adopt":
				return this.adoptSession(call("adopt"), connection.id);
			case "spawn":
				return { node: await this.spawnChild(call("spawn").parentId, call("spawn").spec) };
			case "status": {
				const { nodeId, streaming } = call("status");
				const runtime = this.runtimes.get(nodeId);
				if (runtime?.foreground === connection.id) {
					runtime.streaming = streaming;
					runtime.lastActive = Date.now();
					this.refresh(nodeId, runtime);
				}
				return {};
			}
			case "pendingMail":
				return { mail: this.pendingMail().map((record) => ({ nodeId: record.recipient, envelope: record.envelope })) };
			case "decideMail": {
				const { nodeId, envelopeId, action } = call("decideMail");
				await this.decideMail(nodeId, envelopeId, action);
				return {};
			}
			case "dialogs":
				return { dialogs: this.dialogs(call("dialogs").nodeId) };
			case "answerDialog": {
				const { nodeId, dialogId, answer } = call("answerDialog");
				this.answerDialog(nodeId, dialogId, answer);
				return {};
			}
			case "sleep":
				await this.sleep(call("sleep").nodeId);
				return {};
			case "messages": {
				// A session in a repository this host is not for is known only to sharing.
				const node = this.store.getNode(call("messages").nodeId);
				if (node?.owner === this.owner) return { messages: await this.readMessages(node.id) };
				if (!this.sharing) throw new Error(node ? `"${node.name}" belongs to ${node.owner}, and this tree is not being shared right now.` : `No node ${call("messages").nodeId} in this tree.`);
				return { messages: await this.sharing.fetchMessages(call("messages").nodeId) };
			}
			case "sharing":
				return { text: await this.runSharing(call("sharing").action, call("sharing").args) };
			case "work":
				return this.runWork(call("work").request);
			case "server": {
				if (!this.work) throw new Error("This host cannot join a server.");
				return { text: await this.work.server(call("server").action, call("server").args) };
			}
			case "rename": {
				const { nodeId, name } = call("rename");
				return { node: this.rename(nodeId, name) };
			}
			case "archive":
				return { count: await this.archive(call("archive").nodeId, call("archive").archived, connection.id) };
			case "archived":
				return { nodes: this.store.listNodes().filter((node) => node.archived) };
			case "interrupt":
				await this.interrupt(call("interrupt").nodeId);
				return {};
			case "start":
				await this.startHeld(call("start").nodeId);
				return {};
			case "tail":
				return { lines: await this.tail(call("tail").nodeId) };
			case "usage": {
				const { nodeId, tokens, cost } = call("usage");
				if (this.runtimes.get(nodeId)?.foreground === connection.id) this.addUsage(nodeId, Number(tokens), Number(cost));
				return {};
			}
			case "presence":
				if (call("presence").here) this.watchers.delete(connection.id);
				else this.watchers.add(connection.id);
				return {};
			case "shutdown":
				setTimeout(() => this.emit("log", "info", "shutdown requested"), 0);
				this.shutdownRequested = true;
				return {};
			default:
				throw new Error(`Unknown request "${String(method)}".`);
		}
	}

	/** Set when a terminal asked the host to stop. Whoever runs the host acts on it. */
	shutdownRequested = false;

	// --- human interaction -----------------------------------------------------

	/**
	 * Send human input to a node, starting it if needed. While the agent is working the
	 * input is queued: `steer` delivers it at the next step, `followUp` after it finishes.
	 */
	async prompt(id: string, message: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<void> {
		await this.ensureRunning(id);
		const proc = this.headless(id);
		const runtime = this.runtimes.get(id);
		const result = await proc.request<{ disposition?: string } | undefined>({ type: "prompt", message, streamingBehavior: whenBusy });
		// A run has been accepted; reflect it now instead of waiting for the agent_start event.
		if (result?.disposition === "started" && runtime && this.runtimes.get(id) === runtime) {
			runtime.streaming = true;
			this.refresh(id, runtime);
		}
	}

	/** Stop the agent's current work in a node. */
	async abort(id: string): Promise<void> {
		await this.runtimes.get(id)?.proc?.request({ type: "abort" });
	}

	/** Stop what a background node's agent is doing, on a person's say-so. */
	async interrupt(id: string): Promise<void> {
		const node = this.must(id);
		const runtime = this.runtimes.get(id);
		if (runtime && !runtime.proc) throw new Error(`"${node.name}" is open in a terminal. Stop it there.`);
		if (!runtime?.streaming) throw new Error(`"${node.name}" is not working.`);
		runtime.interrupted = true;
		await this.abort(id);
	}

	rename(id: string, name: string): NodeMeta {
		const node = this.must(id);
		if (node.owner !== this.owner) throw new Error(`"${node.name}" is owned by ${node.owner}. Only they can rename it.`);
		const next = clean(name, "");
		if (next === "") throw new Error("A session needs a name.");
		return next === node.name ? node : this.update(id, { name: next });
	}

	/**
	 * Hide a node and everything under it from the tree, or bring them back. Their sessions are
	 * stopped and kept; nothing is deleted. Returns how many nodes changed.
	 */
	async archive(id: string, archived: boolean, clientId?: string): Promise<number> {
		const node = this.must(id);
		if (node.owner !== this.owner) throw new Error(`"${node.name}" is owned by ${node.owner}. Only they can archive it.`);
		const all = this.store.listNodes();
		const subtree: NodeMeta[] = [];
		const collect = (parent: NodeMeta): void => {
			subtree.push(parent);
			for (const kid of childrenOf(all, parent.id)) collect(kid);
		};
		collect(node);
		if (archived) {
			const open = subtree.find((entry) => this.runtimes.get(entry.id)?.foreground !== undefined);
			if (open) throw new Error(`"${open.name}" is open in ${this.runtimes.get(open.id)?.foreground === clientId ? "this" : "a"} terminal. Leave it first, then archive.`);
			await Promise.all(subtree.map((entry) => this.sleep(entry.id)));
		}
		let count = 0;
		for (const entry of subtree) {
			if (entry.owner !== this.owner || Boolean(entry.archived) === archived) continue;
			this.update(entry.id, { archived });
			count++;
		}
		if (!archived) this.releaseReady();
		return count;
	}

	/** The last few things a node said and did. Reads its session file when it is not running, so looking never starts a process. */
	async tail(id: string, limit = 8): Promise<string[]> {
		const runtime = this.runtimes.get(id);
		if (runtime?.proc && runtime.recent.length > 0) return runtime.recent.slice(-limit);
		const node = this.store.getNode(id);
		// A teammate's session: its owner sends what is new while someone here is looking.
		if (node?.owner !== this.owner) return this.sharing ? tailOf((await this.sharing.follow(id).catch(() => [])) as RpcRecord[], limit) : [];
		return tailOf(await this.readMessages(id), limit);
	}

	/** The headless process of a node, or a clear error when it is not running or is open in a terminal. */
	private headless(id: string): PiProcess {
		const runtime = this.runtimes.get(id);
		if (!runtime) throw new Error(`Session ${id} is not running.`);
		if (!runtime.proc) throw new Error(`"${this.store.getNode(id)?.name ?? id}" is open in a terminal. Talk to it there.`);
		return runtime.proc;
	}

	/** Send any Pi RPC command to a running node, for example `get_messages` or `get_state`. */
	async rpc<T = unknown>(id: string, command: RpcRecord): Promise<T> {
		return this.headless(id).request<T>(command);
	}

	/**
	 * Like {@link rpc}, also reporting the sequence number of the last `session` event emitted
	 * before the response. Use it to combine a snapshot (such as `get_messages`) with the
	 * live event stream without losing or repeating anything.
	 */
	async rpcMarked<T = unknown>(id: string, command: RpcRecord): Promise<{ data: T; mark: number }> {
		return this.headless(id).requestMarked<T>(command);
	}

	/**
	 * A node's conversation as a list of messages. Asks the session when it is running;
	 * otherwise reads its session file, so looking never starts a process.
	 */
	async readMessages(id: string): Promise<RpcRecord[]> {
		const runtime = this.runtimes.get(id);
		if (runtime?.proc && runtime.channels.has("a2a")) {
			const { messages } = await runtime.proc.request<{ messages: RpcRecord[] }>({ type: "get_messages" });
			return messages;
		}
		const file = this.must(id).sessionFile;
		if (!file || !existsSync(file)) return [];
		const { buildSessionContext, parseSessionEntries } = await piLibrary();
		const entries = parseSessionEntries(readFileSync(file, "utf8")).filter((entry) => entry.type !== "session");
		return buildSessionContext(entries as never).messages as RpcRecord[];
	}

	/** Answer a dialog a node is blocked on. Nothing answers dialogs automatically. */
	answerDialog(id: string, dialogId: string, answer: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
		const runtime = this.runtimes.get(id);
		if (!runtime?.proc || !runtime.dialogs.has(dialogId)) throw new Error(`No open dialog ${dialogId} on session ${id}.`);
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
		if (connection.channel === "ui") {
			this.uiClients.set(connection.id, connection);
			return;
		}
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
		// A session being given its brief gets that first; its mail is pushed once it has it.
		if (this.releasing.has(nodeId)) return true;
		for (const envelope of this.store.unacked(nodeId)) {
			if (runtime.inflight.has(envelope.id)) continue;
			runtime.inflight.add(envelope.id);
			connection.send({ t: "deliver", envelope });
		}
		return true;
	}

	private async onRequest(connection: Connection, op: RequestOp, params: unknown): Promise<unknown> {
		if (connection.channel === "ui") {
			if (op !== "ui") throw new Error(`Unknown request "${String(op)}".`);
			const call = params as { method: UiMethod; params: unknown };
			return this.onUi(connection, call.method, call.params as never);
		}
		if (op === "ui") throw new Error("That request is only for a person's own terminal.");
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
			case "work":
				return (await this.runWork((params as RequestMap["work"]["params"]).request, self.id)) satisfies RequestMap["work"]["result"];
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
				// Planned items above it have nobody on them: the report goes to the nearest session above.
				const above = reportsTo(this.store.listNodes(), sender);
				if (!above) throw new Error("This session is the root of its tree and has no parent. Report to the user instead.");
				recipients = [above.id];
			} else if (envelope.to === "root") {
				if (sender.rootId === sender.id) throw new Error("This session is the root of its tree.");
				recipients = [sender.rootId];
			} else {
				const children = childrenOf(this.store.listNodes(), sender.id);
				if (children.length === 0) throw new Error("This session has no children to message.");
				// A child that is waiting on others has not started, and a message to all of them does not start it.
				recipients = children.filter((node) => !isHeld(node)).map((node) => node.id);
				if (recipients.length === 0) throw new Error("Every child of this session is waiting on other sessions and has not started. To start one without that, message it by id.");
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
		this.noteReport(sender, envelope, recipients);
		const local = recipients.filter((id) => !remote.some((node) => node.id === id));
		for (const recipient of local) this.store.journal(envelope, recipient);
		for (const node of remote) this.remoteRouter?.(envelope, node);
		this.noteTraffic(envelope, recipients);
		this.emit("envelope", envelope, recipients);
		for (const recipient of local) {
			if (!this.flush(recipient)) {
				// Dormant recipient: wake it. The mail is delivered when its session connects.
				this.wake(recipient).catch((error: unknown) => {
					this.emit("log", "warn", `Mail for ${recipient} is queued; the session could not be started: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
		}
		return { recipients };
	}

	/** Keep track of who owes whom an answer, and which sessions have finished what they were given. */
	private noteReport(sender: NodeMeta, envelope: Envelope, recipients: string[]): void {
		const all = this.store.listNodes();
		const above = reportsTo(all, sender);
		if (above && recipients.includes(above.id) && envelope.intent !== "stopped") {
			// Anything a child says to its parent is an answer of a kind; a result is the end of the work.
			this.owing.delete(sender.id);
			if (envelope.intent === "result" && !sender.done) {
				this.update(sender.id, { done: true });
				void this.noteWork(sender.issue, "report");
				this.releaseReady();
			}
		}
		for (const id of recipients) {
			const recipient = this.store.getNode(id);
			if (!recipient || reportsTo(all, recipient)?.id !== sender.id || recipient.owner !== this.owner) continue;
			// More work from its parent: it owes an answer again.
			this.owing.set(id, { reminded: false });
			if (recipient.done) this.update(id, { done: false });
		}
	}

	/** Keep who wrote to whom for a few seconds, and move the focus of whichever end is above the other. */
	private noteTraffic(envelope: Envelope, recipients: string[]): void {
		const at = Date.now();
		const all = this.store.listNodes();
		this.recentTraffic = this.recentTraffic.filter((entry) => at - entry.at < TRAFFIC_MS);
		for (const to of recipients) {
			this.recentTraffic.push({ from: envelope.from, to, intent: envelope.intent, at });
			this.touch(envelope.from, to, all);
			this.touch(to, envelope.from, all);
		}
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
	importRemoteNode(remote: Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "owner" | "version" | "status" | "workspace" | "branch" | "createdAt" | "repo">): void {
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
				...(remote.repo !== undefined ? { repo: remote.repo } : {}),
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
		this.noteTraffic(checked.envelope, [recipientId]);
		this.emit("envelope", checked.envelope, [recipientId]);
		if (!this.flush(recipientId)) {
			this.wake(recipientId).catch((error: unknown) => {
				this.emit("log", "warn", `Mail for ${recipientId} is queued; the session could not be started: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	}

	/** Whether a person has the node open in a terminal. */
	inUse(id: string): boolean {
		return this.runtimes.get(id)?.foreground !== undefined;
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
			sessionFile: null, sessionId: null, status: "dormant", repo: repoName(options.cwd),
		});
	}

	// --- shutdown --------------------------------------------------------------

	/** Stop every session in an orderly way and release the state directory. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.notifyTimer) clearTimeout(this.notifyTimer);
		await Promise.all([...this.runtimes.values()].map((runtime) => runtime.proc?.stop()));
		await this.server.close();
		this.store.close();
		for (const name of ["host.lock", "ui.token", "host.json"]) {
			try {
				unlinkSync(join(this.stateDir, name));
			} catch {
				// Already gone.
			}
		}
	}
}

function clean(name: string, fallback: string): string {
	return name.replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
}
