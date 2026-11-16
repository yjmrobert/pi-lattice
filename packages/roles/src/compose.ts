/** Composition of applied fragments: list edits, advisory notes and prompt sections. Pure. */
import type { Fragment } from "./fragments.ts";

export type RoleEdit = "set" | "add" | "remove" | "clear";

export interface EditResult {
	fragments: string[];
	/** Names that were asked for but do not exist. Nothing is applied when this is non-empty. */
	unknown: string[];
	changed: boolean;
	/** Fragments that were taken off because another one took their slot. */
	displaced: Array<{ name: string; by: string; slot: string }>;
}

/**
 * Apply an edit to the applied list. Order is the order of application; duplicates collapse.
 *
 * - `add` applies the names as well. One that shares a slot with an applied fragment takes its place.
 * - `set` replaces the list, except for fragments marked `keep`: those stay, first, in the order they were in.
 * - `remove` takes the names off, whatever they are marked.
 * - `clear` takes everything off.
 */
export function editRoles(current: readonly string[], edit: RoleEdit, names: readonly string[], available: ReadonlyMap<string, Fragment>): EditResult {
	const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
	const unknown = edit === "set" || edit === "add" ? wanted.filter((name) => !available.has(name)) : [];
	if (unknown.length > 0) return { fragments: [...current], unknown, changed: false, displaced: [] };
	const displaced: EditResult["displaced"] = [];
	/** Put a name on the list, taking off whatever holds its slot. */
	const place = (list: string[], name: string): string[] => {
		if (list.includes(name)) return list;
		const slot = available.get(name)?.slot;
		const others = slot === undefined ? list : list.filter((other) => available.get(other)?.slot !== slot);
		if (slot !== undefined) for (const other of list) if (!others.includes(other)) displaced.push({ name: other, by: name, slot });
		return [...others, name];
	};
	let next: string[];
	if (edit === "set") next = wanted.reduce(place, current.filter((name) => available.get(name)?.keep === true));
	else if (edit === "add") next = wanted.reduce(place, [...current]);
	else if (edit === "remove") next = current.filter((name) => !wanted.includes(name));
	else next = [];
	return { fragments: next, unknown: [], changed: next.length !== current.length || next.some((name, i) => name !== current[i]), displaced };
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
	// A list made before slots were known, or written by hand, may hold two of one slot.
	const holders = new Map<string, string>();
	for (const name of applied) {
		const slot = available.get(name)?.slot;
		if (slot === undefined) continue;
		const first = holders.get(slot);
		if (first !== undefined && first !== name) notes.push(`"${first}" and "${name}" are both a ${slot}; applying one again takes the other off.`);
		else holders.set(slot, name);
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
