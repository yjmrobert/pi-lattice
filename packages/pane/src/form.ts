/**
 * The new-session form: name, kind, roles, workspace and brief on one screen, in place of five
 * prompts in a row. Pure: a key turns one form state into the next. Text is edited at its end.
 */
import type { SpawnSpec } from "@pi-lattice/protocol";
import { draw, fit, flow, type Paint, PLAIN, type Seg, widthOf, wrap } from "./view.ts";

const FIELDS = ["name", "kind", "roles", "workspace", "brief", "create"] as const;
type Field = (typeof FIELDS)[number];

export interface ChildForm {
	parentId: string;
	parentName: string;
	field: Field;
	name: string;
	kind: string;
	/** The role fragments that exist, and the ones chosen, in the order chosen. */
	roles: string[];
	picked: string[];
	/** Which role the cursor is on, within the roles field. */
	roleAt: number;
	workspace: "shared" | "worktree";
	brief: string;
	/** What stopped the last attempt to create. */
	error?: string;
}

export function newChildForm(parent: { id: string; name: string }, roles: string[]): ChildForm {
	return { parentId: parent.id, parentName: parent.name, field: "name", name: "", kind: "task", roles, picked: [], roleAt: 0, workspace: "shared", brief: "" };
}

/** A key as the form sees it: a name for the ones that act, or text to insert. */
export type FormKey = "tab" | "back-tab" | "up" | "down" | "left" | "right" | "enter" | "space" | "backspace" | "escape" | "submit" | { text: string };

export type FormResult = { form: ChildForm } | { cancel: true } | { submit: { parentId: string; spec: SpawnSpec } };

const step = (form: ChildForm, delta: number): ChildForm => {
	const at = FIELDS.indexOf(form.field);
	return { ...form, field: FIELDS[Math.min(FIELDS.length - 1, Math.max(0, at + delta))] as Field };
};

function submit(form: ChildForm): FormResult {
	const name = form.name.trim();
	const brief = form.brief.trim();
	if (!name) return { form: { ...form, field: "name", error: "Give it a name." } };
	if (!brief) return { form: { ...form, field: "brief", error: "Say what it should do. It sees only the brief." } };
	return { submit: { parentId: form.parentId, spec: { name, brief, kind: form.kind.trim() || "task", fragments: form.picked, workspace: form.workspace } } };
}

export function formKey(form: ChildForm, key: FormKey): FormResult {
	const { error: _error, ...clean } = form;
	const field = form.field;
	if (key === "escape") return { cancel: true };
	if (key === "submit") return submit(clean);
	if (key === "tab" || key === "down") return { form: step(clean, 1) };
	if (key === "back-tab" || key === "up") return { form: step(clean, -1) };
	if (typeof key === "object" || key === "space") {
		const text = typeof key === "object" ? key.text : " ";
		if (field === "name" || field === "kind") return { form: { ...clean, [field]: `${form[field]}${text.replace(/\s+/g, " ")}` } };
		if (field === "brief") return { form: { ...clean, brief: `${form.brief}${text}` } };
		if (key !== "space") return { form: clean };
	}
	if (key === "backspace") {
		if (field === "name" || field === "kind" || field === "brief") return { form: { ...clean, [field]: [...form[field]].slice(0, -1).join("") } };
		return { form: clean };
	}
	if (field === "roles") {
		const role = form.roles[form.roleAt];
		if (key === "left" || key === "right") return { form: { ...clean, roleAt: Math.min(Math.max(0, form.roles.length - 1), Math.max(0, form.roleAt + (key === "left" ? -1 : 1))) } };
		if (key === "space" && role) return { form: { ...clean, picked: form.picked.includes(role) ? form.picked.filter((name) => name !== role) : [...form.picked, role] } };
		if (key === "enter") return { form: step(clean, 1) };
	}
	if (field === "workspace") {
		if (key === "left" || key === "right" || key === "space") return { form: { ...clean, workspace: form.workspace === "shared" ? "worktree" : "shared" } };
		if (key === "enter") return { form: step(clean, 1) };
	}
	if (field === "brief" && key === "enter") return { form: { ...clean, brief: `${form.brief}\n` } };
	if (field === "create" && (key === "enter" || key === "space")) return submit(clean);
	if (key === "enter") return { form: step(clean, 1) };
	return { form: clean };
}

