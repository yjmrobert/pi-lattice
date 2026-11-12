/** Durable host state: the tree and the envelope journal. One interface, one SQLite implementation (ADR 0008). */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Envelope, InboundState, NodeMeta } from "@pi-lattice/protocol";

export interface JournalRecord {
	envelope: Envelope;
	/** The node this copy was routed to. One envelope addressed to `children` has one record per child. */
	recipient: string;
	/** The recipient session has stored it. */
	acked: boolean;
	/** State in the recipient's mailbox, once it has reported one. */
	mailState: InboundState | null;
}

export interface Store {
	insertNode(node: NodeMeta): void;
	/** Apply a patch and return the updated node. Throws when the node does not exist. */
	updateNode(id: string, patch: Partial<Omit<NodeMeta, "id">>): NodeMeta;
	getNode(id: string): NodeMeta | undefined;
	listNodes(): NodeMeta[];
	/** Add to what a node's agent has used. Does not count as a change of state. */
	addUsage(id: string, tokens: number, cost: number): void;
	/** Record an envelope routed to a recipient. Idempotent per (envelope, recipient). */
	journal(envelope: Envelope, recipient: string): void;
	markAcked(envelopeId: string, recipient: string): void;
	/** Envelopes routed to a node that it has not yet acknowledged, oldest first. */
	unacked(recipient: string): Envelope[];
	/** Nodes that have mail they have not acknowledged. */
	recipientsWithUnacked(): string[];
	setMailState(envelopeId: string, recipient: string, state: InboundState): void;
	/** Journal records, newest first. */
	traffic(options?: { limit?: number; mailState?: InboundState; node?: string }): JournalRecord[];
	close(): void;
}

const MIGRATIONS: string[] = [
	`CREATE TABLE nodes (
		id TEXT PRIMARY KEY,
		parent_id TEXT,
		root_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		name TEXT NOT NULL,
		brief TEXT NOT NULL,
		fragments TEXT NOT NULL,
		owner TEXT NOT NULL,
		version INTEGER NOT NULL,
		status TEXT NOT NULL,
		session_id TEXT,
		session_file TEXT,
		cwd TEXT NOT NULL,
		workspace TEXT NOT NULL,
		branch TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE journal (
		envelope_id TEXT NOT NULL,
		recipient TEXT NOT NULL,
		sender TEXT NOT NULL,
		correlation_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		body TEXT NOT NULL,
		acked INTEGER NOT NULL DEFAULT 0,
		mail_state TEXT,
		PRIMARY KEY (envelope_id, recipient)
	);
	CREATE INDEX journal_recipient ON journal (recipient, acked);`,
	"ALTER TABLE nodes ADD COLUMN repo TEXT;",
	`ALTER TABLE nodes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE nodes ADD COLUMN model TEXT;
	ALTER TABLE nodes ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
	ALTER TABLE nodes ADD COLUMN cost REAL NOT NULL DEFAULT 0;`,
	"ALTER TABLE nodes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;",
	"ALTER TABLE nodes ADD COLUMN waits_on TEXT;",
	"ALTER TABLE nodes ADD COLUMN planned INTEGER NOT NULL DEFAULT 0;",
	"ALTER TABLE nodes ADD COLUMN issue INTEGER;",
];

type Row = Record<string, string | number | null>;

/** Nothing to wait on is stored as nothing, so a session that has started reads as one that never waited. */
const waitsOnColumn = (node: Pick<NodeMeta, "waitsOn">): string | null => (node.waitsOn && node.waitsOn.length > 0 ? JSON.stringify(node.waitsOn) : null);

const toNode = (row: Row): NodeMeta => ({
	id: row.id as string,
	parentId: row.parent_id as string | null,
	rootId: row.root_id as string,
	kind: row.kind as string,
	name: row.name as string,
	brief: row.brief as string,
	fragments: JSON.parse(row.fragments as string) as string[],
	owner: row.owner as string,
	version: row.version as number,
	status: row.status as NodeMeta["status"],
	sessionId: row.session_id as string | null,
	sessionFile: row.session_file as string | null,
	cwd: row.cwd as string,
	workspace: row.workspace as NodeMeta["workspace"],
	branch: row.branch as string | null,
	createdAt: row.created_at as string,
	updatedAt: row.updated_at as string,
	...(typeof row.repo === "string" ? { repo: row.repo } : {}),
	...(row.archived === 1 ? { archived: true } : {}),
	...(typeof row.model === "string" ? { model: row.model } : {}),
	...(row.done === 1 ? { done: true } : {}),
	...(typeof row.waits_on === "string" ? { waitsOn: JSON.parse(row.waits_on) as string[] } : {}),
	...(row.planned === 1 ? { planned: true } : {}),
	...(typeof row.issue === "number" ? { issue: row.issue } : {}),
	...((row.tokens as number) > 0 || (row.cost as number) > 0 ? { usage: { tokens: row.tokens as number, cost: row.cost as number } } : {}),
});

export class SqliteStore implements Store {
	private readonly db: DatabaseSync;

