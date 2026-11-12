/**
 * Work as a team tracks it: issues, and the scheme that says how they are structured.
 *
 * An issue is small and fixed. What a team wants beyond it (which types exist, which may sit
 * under which, what the states are, what extra fields there are) is the scheme, which is data
 * and can be changed whole. Everything here is pure: the server applies these rules, and the
 * canopy and the agents read them.
 */

/** What a state means, whatever a team calls it. */
export type StateKind = "open" | "active" | "done" | "dropped";

export interface IssueType {
	name: string;
	/** The level it is drawn on: 0 is nearest the root. Two types may share a level. */
	level: number;
	/** The types it may sit under. */
	under: string[];
	/** Whether it may have no parent. */
	top: boolean;
}

export interface IssueState {
	name: string;
	kind: StateKind;
}

export type FieldType = "text" | "number" | "date" | "person" | "choice";

export interface IssueField {
	name: string;
	type: FieldType;
	/** What a `choice` may be. */
	choices?: string[];
	/** The types it applies to; every type when absent. */
	on?: string[];
	required?: boolean;
}

export interface Scheme {
	types: IssueType[];
	/** In the order a piece of work moves through them; the first is what a new issue gets. */
	states: IssueState[];
	fields: IssueField[];
	/** What sessions do to issues. A state named here that does not exist does nothing. */
	rules: {
		/** The state an issue that has not been started takes when a session is put on it. */
		onStart?: string;
		/** The state an issue takes when a session on it reports its result and nothing under it is unfinished. */
		onReport?: string;
	};
}

export interface Issue {
	number: number;
	title: string;
	body: string;
	type: string;
	state: string;
	parent?: number;
	assignee?: string;
	labels: string[];
	fields: Record<string, string | number>;
	author: string;
	createdAt: number;
	updatedAt: number;
	/** The server's revision when it last changed. */
	rev: number;
}

export interface IssueComment {
	id: number;
	issue: number;
	author: string;
	body: string;
	at: number;
}

/** One thing that was done to an issue. */
export interface IssueEvent {
	rev: number;
	issue: number;
	who: string;
	at: number;
	/** `created`, `commented`, or the name of what changed: `state`, `parent`, `field:estimate`. */
	what: string;
	from?: string;
	to?: string;
}

/** What may be given when making an issue, or changed on one. `null` clears a parent, an assignee or a field. */
export interface IssueChange {
	title?: string;
	body?: string;
	type?: string;
	state?: string;
	parent?: number | null;
	assignee?: string | null;
	labels?: string[];
	fields?: Record<string, string | number | null>;
}

/** A session someone has running, as the server tells everyone. */
export interface WorkSession {
	/** The host that runs it; one per person per repository. */
	host: string;
	owner: string;
	repo: string;
	id: string;
	name: string;
	/** What it is there to do. */
	role: string;
	state: "working" | "asking" | "waiting" | "idle" | "failed";
	/** The issue it is on. */
	issue?: number;
	/** The last thing it said or did. */
	activity?: string;
	/** Things on it waiting for its owner. */
	asks: number;
}

/** A team's work as one host holds it: a copy of what the server has. */
export interface WorkState {
	url: string;
	me: string;
	/** False while the server cannot be reached; the rest is then what was last heard. */
	connected: boolean;
	/** Why it cannot be reached. */
	problem?: string;
	scheme: Scheme;
	issues: Issue[];
	people: Array<{ name: string; online: boolean }>;
	sessions: WorkSession[];
}

/** What a session, the pane or the canopy asks of the team's work. */
export type WorkRequest =
	/** Everything, as this host holds it. */
	| { do: "look" }
	/** One issue with what was said on it and everything done to it. */
	| { do: "read"; number: number }
	| { do: "add"; change: IssueChange }
	| { do: "update"; number: number; change: IssueChange; basedOn?: number }
	| { do: "comment"; number: number; body: string }
	| { do: "scheme"; scheme: Scheme }
	/** Say which issue a session is on; `null` takes it off. `nodeId` names the session when it is not the one asking. */
	| { do: "on"; number: number | null; nodeId?: string };

export interface WorkResult {
	work?: WorkState;
	issue?: Issue;
	comments?: IssueComment[];
	history?: IssueEvent[];
	scheme?: Scheme;
}

