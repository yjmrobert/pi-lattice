/**
 * The settings screen: every setting on one page, with the value in effect, where it comes
 * from and what it does, edited in place. It writes one of two files: this repository's or the
 * person's own. Pure: a key turns one screen state into the next, and says what to write.
 */
import { formatSetting, parseSettingInput, SETTINGS, type Setting, type SettingScope, type Settings, type SettingsFile, type SettingValue } from "@pi-lattice/protocol";
import type { FormKey } from "./form.ts";
import { draw, fit, flow, type Paint, PLAIN, type Seg, spread, wrap } from "./view.ts";

/** A row that opens something else: a role fragment or a template, edited as a file. */
export interface SettingsLink {
	section: string;
	label: string;
	/** Where the file in use comes from: built in, yours, this repository's. */
	value: string;
	help: string;
	/** The `/lattice` or `/role` command `enter` runs. */
	command: string;
}

/** Everything the screen shows that it does not own. */
export interface SettingsData {
	settings: Settings;
	files: { user: SettingsFile | undefined; repo: SettingsFile | undefined };
	paths: { user: string; repo: string | undefined };
	problems: string[];
	/** Models to step through for the model setting. Any other can still be typed. */
	models?: string[];
	links?: SettingsLink[];
}

export interface SettingsScreen {
	/** Which file a change goes to. */
	scope: SettingScope;
	/** The row the cursor is on. */
	at: number;
	/** The text being typed for the row, and where the caret is in it. */
	editing?: { text: string; at: number };
	/** What was wrong with the last thing typed. */
	error?: string;
}

/** Open the screen on this repository's file when there is one, otherwise on the person's own. */
export function newSettingsScreen(data: SettingsData): SettingsScreen {
	return { scope: data.paths.repo ? "repo" : "user", at: 0 };
}

type Row = { setting: Setting } | { link: SettingsLink };

export function settingsRows(data: SettingsData): Row[] {
	return [...SETTINGS.map((setting) => ({ setting })), ...(data.links ?? []).map((link) => ({ link }))];
}

export type SettingsResult =
	| { screen: SettingsScreen }
	| { close: true }
	/** Change a setting in a file, or clear it there with `undefined`. */
	| { screen: SettingsScreen; write: { scope: SettingScope; key: string; value: SettingValue | undefined } }
	/** Leave the screen and run a command, which opens Pi's own editor. */
	| { command: string };

const chars = (text: string): string[] => [...text];

/** The choices a setting steps through with ← and →. */
function choicesOf(setting: Setting, data: SettingsData): readonly string[] | undefined {
	if (setting.kind === "choice") return setting.choices;
	if (setting.key === "model" && (data.models?.length ?? 0) > 0) return data.models;
	return undefined;
}

