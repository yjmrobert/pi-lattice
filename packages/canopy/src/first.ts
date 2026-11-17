/**
 * The canopy before there is a tree (ADR 0035): where a first message would start one, the canopy
 * says so and takes that message itself, typed or pasted, instead of Pi opening on the chat.
 * Everything here is a function of what is typed and the size: no Pi.
 */
import { Grid, type Style } from "./grid.ts";
import { spin } from "./paint.ts";
import { COLOR } from "./palette.ts";

/** A key as the first message sees it. Anything that is not one of these is text, pasted text included. */
export type FirstKey = "enter" | "newline" | "backspace" | "escape" | { text: string };

/** What a key does to the message being written: the message as it is now, and the message to send, if it was sent. */
export function firstKey(draft: string, key: FirstKey): { draft: string; send?: string } {
	if (key === "escape") return { draft: "" };
	if (key === "backspace") return { draft: [...draft].slice(0, -1).join("") };
	if (key === "newline") return { draft: `${draft}\n` };
	if (key === "enter") {
		// Its lines are kept as they were written: a brief pasted in is sent as it was pasted.
		const send = draft.replace(/^\s*\n/, "").trimEnd();
		return send.trim() === "" ? { draft } : { draft: "", send };
	}
	return { draft: draft + key.text.replace(/\t/g, "  ") };
}

export interface FirstScreen {
	/** The repository the tree will be in. */
	repo: string;
	/** What is typed so far. */
	draft: string;
	/** What was sent, while the tree is being started with it. */
	sent?: string;
	/** The keys that lead out of the canopy, from the layout it is in. */
	leave?: ReadonlyArray<readonly [string, string]>;
	/** Whether the keyboard is somewhere else: the session's chat is open over the canopy. */
	away?: boolean;
	/** How bright everything is, from 0 to 1. */
	dim?: number;
}

// Read from the palette each time they are used: it may be a dark one now and a light one later.
const DIM: Style = { get fg() { return COLOR.dim; } };
const KEYCAP: Style = { get fg() { return COLOR.bright; }, get bg() { return COLOR.keycap; } };
/** The widest the box is, however wide the terminal: a line longer than this is not read as one. */
const BOX_MOST = 96;

function run(grid: Grid, col: number, row: number, parts: Array<[text: string, style?: Style]>): number {
	let at = col;
	for (const [text, style] of parts) {
		grid.text(at, row, text, style ?? { fg: COLOR.text });
		at += [...text].length;
	}
	return at;
}

/** A message as rows of at most `width` cells: its own lines kept, each wrapped at spaces where it can be. */
export function wrapMessage(text: string, width: number): string[] {
	const rows: string[] = [];
	for (const line of text.split("\n")) {
		let rest = [...line];
		if (rest.length === 0) rows.push("");
		while (rest.length > 0) {
			if (rest.length <= width) {
				rows.push(rest.join(""));
				break;
			}
			const space = rest.slice(0, width + 1).lastIndexOf(" ");
			const cut = space > 0 ? space : width;
			rows.push(rest.slice(0, cut).join(""));
			rest = rest.slice(space > 0 ? cut + 1 : cut);
		}
	}
	return rows;
}

const centre = (grid: Grid, row: number, parts: Array<[text: string, style?: Style]>): void => {
	const long = parts.reduce((sum, [text]) => sum + [...text].length, 0);
	run(grid, Math.max(1, Math.floor((grid.width - long) / 2)), row, parts);
};

/** The screen as terminal lines, exactly `height` of them and `width` cells wide. */
export function renderFirst(screen: FirstScreen, width: number, height: number, tick = 0): string[] {
	const grid = new Grid(width, height);
	const starting = screen.sent !== undefined;
	run(grid, 1, 0, [["◆ ", { fg: COLOR.root }], [screen.repo, { fg: COLOR.root, bold: true }]]);
	run(grid, 1, 1, [["no tree here yet", DIM]]);

	const boxWidth = Math.max(24, Math.min(BOX_MOST, width - 4));
	const inner = boxWidth - 4;
	const message = starting ? (screen.sent ?? "") : screen.draft;
	const rows = message === "" ? [] : wrapMessage(message, inner - 1);
	// The box grows with what is written, up to what leaves the hint above it room; past that it shows the end, where the cursor is.
	const most = Math.max(3, Math.min(14, height - 13));
	const shown = rows.slice(-most);
	const tall = Math.max(3, shown.length);
	const top = Math.max(3, Math.floor((height - 1 - (tall + 2) - 5) / 2) + 4);
	const left = Math.max(1, Math.floor((width - boxWidth) / 2));

	if (starting) {
		centre(grid, top - 3, [[`${spin(tick)} `, { fg: COLOR.root }], ["Starting the tree with your message…", { fg: COLOR.bright, bold: true }]]);
		centre(grid, top - 2, [["It is drawn here as soon as there is a session in it.", DIM]]);
	} else {
		centre(grid, top - 3, [["Your first message starts the tree.", { fg: COLOR.bright, bold: true }]]);
		centre(grid, top - 2, [["Say what you want built. A session takes it, and the work grows from here.", DIM]]);
	}

	const edge: Style = starting || screen.away ? { fg: COLOR.faint } : { fg: COLOR.root, level: 0.7 };
	const title = ` to a new session in ${screen.repo} `;
	const across = Math.max(0, boxWidth - 3 - [...title].length);
	run(grid, left, top, [["╭─", edge], [title, starting ? DIM : { fg: COLOR.text }], [`${"─".repeat(across)}╮`, edge]]);
	for (let index = 0; index < tall; index++) {
		const row = top + 1 + index;
		run(grid, left, row, [["│", edge]]);
		run(grid, left + boxWidth - 1, row, [["│", edge]]);
		const text = shown[index];
		if (text === undefined) continue;
		const last = index === shown.length - 1;
		run(grid, left + 2, row, [[text, starting ? DIM : { fg: COLOR.bright }], [last && !starting && !screen.away ? "▏" : "", { fg: COLOR.root }]]);
	}
	if (rows.length === 0 && !starting && !screen.away) run(grid, left + 2, top + 1, [["▏", { fg: COLOR.root }], ["type or paste it here", { fg: COLOR.faint }]]);
	const count = rows.length > 1 ? ` ${rows.length} lines${rows.length > shown.length ? `, the last ${shown.length} shown` : ""} ` : "";
	const under = Math.max(0, boxWidth - 3 - [...count].length);
	run(grid, left, top + tall + 1, [[`╰${"─".repeat(under)}`, edge], [count, DIM], ["─╯", edge]]);

	const keys: Array<[string, string]> = [];
	if (!starting && !screen.away) keys.push(["⏎", "start the tree"], ["shift+⏎", "new line"], ["esc", "clear"]);
	keys.push(...(screen.leave ?? []).map(([key, does]): [string, string] => [key, does]));
	let at = 1;
	for (const [key, does] of keys) {
		if (at + key.length + does.length + 4 > width) break;
		at = run(grid, at, height - 1, [[` ${key} `, KEYCAP], [` ${does}   `, DIM]]);
	}
	return grid.lines(0, 0, width, height, screen.dim ?? 1);
}