export const DEFAULT_SCHEME: Scheme = {
	types: [
		{ name: "epic", level: 0, under: [], top: true },
		{ name: "feature", level: 1, under: ["epic"], top: false },
		{ name: "story", level: 2, under: ["feature"], top: false },
		{ name: "task", level: 3, under: ["story"], top: false },
		{ name: "bug", level: 3, under: ["epic", "feature", "story", "task"], top: true },
	],
	states: [
		{ name: "todo", kind: "open" },
		{ name: "doing", kind: "active" },
		{ name: "done", kind: "done" },
		{ name: "dropped", kind: "dropped" },
	],
	fields: [],
	rules: { onStart: "doing", onReport: "done" },
};

const KINDS: readonly string[] = ["open", "active", "done", "dropped"];
const FIELD_TYPES: readonly string[] = ["text", "number", "date", "person", "choice"];
const NAME = /^[a-z0-9][a-z0-9 _-]{0,31}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * What is wrong with a scheme, one line each; none when it can be used. A scheme is checked
 * for being usable, not for fitting the issues that exist.
 */
export function schemeProblems(value: unknown): string[] {
	if (!isRecord(value)) return ["A scheme is an object with types, states, fields and rules."];
	const out: string[] = [];
	const unique = (what: string, names: string[]): void => {
		for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index))) out.push(`There are two ${what} named "${name}".`);
		for (const name of names) if (!NAME.test(name)) out.push(`"${name}" cannot be the name of a ${what.replace(/s$/, "")}: use lower-case letters, digits, spaces, - and _, at most 32.`);
	};
	const types = Array.isArray(value.types) ? value.types : [];
	const typeNames: string[] = [];
	if (types.length === 0) out.push("A scheme needs at least one type.");
	for (const type of types) {
		if (!isRecord(type) || typeof type.name !== "string") {
			out.push("Every type needs a name.");
			continue;
		}
		typeNames.push(type.name);
		if (!Number.isInteger(type.level) || (type.level as number) < 0 || (type.level as number) > 12) out.push(`Type "${type.name}" needs a level from 0 to 12.`);
		if (!strings(type.under)) out.push(`Type "${type.name}" needs "under": the types it may sit under.`);
		if (typeof type.top !== "boolean") out.push(`Type "${type.name}" needs "top": whether it may have no parent.`);
	}
	unique("types", typeNames);
	for (const type of types) {
		if (!isRecord(type) || !strings(type.under)) continue;
		for (const parent of type.under) if (!typeNames.includes(parent)) out.push(`Type "${String(type.name)}" may sit under "${parent}", which is not a type.`);
		if (type.under.length === 0 && type.top === false) out.push(`Type "${String(type.name)}" can be put nowhere: it may sit under nothing and may not be at the top.`);
	}
	if (!types.some((type) => isRecord(type) && type.top === true)) out.push("At least one type must be allowed at the top.");

	const states = Array.isArray(value.states) ? value.states : [];
	const stateNames: string[] = [];
	for (const state of states) {
		if (!isRecord(state) || typeof state.name !== "string") {
			out.push("Every state needs a name.");
			continue;
		}
		stateNames.push(state.name);
		if (!KINDS.includes(state.kind as string)) out.push(`State "${state.name}" needs a kind: ${KINDS.join(", ")}.`);
	}
	unique("states", stateNames);
	if (!states.some((state) => isRecord(state) && (state.kind === "open" || state.kind === "active"))) out.push("A scheme needs a state for work that is not finished.");
	if (!states.some((state) => isRecord(state) && state.kind === "done")) out.push("A scheme needs a state for work that is done.");

	const fields = value.fields === undefined ? [] : Array.isArray(value.fields) ? value.fields : undefined;
	if (!fields) out.push('"fields" is a list.');
	const fieldNames: string[] = [];
	for (const field of fields ?? []) {
		if (!isRecord(field) || typeof field.name !== "string") {
			out.push("Every field needs a name.");
			continue;
		}
		fieldNames.push(field.name);
		if (!FIELD_TYPES.includes(field.type as string)) out.push(`Field "${field.name}" needs a type: ${FIELD_TYPES.join(", ")}.`);
		if (field.type === "choice" && !(strings(field.choices) && field.choices.length > 0)) out.push(`Field "${field.name}" is a choice and needs its choices.`);
		if (field.on !== undefined && !strings(field.on)) out.push(`Field "${field.name}": "on" is a list of types.`);
		for (const type of strings(field.on) ? field.on : []) if (!typeNames.includes(type)) out.push(`Field "${field.name}" is on "${type}", which is not a type.`);
	}
	unique("fields", fieldNames);
	if (value.rules !== undefined && !isRecord(value.rules)) out.push('"rules" is an object.');
	return out;
}