export function settingsKey(screen: SettingsScreen, data: SettingsData, key: FormKey): SettingsResult {
	const { error: _error, ...clean } = screen;
	const rows = settingsRows(data);
	const row = rows[Math.min(rows.length - 1, Math.max(0, screen.at))];
	const editing = screen.editing;

	if (editing && row && "setting" in row) {
		const text = chars(editing.text);
		const at = Math.min(text.length, Math.max(0, editing.at));
		const edit = (next: string[], caret: number): SettingsResult => ({ screen: { ...clean, editing: { text: next.join(""), at: caret } } });
		if (key === "escape") return { screen: { scope: clean.scope, at: clean.at } };
		if (key === "enter" || key === "submit") {
			// An empty answer clears the setting in this file, so what is under it shows again.
			if (editing.text.trim() === "") return { screen: { scope: clean.scope, at: clean.at }, write: { scope: clean.scope, key: row.setting.key, value: undefined } };
			const parsed = parseSettingInput(row.setting.key, editing.text);
			if ("problem" in parsed) return { screen: { ...clean, editing, error: parsed.problem } };
			return { screen: { scope: clean.scope, at: clean.at }, write: { scope: clean.scope, key: row.setting.key, value: parsed.value } };
		}
		if (typeof key === "object") {
			const added = chars(key.text.replace(/\s+/g, " "));
			return edit([...text.slice(0, at), ...added, ...text.slice(at)], at + added.length);
		}
		if (key === "space") return edit([...text.slice(0, at), " ", ...text.slice(at)], at + 1);
		if (key === "backspace") return at === 0 ? { screen: { ...clean, editing } } : edit([...text.slice(0, at - 1), ...text.slice(at)], at - 1);
		if (key === "delete") return edit([...text.slice(0, at), ...text.slice(at + 1)], at);
		if (key === "left") return edit(text, Math.max(0, at - 1));
		if (key === "right") return edit(text, Math.min(text.length, at + 1));
		if (key === "home") return edit(text, 0);
		if (key === "end") return edit(text, text.length);
		return { screen: { ...clean, editing } };
	}

	const move = (delta: number): SettingsResult => ({ screen: { ...clean, at: Math.min(rows.length - 1, Math.max(0, screen.at + delta)) } });
	if (key === "escape") return { close: true };
	if (key === "up" || key === "back-tab") return move(-1);
	if (key === "down") return move(1);
	if (key === "home") return move(-rows.length);
	if (key === "end") return move(rows.length);
	if (key === "tab") return { screen: { ...clean, scope: screen.scope === "repo" || !data.paths.repo ? "user" : "repo" } };
	if (typeof key === "object") {
		if (key.text === "j") return move(1);
		if (key.text === "k") return move(-1);
		if (key.text === "q") return { close: true };
	}
	if (!row) return { screen: clean };
	if ("link" in row) return key === "enter" || key === "space" ? { command: row.link.command } : { screen: clean };

	const setting = row.setting;
	const write = (value: SettingValue | undefined): SettingResultWrite => ({ screen: clean, write: { scope: screen.scope, key: setting.key, value } });
	if (data.settings.sources[setting.key] === "env" && (key === "enter" || key === "space" || key === "left" || key === "right")) {
		return { screen: { ...clean, error: `${setting.env} is set in the environment and wins over both files. Unset it to change this here.` } };
	}
	// `x`, backspace and delete take the setting out of this file.
	if (key === "backspace" || key === "delete" || (typeof key === "object" && key.text === "x")) return write(undefined);
	const value = data.settings.values[setting.key];
	if (setting.kind === "toggle") return key === "enter" || key === "space" || key === "left" || key === "right" ? write(value !== true) : { screen: clean };
	const choices = choicesOf(setting, data);
	if (choices && (key === "left" || key === "right" || key === "space" || (key === "enter" && setting.kind === "choice"))) {
		const index = typeof value === "string" ? choices.indexOf(value) : -1;
		const next = key === "left" ? (index <= 0 ? choices.length - 1 : index - 1) : (index + 1) % choices.length;
		return write(choices[next] as string);
	}
	if (setting.kind === "number" && (key === "left" || key === "right") && typeof value === "number") {
		const next = value + (key === "left" ? -1 : 1);
		return next < (setting.min ?? Number.MIN_SAFE_INTEGER) || next > (setting.max ?? Number.MAX_SAFE_INTEGER) ? { screen: clean } : write(next);
	}
	if (key === "enter" || key === "space") {
		// Typing starts from what this file holds, or from what is in effect when it holds nothing.
		const own = (screen.scope === "repo" ? data.files.repo : data.files.user)?.values[setting.key];
		const start = own ?? value;
		const text = start === undefined ? "" : formatSetting(start);
		return { screen: { ...clean, editing: { text, at: chars(text).length } } };
	}
	return { screen: clean };
}
type SettingResultWrite = Extract<SettingsResult, { write: unknown }>;

const SOURCE: Record<string, string> = { default: "default", user: "yours", repo: "this repository", env: "environment" };

