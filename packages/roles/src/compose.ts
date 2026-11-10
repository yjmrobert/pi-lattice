/** Composition of applied fragments: list edits, advisory notes and prompt sections. Pure. */
import type { Fragment } from "./fragments.ts";

export type RoleEdit = "set" | "add" | "remove";

export interface EditResult {
	fragments: string[];
	/** Names that were asked for but do not exist. Nothing is applied when this is non-empty. */
	unknown: string[];
	changed: boolean;
}

/** Apply an edit to the applied list. Order is the order of application; duplicates collapse. */
export function editRoles(current: readonly string[], edit: RoleEdit, names: readonly string[], available: ReadonlyMap<string, Fragment>): EditResult {
	const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	const unknown = edit === "remove" ? [] : wanted.filter((name) => !available.has(name));
	if (unknown.length > 0) return { fragments: [...current], unknown, changed: false };
	let next: string[];
	if (edit === "set") next = wanted;
	else if (edit === "add") next = [...current, ...wanted.filter((name) => !current.includes(name))];
	else next = current.filter((name) => !wanted.includes(name));
	return { fragments: next, unknown: [], changed: next.length !== current.length || next.some((name, i) => name !== current[i]) };
}

/**
 * Advisory notes about a combination. These are shown to the human and the agent; nothing
 * is ever blocked because of them.
 */
export function advisories(applied: readonly string[], available: ReadonlyMap<string, Fragment>): string[] {
	const notes: string[] = [];
	for (const name of applied) {
		const fragment = available.get(name);
		if (!fragment) {
			notes.push(`"${name}" is applied but no such fragment is installed; it adds nothing.`);
			continue;
		}
		for (const required of fragment.requires) {
			if (!applied.includes(required)) notes.push(`"${name}" is usually combined with "${required}".`);
		}
		for (const conflict of fragment.conflicts) {
			if (applied.includes(conflict)) notes.push(`"${name}" and "${conflict}" give competing guidance.`);
		}
	}
	return notes;
}

export const SECTION_PREFIX = "lattice-role-";
export const INDEX_SECTION = "lattice-roles";

/**
 * The system prompt sections for an applied list: one index section, then one section per
 * fragment in list order. Keys are XML tag names, so Pi can patch exactly the sections
 * that changed and keep the cached prefix (ADR 0003).
 */
export function roleSections(applied: readonly string[], available: ReadonlyMap<string, Fragment>): Record<string, string> {
	const present = applied.map((name) => available.get(name)).filter((fragment): fragment is Fragment => fragment !== undefined);
	if (present.length === 0) return {};
	const sections: Record<string, string> = {
		[INDEX_SECTION]: [
			`This session has been given these roles, in order: ${present.map((fragment) => fragment.name).join(", ")}.`,
			`Each has a section below named ${SECTION_PREFIX}<name>. Follow them together. Where two disagree, the later one wins. They are guidance: the user can overrule any of it at any time, and the set of roles can change during the session.`,
		].join("\n"),
	};
	for (const fragment of present) sections[`${SECTION_PREFIX}${fragment.name}`] = fragment.body;
	return sections;
}