/** A scheme with what may be left out filled in. Call after `schemeProblems` found nothing. */
export function normalizeScheme(value: Scheme): Scheme {
	const rules = value.rules ?? {};
	return {
		types: value.types.map((type) => ({ name: type.name, level: type.level, under: [...type.under], top: type.top })),
		states: value.states.map((state) => ({ name: state.name, kind: state.kind })),
		fields: (value.fields ?? []).map((field) => ({ name: field.name, type: field.type, ...(field.choices ? { choices: [...field.choices] } : {}), ...(field.on ? { on: [...field.on] } : {}), ...(field.required ? { required: true } : {}) })),
		rules: { ...(typeof rules.onStart === "string" ? { onStart: rules.onStart } : {}), ...(typeof rules.onReport === "string" ? { onReport: rules.onReport } : {}) },
	};
}

export const typeOf = (scheme: Scheme, name: string): IssueType | undefined => scheme.types.find((type) => type.name === name);

/** What a state means. A state the scheme no longer has counts as open, so its work is not lost from view. */
export const stateKind = (scheme: Scheme, name: string): StateKind => scheme.states.find((state) => state.name === name)?.kind ?? "open";

/** Finished, one way or the other. */
export const isClosed = (scheme: Scheme, issue: Pick<Issue, "state">): boolean => {
	const kind = stateKind(scheme, issue.state);
	return kind === "done" || kind === "dropped";
};

/** The state a new issue gets. */
export const firstState = (scheme: Scheme): string => (scheme.states.find((state) => state.kind === "open") ?? scheme.states[0])?.name ?? "todo";

/** The names of the types on each level, nearest the root first; a level nobody is on is skipped. */
export function ladder(scheme: Scheme): string[][] {
	const levels = [...new Set(scheme.types.map((type) => type.level))].sort((a, b) => a - b);
	return levels.map((level) => scheme.types.filter((type) => type.level === level).map((type) => type.name));
}

/**
 * Why an issue of this type cannot be where it is: under that parent, or under none. Undefined
 * when it fits. Used to refuse a new issue or a move, and to mark what a changed scheme left behind.
 */
export function misplaced(scheme: Scheme, type: string, parentType: string | undefined): string | undefined {
	const rule = typeOf(scheme, type);
	if (!rule) return `"${type}" is not a type. The types are: ${scheme.types.map((entry) => entry.name).join(", ")}.`;
	if (parentType === undefined) return rule.top ? undefined : `${upper(a(type))} goes under ${list(rule.under)}, not at the top.`;
	if (rule.under.includes(parentType)) return undefined;
	return rule.under.length > 0 ? `${upper(a(type))} goes under ${list(rule.under)}${rule.top ? " or at the top" : ""}, not under ${a(parentType)}.` : `${upper(a(type))} goes at the top, not under ${a(parentType)}.`;
}