/** Draw the form. `height`, when given, pins the keys to the bottom. */
export function renderForm(form: ChildForm, width: number, paint: Paint = PLAIN, height?: number): string[] {
	const inner = Math.max(24, width - 2);
	const text = Math.min(inner - 2, 72);
	const out: Seg[][] = [];
	const label = (field: Field, name: string): Seg => [` ${name.padEnd(11)}`, form.field === field ? (t: string) => paint.accent(paint.bold(t)) : paint.dim];
	const caret = (field: Field): Seg => [form.field === field ? "▏" : "", paint.accent];
	out.push([[" New session", paint.bold], [` under ${fit(form.parentName, Math.max(8, inner - 20))}`, paint.dim]]);
	out.push([[""]]);
	out.push([label("name", "Name"), [fit(form.name, text - 13)], caret("name")]);
	out.push([label("kind", "Kind"), [fit(form.kind, text - 13)], caret("kind")]);

	// Roles flow across as many rows as they need. Chosen ones are bracketed; the cursor's is highlighted.
	let row: Seg[] = [label("roles", "Roles")];
	if (form.roles.length === 0) row.push(["none available", paint.dim]);
	form.roles.forEach((role, index) => {
		const chosen = form.picked.includes(role);
		const cell = chosen ? `[${role}]` : ` ${role} `;
		if (widthOf(row) + [...cell].length + 1 > inner) {
			out.push(row);
			row = [[" ".repeat(12)]];
		}
		const here = form.field === "roles" && index === form.roleAt;
		row.push([cell, here ? paint.select : chosen ? paint.bold : paint.dim], [" "]);
	});
	out.push(row);

	const option = (value: ChildForm["workspace"], words: string): Seg[] => [[form.workspace === value ? "◉ " : "○ ", form.workspace === value ? paint.accent : paint.dim], [words, form.workspace === value ? undefined : paint.dim]];
	out.push([label("workspace", "Workspace"), ...option("shared", "this directory"), ["   "], ...option("worktree", "its own worktree and branch")]);
	out.push([[""]]);
	out.push([label("brief", "Brief"), ["what it should do; it sees only this", paint.dim]]);
	const border = form.field === "brief" ? paint.accent : paint.dim;
	const lines = form.brief.split("\n").flatMap((line) => (line === "" ? [""] : wrap(line, text - 4)));
	if (form.field === "brief") lines[lines.length - 1] = `${lines[lines.length - 1] ?? ""}▏`;
	// The end of a long brief stays in view, since that is where it is being typed.
	const shown = lines.slice(-8);
	while (shown.length < 4) shown.push("");
	out.push([[` ╭${"─".repeat(text - 2)}╮`, border]]);
	for (const line of shown) out.push([[" │ ", border], [line.padEnd(text - 4)], [" │", border]]);
	out.push([[` ╰${"─".repeat(text - 2)}╯`, border]]);
	out.push([[""]]);
	out.push([[" "], ["  Create  ", form.field === "create" ? paint.select : paint.bold], ["  runs in the background", paint.dim]]);
	if (form.error) out.push([[""]], [[` ${fit(form.error, inner - 1)}`, paint.warn]]);

	const keys: Array<readonly [string, string]> =
		form.field === "roles"
			? [["←→", "choose"], ["space", "toggle"]]
			: form.field === "workspace"
				? [["space", "switch"]]
				: form.field === "create"
					? [["⏎", "create"]]
					: form.field === "brief"
						? [["⏎", "new line"]]
						: [];
	const foot: Seg[][] = [[["─".repeat(inner + 1), paint.dim]], ...flow([...keys, ["tab", "next field"], ["ctrl+s", "create"], ["esc", "cancel"]], inner, paint)];
	const body = out.map(draw);
	if (height === undefined) return [...body, ...foot.map(draw)];
	const room = Math.max(1, height - foot.length);
	const visible = body.slice(0, room);
	return [...visible, ...Array.from({ length: room - visible.length }, () => ""), ...foot.map(draw)];
}
