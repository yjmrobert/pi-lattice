/**
 * The new-session form: name, kind, model, roles, workspace and brief on one screen, in place of
 * a series of prompts. Pure: a key turns one form state into the next.
 */
import type { SpawnSpec } from "@pi-lattice/protocol";
import { draw, fit, flow, type Paint, PLAIN, type Seg, widthOf, wrap } from "./view.ts";

const FIELDS = ["name", "kind", "model", "roles", "workspace", "brief", "create"] as const;
type Field = (typeof FIELDS)[number];
const TEXT_FIELDS = ["name", "kind", "model", "brief"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const isText = (field: Field): field is TextField => (TEXT_FIELDS as readonly string[]).includes(field);

export interface ChildForm {
	parentId: string;
	parentName: string;
	field: Field;
	name: string;
	kind: string;
	/** The model it runs on. Empty means the default. */
	model: string;
	/** The role fragments that exist, and the ones chosen, in the order chosen. */
	roles: string[];
	picked: string[];
	/** Which role the cursor is on, within the roles field. */
	roleAt: number;
	workspace: "shared" | "worktree";
	brief: string;
	/** Where the caret is in the text field being edited, in characters from its start. */
	at: number;
	/** What stopped the last attempt to create. */
	error?: string;
}

export function newChildForm(parent: { id: string; name: string }, roles: string[]): ChildForm {
	return { parentId: parent.id, parentName: parent.name, field: "name", name: "", kind: "task", model: "", roles, picked: [], roleAt: 0, workspace: "shared", brief: "", at: 0 };
}

/** A key as the form sees it: a name for the ones that act, or text to insert. */
export type FormKey = "tab" | "back-tab" | "up" | "down" | "left" | "right" | "home" | "end" | "enter" | "space" | "backspace" | "delete" | "escape" | "submit" | { text: string };

export type FormResult = { form: ChildForm } | { cancel: true } | { submit: { parentId: string; spec: SpawnSpec } };

const chars = (text: string): string[] => [...text];

/** Move to a field, with the caret at the end of its text. */
const go = (form: ChildForm, field: Field): ChildForm => ({ ...form, field, at: isText(field) ? chars(form[field]).length : 0 });
const step = (form: ChildForm, delta: number): ChildForm => go(form, FIELDS[Math.min(FIELDS.length - 1, Math.max(0, FIELDS.indexOf(form.field) + delta))] as Field);

function submit(form: ChildForm): FormResult {
	const name = form.name.trim();
	const brief = form.brief.trim();
	if (!name) return { form: { ...go(form, "name"), error: "Give it a name." } };
	if (!brief) return { form: { ...go(form, "brief"), error: "Say what it should do. It sees only the brief." } };
	const model = form.model.trim();
	return { submit: { parentId: form.parentId, spec: { name, brief, kind: form.kind.trim() || "task", fragments: form.picked, workspace: form.workspace, ...(model ? { model } : {}) } } };
}

/** Edit the text field the form is on: put text in at the caret, or take a character out beside it. */
function edit(form: ChildForm, field: TextField, change: { insert: string } | { remove: "before" | "after" }): ChildForm {
	const text = chars(form[field]);
	const at = Math.min(text.length, Math.max(0, form.at));
	if ("insert" in change) {
		const added = chars(field === "brief" ? change.insert : change.insert.replace(/\s+/g, " "));
		return { ...form, [field]: [...text.slice(0, at), ...added, ...text.slice(at)].join(""), at: at + added.length };
	}
	if (change.remove === "before") return at === 0 ? form : { ...form, [field]: [...text.slice(0, at - 1), ...text.slice(at)].join(""), at: at - 1 };
	return { ...form, [field]: [...text.slice(0, at), ...text.slice(at + 1)].join("") };
}

export function formKey(form: ChildForm, key: FormKey): FormResult {
	const { error: _error, ...clean } = form;
	const field = form.field;
	if (key === "escape") return { cancel: true };
	if (key === "submit") return submit(clean);
	if (key === "tab" || key === "down") return { form: step(clean, 1) };
	if (key === "back-tab" || key === "up") return { form: step(clean, -1) };
	if (isText(field)) {
		const length = chars(form[field]).length;
		if (typeof key === "object") return { form: edit(clean, field, { insert: key.text }) };
		if (key === "space") return { form: edit(clean, field, { insert: " " }) };
		if (key === "backspace") return { form: edit(clean, field, { remove: "before" }) };
		if (key === "delete") return { form: edit(clean, field, { remove: "after" }) };
		if (key === "left") return { form: { ...clean, at: Math.max(0, form.at - 1) } };
		if (key === "right") return { form: { ...clean, at: Math.min(length, form.at + 1) } };
		if (key === "home") return { form: { ...clean, at: 0 } };
		if (key === "end") return { form: { ...clean, at: length } };
		if (key === "enter") return { form: field === "brief" ? edit(clean, "brief", { insert: "\n" }) : step(clean, 1) };
		return { form: clean };
	}
	if (typeof key === "object") return { form: clean };
	if (field === "roles") {
		const role = form.roles[form.roleAt];
		if (key === "left" || key === "right") return { form: { ...clean, roleAt: Math.min(Math.max(0, form.roles.length - 1), Math.max(0, form.roleAt + (key === "left" ? -1 : 1))) } };
		if (key === "space" && role) return { form: { ...clean, picked: form.picked.includes(role) ? form.picked.filter((name) => name !== role) : [...form.picked, role] } };
	}
	if (field === "workspace" && (key === "left" || key === "right" || key === "space")) return { form: { ...clean, workspace: form.workspace === "shared" ? "worktree" : "shared" } };
	if (field === "create" && (key === "enter" || key === "space")) return submit(clean);
	if (key === "enter") return { form: step(clean, 1) };
	return { form: clean };
}

/** Stands for the caret while text is wrapped, so it lands on the right row. */
const CARET = "";

/** Draw the form. `height`, when given, pins the keys to the bottom. */
export function renderForm(form: ChildForm, width: number, paint: Paint = PLAIN, height?: number): string[] {
	const inner = Math.max(24, width - 2);
	const text = Math.min(inner - 2, 72);
	const out: Seg[][] = [];
	const label = (field: Field, name: string): Seg => [` ${name.padEnd(11)}`, form.field === field ? (t: string) => paint.accent(paint.bold(t)) : paint.dim];
	/** A one-line text field. While it is being edited the caret is drawn where it is, and long text scrolls to keep it in view. */
	const line = (field: TextField, placeholder = ""): Seg[] => {
		const room = Math.max(4, text - 13);
		const value = chars(form[field]);
		if (form.field !== field) return value.length === 0 ? [[placeholder, paint.dim]] : [[fit(form[field], room)]];
		const at = Math.min(value.length, Math.max(0, form.at));
		const start = Math.max(0, at - (room - 1));
		const shown = value.slice(start, start + room - 1);
		return [[shown.slice(0, at - start).join("")], ["▏", paint.accent], [shown.slice(at - start).join("")]];
	};
	out.push([[" New session", paint.bold], [` under ${fit(form.parentName, Math.max(8, inner - 20))}`, paint.dim]]);
	out.push([[""]]);
	out.push([label("name", "Name"), ...line("name")]);
	out.push([label("kind", "Kind"), ...line("kind")]);
	out.push([label("model", "Model"), ...line("model", "the default")]);

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
	const editing = form.field === "brief";
	const briefChars = chars(form.brief);
	const caretAt = Math.min(briefChars.length, Math.max(0, form.at));
	const marked = editing ? [...briefChars.slice(0, caretAt), CARET, ...briefChars.slice(caretAt)].join("") : form.brief;
	const lines = marked.split("\n").flatMap((part) => (part === "" ? [""] : wrap(part, text - 4)));
	// The rows around the caret stay in view.
	const caretRow = Math.max(0, lines.findIndex((part) => part.includes(CARET)));
	const shown = lines.slice(Math.max(0, caretRow - 7), Math.max(0, caretRow - 7) + 8);
	while (shown.length < 4) shown.push("");
	out.push([[` ╭${"─".repeat(text - 2)}╮`, border]]);
	for (const part of shown) {
		const [before, after] = part.includes(CARET) ? (part.split(CARET) as [string, string]) : [part, undefined];
		const body: Seg[] = after === undefined ? [[before]] : [[before], ["▏", paint.accent], [after]];
		out.push([[" │ ", border], ...body, [" ".repeat(Math.max(0, text - 4 - widthOf(body)))], [" │", border]]);
	}
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
						? [["←→", "move"], ["⏎", "new line"]]
						: [["←→", "move"]];
	const foot: Seg[][] = [[["─".repeat(inner + 1), paint.dim]], ...flow([...keys, ["tab", "next field"], ["ctrl+s", "create"], ["esc", "cancel"]], inner, paint)];
	const body = out.map(draw);
	if (height === undefined) return [...body, ...foot.map(draw)];
	const room = Math.max(1, height - foot.length);
	const visible = body.slice(0, room);
	return [...visible, ...Array.from({ length: room - visible.length }, () => ""), ...foot.map(draw)];
}