	/** `path` is a file path, or ":memory:" for tests. */
	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.migrate();
	}

	private migrate(): void {
		const current = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		for (let version = current; version < MIGRATIONS.length; version++) {
			this.db.exec("BEGIN");
			try {
				this.db.exec(MIGRATIONS[version] as string);
				this.db.exec(`PRAGMA user_version = ${version + 1}`);
				this.db.exec("COMMIT");
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		}
	}

	insertNode(node: NodeMeta): void {
		this.db
			.prepare(
				`INSERT INTO nodes (id, parent_id, root_id, kind, name, brief, fragments, owner, version, status, session_id, session_file, cwd, workspace, branch, created_at, updated_at, repo, archived, model, tokens, cost, done, waits_on, planned, issue)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				node.id, node.parentId, node.rootId, node.kind, node.name, node.brief, JSON.stringify(node.fragments), node.owner, node.version,
				node.status, node.sessionId, node.sessionFile, node.cwd, node.workspace, node.branch, node.createdAt, node.updatedAt, node.repo ?? null,
				node.archived ? 1 : 0, node.model ?? null, node.usage?.tokens ?? 0, node.usage?.cost ?? 0, node.done ? 1 : 0, waitsOnColumn(node), node.planned ? 1 : 0, node.issue ?? null,
			);
	}

	updateNode(id: string, patch: Partial<Omit<NodeMeta, "id">>): NodeMeta {
		const current = this.getNode(id);
		if (!current) throw new Error(`no node ${id}`);
		const next: NodeMeta = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
		if (!next.waitsOn || next.waitsOn.length === 0) delete next.waitsOn;
		if (!next.planned) delete next.planned;
		// No issue is stored as nothing; 0 is how a patch takes a session off its issue.
		if (!next.issue) delete next.issue;
		this.db
			.prepare(
				`UPDATE nodes SET parent_id = ?, root_id = ?, kind = ?, name = ?, brief = ?, fragments = ?, owner = ?, version = ?, status = ?,
				 session_id = ?, session_file = ?, cwd = ?, workspace = ?, branch = ?, updated_at = ?, repo = ?,
				 archived = ?, model = ?, tokens = ?, cost = ?, done = ?, waits_on = ?, planned = ?, issue = ? WHERE id = ?`,
			)
			.run(
				next.parentId, next.rootId, next.kind, next.name, next.brief, JSON.stringify(next.fragments), next.owner, next.version, next.status,
				next.sessionId, next.sessionFile, next.cwd, next.workspace, next.branch, next.updatedAt, next.repo ?? null,
				next.archived ? 1 : 0, next.model ?? null, next.usage?.tokens ?? 0, next.usage?.cost ?? 0, next.done ? 1 : 0, waitsOnColumn(next), next.planned ? 1 : 0, next.issue ?? null, id,
			);
		return next;
	}

	getNode(id: string): NodeMeta | undefined {
		const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Row | undefined;
		return row ? toNode(row) : undefined;
	}

	listNodes(): NodeMeta[] {
		return (this.db.prepare("SELECT * FROM nodes ORDER BY created_at, id").all() as Row[]).map(toNode);
	}

	addUsage(id: string, tokens: number, cost: number): void {
		this.db.prepare("UPDATE nodes SET tokens = tokens + ?, cost = cost + ? WHERE id = ?").run(Math.max(0, Math.round(tokens)), Math.max(0, cost), id);
	}

	journal(envelope: Envelope, recipient: string): void {
		this.db
			.prepare("INSERT OR IGNORE INTO journal (envelope_id, recipient, sender, correlation_id, created_at, body) VALUES (?, ?, ?, ?, ?, ?)")
			.run(envelope.id, recipient, envelope.from, envelope.correlationId, envelope.createdAt, JSON.stringify(envelope));
	}

	markAcked(envelopeId: string, recipient: string): void {
		this.db.prepare("UPDATE journal SET acked = 1 WHERE envelope_id = ? AND recipient = ?").run(envelopeId, recipient);
	}

	unacked(recipient: string): Envelope[] {
		const rows = this.db.prepare("SELECT body FROM journal WHERE recipient = ? AND acked = 0 ORDER BY envelope_id").all(recipient) as Row[];
		return rows.map((row) => JSON.parse(row.body as string) as Envelope);
	}

	recipientsWithUnacked(): string[] {
		return (this.db.prepare("SELECT DISTINCT recipient FROM journal WHERE acked = 0").all() as Row[]).map((row) => row.recipient as string);
	}

	setMailState(envelopeId: string, recipient: string, state: InboundState): void {
		this.db.prepare("UPDATE journal SET mail_state = ? WHERE envelope_id = ? AND recipient = ?").run(state, envelopeId, recipient);
	}

	traffic(options: { limit?: number; mailState?: InboundState; node?: string } = {}): JournalRecord[] {
		const where: string[] = [];
		const args: Array<string | number> = [];
		if (options.mailState) {
			where.push("mail_state = ?");
			args.push(options.mailState);
		}
		if (options.node) {
			where.push("(recipient = ? OR sender = ?)");
			args.push(options.node, options.node);
		}
		args.push(options.limit ?? 200);
		const sql = `SELECT * FROM journal ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY envelope_id DESC LIMIT ?`;
		return (this.db.prepare(sql).all(...args) as Row[]).map((row) => ({
			envelope: JSON.parse(row.body as string) as Envelope,
			recipient: row.recipient as string,
			acked: row.acked === 1,
			mailState: row.mail_state as InboundState | null,
		}));
	}

	close(): void {
		this.db.close();
	}
}
