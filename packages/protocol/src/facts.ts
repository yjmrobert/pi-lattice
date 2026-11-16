/**
 * Facts: what is so for a session, as names and texts. A role fragment may say it applies only
 * when a fact holds, and may mention a fact's text as `{{name}}`. One flat table and one rule,
 * the same one templates use: a fact holds when its text is not empty.
 *
 * Facts are things that stay put for a session: where it is in the tree, whether the team has
 * a server, which tools it was given. Never a status and never a time, so the prompt they are
 * written into does not change from turn to turn.
 *
 * This module does no I/O. The host works out a session's facts and the session asks for them.
 */
import type { NodeMeta } from "./node.ts";
import type { Scheme } from "./work.ts";

export type Facts = Readonly<Record<string, string>>;

export interface FactInfo {
	name: string;
	/** What its text is, in one line. */
	says: string;
	/** For the guide: what it looks like. */
	example: string;
}

/** What a fact that is simply so, with nothing more to say, is given as its text. */
export const YES = "yes";

/** Every fact a session's host gives it. */
export const FACTS: readonly FactInfo[] = [
	{ name: "name", says: "The session's name in the tree.", example: "card form" },
	{ name: "kind", says: "The kind of work it was created for.", example: "task" },
	{ name: "parent.name", says: "The name of the session it reports to. Absent for the first session of a tree.", example: "checkout" },
	{ name: "issue", says: "The number of the issue it is on. Absent when it is on none.", example: "38" },
	{ name: "board", says: "The team keeps its work as issues on a server, and this session's host has joined it.", example: YES },
	{ name: "levels", says: "The levels of work, largest first: the team's issue types by level where there is a server, else the `canopy.levels` setting.", example: "epic, feature, story, task" },
	{ name: "types", says: "Every issue type of the team's scheme. Absent without a server.", example: "epic, feature, story, task, bug" },
];

/** A tool the session has is a fact too: `tool.spawn_session`. The session itself knows these. */
export const TOOL_FACT = "tool.";

const NAME = /^[\w.-]+$/;

export function isFactName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

/** Whether a name is one a fragment can count on meaning something. */
export function isKnownFact(name: string): boolean {
	return name.startsWith(TOOL_FACT) ? name.length > TOOL_FACT.length : FACTS.some((fact) => fact.name === name);
}

export function holds(facts: Facts, name: string): boolean {
	return (facts[name] ?? "") !== "";
}

/** Whether something that applies only `when` every one of some facts holds, and `unless` any of some others does, applies. */
export function applies(condition: { when?: readonly string[]; unless?: readonly string[] }, facts: Facts): boolean {
	return (condition.when ?? []).every((name) => holds(facts, name)) && !(condition.unless ?? []).some((name) => holds(facts, name));
}

/** The facts a set of tools makes so. */
export function toolFacts(names: Iterable<string>): Record<string, string> {
	const facts: Record<string, string> = {};
	for (const name of names) if (NAME.test(name)) facts[`${TOOL_FACT}${name}`] = YES;
	return facts;
}

/**
 * A session's facts, from where it is in the tree, the settings in effect and the team's work.
 * A fact that does not hold is left out.
 */
export function nodeFacts(input: {
	node: Pick<NodeMeta, "name" | "kind" | "issue">;
	parent?: Pick<NodeMeta, "name"> | undefined;
	/** The `canopy.levels` setting. */
	levels: readonly string[];
	/** The team's work, when this session's host has joined a server and can reach it. */
	work?: { scheme: Scheme } | undefined;
}): Record<string, string> {
	const byLevel = input.work ? [...input.work.scheme.types].sort((a, b) => a.level - b.level) : [];
	// One name for each level: the first type the scheme gives it.
	const levels = input.work ? byLevel.filter((type, index) => byLevel.findIndex((other) => other.level === type.level) === index).map((type) => type.name) : input.levels;
	const facts: Record<string, string> = { name: input.node.name, kind: input.node.kind };
	if (input.parent) facts["parent.name"] = input.parent.name;
	if (input.node.issue !== undefined) facts.issue = String(input.node.issue);
	if (levels.length > 0) facts.levels = levels.join(", ");
	if (input.work) {
		facts.board = YES;
		facts.types = input.work.scheme.types.map((type) => type.name).join(", ");
	}
	return facts;
}