/** Draw the screen. `height`, when given, pins what the row means and the keys to the bottom, and scrolls the rows with the cursor. */
export function renderSettings(screen: SettingsScreen, data: SettingsData, width: number, paint: Paint = PLAIN, height?: number): string[] {
	const inner = Math.max(30, width - 2);
	const rows = settingsRows(data);
	const at = Math.min(rows.length - 1, Math.max(0, screen.at));
	const label = Math.max(...rows.map((row) => chars("setting" in row ? row.setting.label : row.link.label).length)) + 2;
	const tagRoom = 16;
	const valueRoom = Math.max(8, inner - label - tagRoom - 4);

	// Which file changes go to, as two tabs, with the file's path under them.
	const tab = (scope: SettingScope, words: string): Seg => [` ${words} `, screen.scope === scope ? paint.select : paint.dim];
	const head: Seg[][] = [
		[[" Settings", paint.bold], ["   changes go to ", paint.dim], ...(data.paths.repo ? [tab("repo", "this repository"), [" "] as Seg] : []), tab("user", "all your repositories")],
		[[` ${fit((screen.scope === "repo" ? data.paths.repo : data.paths.user) ?? "", inner - 1)}`, paint.dim]],
		[[""]],
	];

	const body: Seg[][] = [];
	let cursorRow = 0;
	let section = "";
	rows.forEach((row, index) => {
		const name = "setting" in row ? row.setting.section : row.link.section;
		if (name !== section) {
			if (section !== "") body.push([[""]]);
			body.push([[` ${name.toUpperCase()}`, paint.dim]]);
			section = name;
		}
		const here = index === at;
		if (here) cursorRow = body.length;
		const lead: Seg = [here ? " ▸ " : "   ", paint.accent];
		if ("link" in row) {
			body.push(spread([lead, [row.link.label.padEnd(label), here ? paint.bold : undefined]], [[fit(row.link.value, tagRoom), row.link.value === "built in" ? paint.dim : paint.accent], [" "]], inner));
			return;
		}
		const setting = row.setting;
		const source = data.settings.sources[setting.key] ?? "default";
		const value = data.settings.values[setting.key];
		let shown: Seg[];
		if (here && screen.editing) {
			const text = chars(screen.editing.text);
			const caret = Math.min(text.length, Math.max(0, screen.editing.at));
			const start = Math.max(0, caret - (valueRoom - 1));
			const visible = text.slice(start, start + valueRoom - 1);
			shown = [[visible.slice(0, caret - start).join("")], ["▏", paint.accent], [visible.slice(caret - start).join("")]];
		} else if (setting.kind === "toggle") shown = [[value === true ? "◉ on" : "○ off", value === true ? paint.accent : paint.dim]];
		else shown = [[fit(formatSetting(value), valueRoom), value === undefined || source === "default" ? paint.dim : undefined]];
		const tag: Seg[] = [[SOURCE[source] as string, source === "default" ? paint.dim : source === "env" ? paint.warn : paint.accent], [" "]];
		body.push(spread([lead, [setting.label.padEnd(label), here ? paint.bold : undefined], ...shown], tag, inner));
	});

	// What the row under the cursor is, in full.
	const detail: Seg[][] = [];
	const say = (text: string, style?: (text: string) => string): void => {
		for (const line of wrap(text, Math.min(inner - 2, 78))) detail.push([[` ${line}`, style]]);
	};
	const row = rows[at];
	if (row && "link" in row) say(row.link.help);
	else if (row) {
		const setting = row.setting;
		say(`${setting.key} · ${setting.help}`);
		say(setting.applies, paint.dim);
		const source = data.settings.sources[setting.key];
		const mine = data.files.user?.values[setting.key];
		if (source === "env") say(`${setting.env} is set in the environment and wins over both files.`, paint.warn);
		else if (source === "repo" && screen.scope === "user") say(`This repository sets its own, which wins here.${mine !== undefined ? ` Yours is ${formatSetting(mine)}.` : ""}`, paint.warn);
		else if (source === "repo" && mine !== undefined) say(`Yours is ${formatSetting(mine)}; this repository's wins here.`, paint.dim);
		else if (setting.env) say(`${setting.env} in the environment overrides it.`, paint.dim);
	}
	if (screen.error) say(screen.error, paint.warn);
	for (const problem of data.problems.slice(0, 2)) say(`! ${problem}`, paint.warn);

	const setting = row && "setting" in row ? row.setting : undefined;
	const keys: Array<readonly [string, string]> = screen.editing
		? [["⏎", "save"], ["esc", "cancel"], ["←→", "move"]]
		: [
				["↑↓", "move"],
				...(row && "link" in row
					? ([["⏎", "edit the file"]] as const)
					: setting?.kind === "toggle"
						? ([["space", "switch"]] as const)
						: setting && choicesOf(setting, data)
							? ([["←→", "choose"], ...(setting.kind === "choice" ? [] : ([["⏎", "type one"]] as const))] as const)
							: setting?.kind === "number"
								? ([["←→", "less, more"], ["⏎", "type it"]] as const)
								: ([["⏎", "edit"]] as const)),
				...(setting ? ([["x", "clear here"]] as const) : []),
				...(data.paths.repo ? ([["tab", screen.scope === "repo" ? "yours" : "this repository"]] as const) : []),
				["esc", "close"],
			];
	const rule: Seg[] = [["─".repeat(inner + 1), paint.dim]];
	const foot: Seg[][] = [rule, ...detail, rule, ...flow(keys, inner, paint)];

	const top = head.map(draw);
	const lines = body.map(draw);
	if (height === undefined) return [...top, ...lines, ...foot.map(draw)];
	const room = Math.max(3, height - top.length - foot.length);
	let shown = lines;
	if (lines.length > room) {
		const start = Math.min(Math.max(0, cursorRow - room + 3), lines.length - room);
		shown = lines.slice(start, start + room);
		if (start > 0) shown[0] = paint.dim(`   ↑ ${start} more`);
		const below = lines.length - start - room;
		if (below > 0) shown[shown.length - 1] = paint.dim(`   ↓ ${below} more`);
	}
	return [...top, ...shown, ...Array.from({ length: Math.max(0, room - shown.length) }, () => ""), ...foot.map(draw)];
}
