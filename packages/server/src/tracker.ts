/**
 * The team's work, and the only thing that writes it. Every change comes through here, is
 * checked against the scheme, applied, numbered and recorded with who made it. There is one
 * copy and one order of events, so there is never anything to merge.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_SCHEME, fieldProblem, firstState, type Issue, type IssueChange, type IssueComment, type IssueEvent, isClosed, misplaced, normalizeScheme, type Scheme, schemeProblems, stateKind, wouldLoop } from "@pi-lattice/protocol";

/** A request that cannot be done, with the HTTP status that says what kind of problem it is. */
export class WorkError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const MIGRATIONS: string[] = [
	`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE members (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL, joined_at INTEGER NOT NULL);
	CREATE TABLE issues (
		number INTEGER PRIMARY KEY,
		title TEXT NOT NULL,
		body TEXT NOT NULL,
		type TEXT NOT NULL,
		state TEXT NOT NULL,
		parent INTEGER,
		assignee TEXT,
		labels TEXT NOT NULL,
		fields TEXT NOT NULL,
		author TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		rev INTEGER NOT NULL
	);
	CREATE INDEX issues_rev ON issues (rev);
	CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, issue INTEGER NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
	CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, rev INTEGER NOT NULL, issue INTEGER NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, what TEXT NOT NULL, was TEXT, now TEXT);
	CREATE INDEX events_issue ON events (issue);`,
];

const TITLE_MAX = 200;
const BODY_MAX = 64 * 1024;
const LABELS_MAX = 20;
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

type Row = Record<string, unknown>;
const toIssue = (row: Row): Issue => ({
	number: row.number as number,
	title: row.title as string,
	body: row.body as string,
	type: row.type as string,
	state: row.state as string,
	...(row.parent !== null ? { parent: row.parent as number } : {}),
	...(row.assignee !== null ? { assignee: row.assignee as string } : {}),
	labels: JSON.parse(row.labels as string) as string[],
	fields: JSON.parse(row.fields as string) as Record<string, string | number>,
	author: row.author as string,
	createdAt: row.created_at as number,
	updatedAt: row.updated_at as number,
	rev: row.rev as number,
});

export class Tracker {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private cachedScheme: Scheme | undefined;
	/** Called after every change, with the new revision. */
	onChange: (rev: number) => void = () => {};

	constructor(file: string, options: { now?: () => number } = {}) {
		if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
		this.db = new DatabaseSync(file);
		this.now = options.now ?? Date.now;
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		for (let at = version; at < MIGRATIONS.length; at++) {
			this.db.exec(MIGRATIONS[at] as string);
			this.db.exec(`PRAGMA user_version = ${at + 1}`);
		}
		if (this.meta("code") === undefined) this.setMeta("code", randomBytes(16).toString("hex"));
	}

	close(): void {
		this.db.close();
	}