const a = (name: string): string => `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
const upper = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const list = (names: string[]): string => {
	const parts = names.map(a);
	return parts.length <= 1 ? (parts[0] ?? "nothing") : `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}`;
};

/** Whether making `parent` the parent of `number` would put an issue under itself. */
export function wouldLoop(issues: ReadonlyMap<number, Pick<Issue, "parent">>, number: number, parent: number): boolean {
	for (let at: number | undefined = parent, steps = 0; at !== undefined && steps < 10_000; at = issues.get(at)?.parent, steps++) if (at === number) return true;
	return false;
}

/** What is wrong with the values given for an issue's fields; undefined when they can be stored. */
export function fieldProblem(scheme: Scheme, type: string, fields: Record<string, string | number>, people?: readonly string[]): string | undefined {
	for (const [name, value] of Object.entries(fields)) {
		const field = scheme.fields.find((entry) => entry.name === name);
		if (!field) return `"${name}" is not a field.${scheme.fields.length > 0 ? ` The fields are: ${scheme.fields.map((entry) => entry.name).join(", ")}.` : " The scheme has no fields."}`;
		if (field.on && !field.on.includes(type)) return `Field "${name}" is for ${field.on.join(", ")}, not for ${a(type)}.`;
		if (field.type === "number" && typeof value !== "number") return `Field "${name}" is a number.`;
		if (field.type !== "number" && typeof value !== "string") return `Field "${name}" is text.`;
		if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return `Field "${name}" is a date, written like 2026-03-31.`;
		if (field.type === "choice" && !(field.choices ?? []).includes(String(value))) return `Field "${name}" is one of: ${(field.choices ?? []).join(", ")}.`;
		if (field.type === "person" && people && !people.includes(String(value))) return `Field "${name}" is a person in the team: ${people.join(", ")}.`;
	}
	for (const field of scheme.fields) if (field.required && (!field.on || field.on.includes(type)) && fields[field.name] === undefined) return `${upper(a(type))} needs "${field.name}".`;
	return undefined;
}

/** Why an issue does not fit the scheme as it is now; undefined when it does. For marking, not for refusing. */
export function misfit(scheme: Scheme, issue: Issue, issues: ReadonlyMap<number, Issue>): string | undefined {
	const parent = issue.parent === undefined ? undefined : issues.get(issue.parent);
	const where = misplaced(scheme, issue.type, parent?.type);
	if (where) return where;
	if (!scheme.states.some((state) => state.name === issue.state)) return `"${issue.state}" is no longer a state.`;
	return undefined;
}

/** The scheme in a few lines, for someone about to add to the work. */
export function describeScheme(scheme: Scheme): string {
	const types = scheme.types.map((type) => `${type.name} (${[type.under.length > 0 ? `under ${type.under.join(" or ")}` : "", type.top ? "at the top" : ""].filter(Boolean).join(", or ")})`);
	const lines = [`Types: ${types.join("; ")}.`, `States: ${scheme.states.map((state) => (state.name === state.kind ? state.name : `${state.name} (${state.kind})`)).join(", ")}.`];
	if (scheme.fields.length > 0) lines.push(`Fields: ${scheme.fields.map((field) => `${field.name} (${field.type === "choice" ? (field.choices ?? []).join("|") : field.type}${field.on ? `, on ${field.on.join(", ")}` : ""}${field.required ? ", required" : ""})`).join("; ")}.`);
	return lines.join("\n");
}

/** One issue on one line. */
export function issueLine(issue: Issue, state?: Pick<WorkState, "sessions">): string {
	const on = (state?.sessions ?? []).filter((session) => session.issue === issue.number).map((session) => `${session.owner}'s "${session.name}" ${session.state}`);
	const fields = Object.entries(issue.fields).map(([name, value]) => `${name}=${value}`);
	return [`#${issue.number}`, issue.type, issue.title, `[${issue.state}]`, issue.assignee ? `@${issue.assignee}` : "", issue.labels.map((label) => `+${label}`).join(" "), fields.join(" "), on.length > 0 ? `<- ${on.join(", ")}` : ""].filter(Boolean).join("  ");
}

/**
 * The work as an indented tree, one issue a line, with who is on each. `under` shows one issue
 * and what is below it; `open` leaves out what is finished, unless something unfinished is under it.
 */
export function formatWork(state: Pick<WorkState, "issues" | "scheme" | "sessions">, options: { under?: number; open?: boolean } = {}): string {
	const byNumber = new Map(state.issues.map((issue) => [issue.number, issue]));
	const kids = new Map<number | undefined, Issue[]>();
	for (const issue of state.issues) {
		const parent = issue.parent !== undefined && byNumber.has(issue.parent) ? issue.parent : undefined;
		kids.set(parent, [...(kids.get(parent) ?? []), issue]);
	}
	const lines: string[] = [];
	const shown = (issue: Issue): boolean => !options.open || !isClosed(state.scheme, issue) || (kids.get(issue.number) ?? []).some(shown);
	const walk = (issue: Issue, depth: number): void => {
		if (!shown(issue)) return;
		const why = misfit(state.scheme, issue, byNumber);
		lines.push(`${"  ".repeat(depth)}${issueLine(issue, state)}${why ? `  (misplaced: ${why})` : ""}`);
		for (const child of kids.get(issue.number) ?? []) walk(child, depth + 1);
	};
	const start = options.under !== undefined ? byNumber.get(options.under) : undefined;
	if (options.under !== undefined && !start) return `There is no issue #${options.under}.`;
	if (start) walk(start, 0);
	else for (const issue of kids.get(undefined) ?? []) walk(issue, 0);
	return lines.length > 0 ? lines.join("\n") : options.open ? "No unfinished work." : "There is no work yet.";
}