	private meta(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	}
	private setMeta(key: string, value: string): void {
		this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	/** The secret that lets someone join. Whoever has it can read and write everything. */
	get code(): string {
		return this.meta("code") as string;
	}

	/** The revision of the last change. */
	get rev(): number {
		return Number(this.meta("rev") ?? 0);
	}

	/** Do several writes as one: all of them, or none. Returns the revision they share. */
	private change<T>(work: (rev: number) => T): T {
		const rev = this.rev + 1;
		this.db.exec("BEGIN IMMEDIATE");
		let result: T;
		try {
			result = work(rev);
			this.setMeta("rev", String(rev));
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		this.onChange(rev);
		return result;
	}

	// People

	/** Take a name in the team and get the token that proves it from then on. */
	join(code: string, name: string): { name: string; token: string } {
		const given = Buffer.from(hash(String(code)));
		if (!timingSafeEqual(given, Buffer.from(hash(this.code)))) throw new WorkError(403, "That is not this team's code.");
		if (typeof name !== "string" || !NAME.test(name)) throw new WorkError(400, "A name is 1 to 32 letters, digits, dots, - and _.");
		if (this.db.prepare("SELECT 1 FROM members WHERE name = ? COLLATE NOCASE").get(name)) {
			throw new WorkError(409, `Someone is already "${name}" on this server. If that is you on another machine, copy your lattice home's server.json from it; otherwise choose another name.`);
		}
		const token = randomBytes(32).toString("hex");
		this.change(() => this.db.prepare("INSERT INTO members (name, token_hash, joined_at) VALUES (?, ?, ?)").run(name, hash(token), this.now()));
		return { name, token };
	}

	/** Who a token belongs to. */
	who(token: string | undefined): string | undefined {
		if (!token) return undefined;
		return (this.db.prepare("SELECT name FROM members WHERE token_hash = ?").get(hash(token)) as { name: string } | undefined)?.name;
	}

	members(): string[] {
		return (this.db.prepare("SELECT name FROM members ORDER BY joined_at, name").all() as Array<{ name: string }>).map((row) => row.name);
	}

	// The scheme

	get scheme(): Scheme {
		if (!this.cachedScheme) {
			const stored = this.meta("scheme");
			this.cachedScheme = stored ? (JSON.parse(stored) as Scheme) : DEFAULT_SCHEME;
		}
		return this.cachedScheme;
	}

	get schemeRev(): number {
		return Number(this.meta("scheme_rev") ?? 0);
	}

	/** Replace the scheme. What exists is left as it is, fitting or not. */
	setScheme(who: string, value: unknown): Scheme {
		const problems = schemeProblems(value);
		if (problems.length > 0) throw new WorkError(400, problems.join("\n"));
		const scheme = normalizeScheme(value as Scheme);
		return this.change((rev) => {
			this.setMeta("scheme", JSON.stringify(scheme));
			this.setMeta("scheme_rev", String(rev));
			this.record(rev, 0, who, "scheme");
			this.cachedScheme = scheme;
			return scheme;
		});
	}

	// Issues

	issue(number: number): Issue | undefined {
		const row = this.db.prepare("SELECT * FROM issues WHERE number = ?").get(number) as Row | undefined;
		return row ? toIssue(row) : undefined;
	}

	private must(number: number): Issue {
		const issue = Number.isInteger(number) ? this.issue(number) : undefined;
		if (!issue) throw new WorkError(404, `There is no issue #${number}.`);
		return issue;
	}

	/** Every issue changed after a revision, oldest change first. */
	issuesAfter(rev: number): Issue[] {
		return (this.db.prepare("SELECT * FROM issues WHERE rev > ? ORDER BY rev, number").all(rev) as Row[]).map(toIssue);
	}

	children(number: number): Issue[] {
		return (this.db.prepare("SELECT * FROM issues WHERE parent = ? ORDER BY number").all(number) as Row[]).map(toIssue);
	}

	comments(number: number): IssueComment[] {
		return (this.db.prepare("SELECT id, issue, author, body, at FROM comments WHERE issue = ? ORDER BY id").all(number) as Row[]) as unknown as IssueComment[];
	}

	history(number: number): IssueEvent[] {
		return (this.db.prepare("SELECT rev, issue, who, at, what, was, now FROM events WHERE issue = ? ORDER BY id").all(number) as Row[]).map((row) => ({
			rev: row.rev as number, issue: row.issue as number, who: row.who as string, at: row.at as number, what: row.what as string,
			...(row.was !== null ? { from: row.was as string } : {}), ...(row.now !== null ? { to: row.now as string } : {}),
		}));
	}

	private record(rev: number, issue: number, who: string, what: string, was?: string, now?: string): void {
		this.db.prepare("INSERT INTO events (rev, issue, who, at, what, was, now) VALUES (?, ?, ?, ?, ?, ?, ?)").run(rev, issue, who, this.now(), what, was ?? null, now ?? null);
	}

	private text(value: unknown, what: string, max: number, empty: boolean): string {
		if (typeof value !== "string") throw new WorkError(400, `${what} is text.`);
		const text = what === "A title" ? value.trim() : value;
		if (!empty && text === "") throw new WorkError(400, `${what} cannot be empty.`);
		if (Buffer.byteLength(text) > max) throw new WorkError(400, `${what} is at most ${max} bytes.`);
		return text;
	}

	private labels(value: unknown): string[] {
		if (!Array.isArray(value) || !value.every((label) => typeof label === "string" && label.trim() !== "" && label.length <= 50)) throw new WorkError(400, "Labels are a list of short names.");
		const labels = [...new Set((value as string[]).map((label) => label.trim()))];
		if (labels.length > LABELS_MAX) throw new WorkError(400, `An issue has at most ${LABELS_MAX} labels.`);
		return labels;
	}

	private person(value: unknown): string {
		const name = this.members().find((member) => member.toLowerCase() === String(value).toLowerCase());
		if (!name) throw new WorkError(400, `"${String(value)}" is not in the team. The people are: ${this.members().join(", ")}.`);
		return name;
	}

	private parentOf(number: number | undefined, value: unknown): Issue {
		const parent = typeof value === "number" && Number.isInteger(value) ? this.issue(value) : undefined;
		if (!parent) throw new WorkError(400, `There is no issue #${String(value)} to put it under.`);
		if (number !== undefined) {
			const all = new Map((this.db.prepare("SELECT number, parent FROM issues").all() as Array<{ number: number; parent: number | null }>).map((row) => [row.number, row.parent === null ? {} : { parent: row.parent }]));
			if (wouldLoop(all, number, parent.number)) throw new WorkError(400, parent.number === number ? "An issue cannot be under itself." : `#${parent.number} is under #${number}, so #${number} cannot go under it.`);
		}
		return parent;
	}

	create(who: string, change: IssueChange): Issue {
		const scheme = this.scheme;
		const title = this.text(change.title, "A title", TITLE_MAX, false);
		const body = change.body === undefined ? "" : this.text(change.body, "A body", BODY_MAX, true);
		const parent = change.parent === undefined || change.parent === null ? undefined : this.parentOf(undefined, change.parent);
		// With no type given, an issue is the first type that may go where it is put.
		const type = change.type ?? scheme.types.find((entry) => (parent ? entry.under.includes(parent.type) : entry.top))?.name;
		if (typeof type !== "string") throw new WorkError(400, parent ? `Nothing may go under a ${parent.type}.` : "Give the issue a type.");
		const where = misplaced(scheme, type, parent?.type);
		if (where) throw new WorkError(400, where);
		const state = change.state ?? firstState(scheme);
		if (!scheme.states.some((entry) => entry.name === state)) throw new WorkError(400, `"${String(state)}" is not a state. The states are: ${scheme.states.map((entry) => entry.name).join(", ")}.`);
		const assignee = change.assignee === undefined || change.assignee === null ? undefined : this.person(change.assignee);
		const labels = change.labels === undefined ? [] : this.labels(change.labels);
		const fields = Object.fromEntries(Object.entries(change.fields ?? {}).filter(([, value]) => value !== null)) as Record<string, string | number>;
		const problem = fieldProblem(scheme, type, fields, this.members());
		if (problem) throw new WorkError(400, problem);
		return this.change((rev) => {
			const at = this.now();
			const number = Number((this.db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM issues").get() as { next: number }).next);
			this.db
				.prepare("INSERT INTO issues (number, title, body, type, state, parent, assignee, labels, fields, author, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(number, title, body, type, state, parent?.number ?? null, assignee ?? null, JSON.stringify(labels), JSON.stringify(fields), who, at, at, rev);
			this.record(rev, number, who, "created");
			return this.must(number);
		});
	}

	/**
	 * Change an issue. `basedOn` is the revision the caller last saw it at: when the issue has
	 * changed since, nothing is done and the caller is told to look again.
	 */
	update(who: string, number: number, change: IssueChange, basedOn?: number): Issue {
		const before = this.must(number);
		if (basedOn !== undefined && before.rev > basedOn) throw new WorkError(409, `#${number} has changed since you last saw it. Look at it again, then make the change.`);
		const scheme = this.scheme;
		const after: Issue = { ...before, labels: [...before.labels], fields: { ...before.fields } };
		if (change.title !== undefined) after.title = this.text(change.title, "A title", TITLE_MAX, false);
		if (change.body !== undefined) after.body = this.text(change.body, "A body", BODY_MAX, true);
		if (change.labels !== undefined) after.labels = this.labels(change.labels);
		if (change.assignee === null) delete after.assignee;
		else if (change.assignee !== undefined) after.assignee = this.person(change.assignee);
		if (change.parent === null) delete after.parent;
		else if (change.parent !== undefined) after.parent = this.parentOf(number, change.parent).number;
		if (change.type !== undefined) after.type = String(change.type);
		const moved = after.parent !== before.parent || after.type !== before.type;
		if (moved) {
			const where = misplaced(scheme, after.type, after.parent === undefined ? undefined : this.must(after.parent).type);
			if (where) throw new WorkError(400, where);
		}
		if (after.type !== before.type) {
			for (const child of this.children(number)) {
				const stranded = misplaced(scheme, child.type, after.type);
				if (stranded) throw new WorkError(400, `#${number} has #${child.number} under it. ${stranded} Move it first.`);
			}
		}
		if (change.state !== undefined && change.state !== before.state) {
			if (!scheme.states.some((entry) => entry.name === change.state)) throw new WorkError(400, `"${String(change.state)}" is not a state. The states are: ${scheme.states.map((entry) => entry.name).join(", ")}.`);
			after.state = change.state;
			if (isClosed(scheme, after) && !isClosed(scheme, before)) {
				const open = this.children(number).filter((child) => !isClosed(scheme, child));
				if (open.length > 0) throw new WorkError(400, `#${number} has ${open.length === 1 ? "an unfinished issue" : `${open.length} unfinished issues`} under it: ${open.map((child) => `#${child.number}`).join(", ")}. Finish or drop ${open.length === 1 ? "it" : "them"} first.`);
			}
		}
		if (change.fields !== undefined) {
			if (typeof change.fields !== "object" || change.fields === null) throw new WorkError(400, "Fields are an object of names and values.");
			for (const [name, value] of Object.entries(change.fields)) {
				if (value === null) delete after.fields[name];
				else after.fields[name] = value;
			}
		}
		if (change.fields !== undefined || after.type !== before.type) {
			const problem = fieldProblem(scheme, after.type, after.fields, this.members());
			if (problem) throw new WorkError(400, problem);
		}
		const changes: Array<[what: string, was: string | undefined, now: string | undefined]> = [];
		const note = (what: string, was: unknown, now: unknown): void => {
			const [a, b] = [was === undefined ? undefined : String(was), now === undefined ? undefined : String(now)];
			if (a !== b) changes.push([what, a, b]);
		};
		note("title", before.title, after.title);
		if (before.body !== after.body) changes.push(["body", undefined, undefined]);
		note("type", before.type, after.type);
		note("state", before.state, after.state);
		note("parent", before.parent, after.parent);
		note("assignee", before.assignee, after.assignee);
		note("labels", before.labels.join(", ") || undefined, after.labels.join(", ") || undefined);
		for (const name of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) note(`field:${name}`, before.fields[name], after.fields[name]);
		if (changes.length === 0) return before;
		return this.change((rev) => {
			this.db
				.prepare("UPDATE issues SET title = ?, body = ?, type = ?, state = ?, parent = ?, assignee = ?, labels = ?, fields = ?, updated_at = ?, rev = ? WHERE number = ?")
				.run(after.title, after.body, after.type, after.state, after.parent ?? null, after.assignee ?? null, JSON.stringify(after.labels), JSON.stringify(after.fields), this.now(), rev, number);
			for (const [what, was, now] of changes) this.record(rev, number, who, what, was, now);
			return this.must(number);
		});
	}

	comment(who: string, number: number, body: unknown): IssueComment {
		this.must(number);
		const text = this.text(body, "A comment", BODY_MAX, false);
		return this.change((rev) => {
			const at = this.now();
			const { lastInsertRowid } = this.db.prepare("INSERT INTO comments (issue, author, body, at) VALUES (?, ?, ?, ?)").run(number, who, text, at);
			this.db.prepare("UPDATE issues SET updated_at = ?, rev = ? WHERE number = ?").run(at, rev, number);
			this.record(rev, number, who, "commented");
			return { id: Number(lastInsertRowid), issue: number, author: who, body: text, at };
		});
	}

	/**
	 * What a session does to the issue it is on, by the scheme's rules. Starting moves an issue
	 * nobody has started; a result closes it unless something under it is unfinished. Anything the
	 * rules do not cover, or that would be refused, leaves the issue as it is.
	 */
	session(who: string, number: number, event: "start" | "report"): Issue {
		const issue = this.must(number);
		const scheme = this.scheme;
		const target = event === "start" ? scheme.rules.onStart : scheme.rules.onReport;
		if (!target || !scheme.states.some((state) => state.name === target) || issue.state === target) return issue;
		if (event === "start" && stateKind(scheme, issue.state) !== "open") return issue;
		if (event === "report" && isClosed(scheme, issue)) return issue;
		try {
			return this.update(who, number, { state: target });
		} catch (error) {
			if (error instanceof WorkError && error.status === 400) return issue;
			throw error;
		}
	}
}
