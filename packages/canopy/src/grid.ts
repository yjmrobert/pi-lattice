/**
 * A grid of terminal cells with a finer grid of braille dots under it: two dots across and
 * four down in every cell. Text is written into cells; branches are plotted as dots; a cell
 * that holds text hides the dots behind it. A character takes the cells a terminal gives it:
 * two for most of East Asia's and for emoji, none for a mark that sits on the one before.
 * No Pi, no terminal.
 */
import { printable } from "@pi-lattice/protocol";
import { COLOR, colorDepth } from "./palette.ts";

/**
 * Text that is one cell a character with nothing to work out: Latin, and the arrows, lines, blocks,
 * shapes and braille the canopy itself is drawn with. Most of what is written is this.
 */
const PLAIN = /^[\x20-\x7e\u00a1-\u02ff\u2010-\u2027\u2030-\u205e\u2190-\u2319\u231c-\u23e8\u2400-\u25fc\u2691\u2713\u2717\u2800-\u28ff\u29d7]*$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Text as the characters a person sees: a letter with the marks on it, or an emoji made of several, is one.
 * A control character is a space: much of what is drawn was written by someone else's agent, and a
 * terminal would act on an escape sequence in a title instead of drawing it.
 */
export const graphemes = (text: string): string[] => (PLAIN.test(text) ? text.split("") : Array.from(segmenter.segment(printable(text)), (part) => part.segment));

/** Whether a code point is drawn two cells wide: Hangul, kana, CJK, full-width forms, and the planes emoji and ideographs are on. */
const wide = (code: number): boolean =>
	(code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) ||
	(code >= 0xa000 && code <= 0xa4cf) || (code >= 0xa960 && code <= 0xa97f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) ||
	(code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f680 && code <= 0x1f6ff) || (code >= 0x1f900 && code <= 0x1f9ff) ||
	(code >= 0x1fa70 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);

/** The cells one character takes in a terminal: none, one or two. */
export function cellWidth(grapheme: string): 0 | 1 | 2 {
	const code = grapheme.codePointAt(0) ?? 0;
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	if (code < 0x300) return 1;
	// Only marks and joiners: it adds to the character before it, and takes no cell of its own.
	if (/^[\p{Mn}\p{Me}\p{Cf}]+$/u.test(grapheme)) return 0;
	// Drawn as emoji: by default, or because it is asked for; and flags, which are two letters drawn as one.
	if (/\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f|[\u{1f1e6}-\u{1f1ff}]/u.test(grapheme)) return 2;
	return wide(code) ? 2 : 1;
}

/** The cells a piece of text takes. */
export const cells = (text: string): number => (PLAIN.test(text) ? text.length : graphemes(text).reduce((sum: number, part) => sum + cellWidth(part), 0));

/** Text with spaces after it up to a width in cells. */
export const pad = (text: string, width: number): string => (PLAIN.test(text) ? text : printable(text)) + " ".repeat(Math.max(0, width - cells(text)));

/** As much of the start of a text as fits a width in cells. */
export function fit(text: string, width: number): string {
	if (cells(text) <= width) return PLAIN.test(text) ? text : printable(text);
	let out = "";
	let used = 0;
	for (const part of graphemes(text)) {
		const next = cellWidth(part);
		if (used + next > width) break;
		out += part;
		used += next;
	}
	return out;
}

/** The end of a text: as much of it as fits a width in cells. */
export function tail(text: string, width: number): string {
	if (cells(text) <= width) return PLAIN.test(text) ? text : printable(text);
	const parts = graphemes(text);
	let from = parts.length;
	let used = 0;
	while (from > 0 && used + cellWidth(parts[from - 1] as string) <= width) used += cellWidth(parts[--from] as string);
	return parts.slice(from).join("");
}

export interface Style {
	/** Colour as #rrggbb. */
	fg?: string;
	bg?: string;
	bold?: boolean;
	/** Brightness from 0 to 1. Less of it moves the colour toward the background, so a dim branch keeps its hue. */
	level?: number;
}

interface Cell {
	/** What is written here. Empty where the character in the cell before is two cells wide and this is its other half. */
	text: string | undefined;
	style: Style;
	dots: number;
	dotStyle: Style;
	/** Which plot wins the colour of a cell when several pass through it. */
	weight: number;
}

/** Unicode numbers a braille cell's dots down the left column, then down the right, with the bottom row last. */
const BIT = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

/** A colour at a brightness: at less than 1 it goes toward the terminal's background, dark or light. */
const scale = (hex: string, level: number): [number, number, number] => {
	const value = Number.parseInt(hex.slice(1), 16);
	const ground = Number.parseInt(COLOR.ground.slice(1), 16);
	const k = Math.max(0, Math.min(1, level));
	const mix = (shift: number): number => Math.round(((value >> shift) & 255) * k + ((ground >> shift) & 255) * (1 - k));
	return [mix(16), mix(8), mix(0)];
};

const STEPS = [0, 95, 135, 175, 215, 255];

/** The colour of the 256 a terminal without 24-bit colour has that is nearest to one: from its cube of 216, or its 24 greys. */
export function nearest256([r, g, b]: readonly [number, number, number]): number {
	const step = (value: number): number => STEPS.reduce((best, at, index) => (Math.abs(at - value) < Math.abs((STEPS[best] as number) - value) ? index : best), 0);
	const [ri, gi, bi] = [step(r), step(g), step(b)];
	const cube = [STEPS[ri] as number, STEPS[gi] as number, STEPS[bi] as number];
	const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
	const shade = 8 + grey * 10;
	const far = (to: readonly number[]): number => (to[0] as number - r) ** 2 + (to[1] as number - g) ** 2 + (to[2] as number - b) ** 2;
	return far([shade, shade, shade]) < far(cube) ? 232 + grey : 16 + 36 * ri + 6 * gi + bi;
}

/** The colour one of the 256 is, as #rrggbb, for the cube and the greys. */
export function colorOf256(index: number): string {
	const hex = (parts: number[]): string => `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
	if (index >= 232) return hex(Array.from({ length: 3 }, () => 8 + (index - 232) * 10));
	const at = index - 16;
	return hex([STEPS[Math.floor(at / 36)] as number, STEPS[Math.floor(at / 6) % 6] as number, STEPS[at % 6] as number]);
}

/** `fade` moves everything toward the background by the same share: what is behind something else is still read, and does not compete. */
const sgr = (style: Style, fade = 1): string => {
	const parts: string[] = [];
	if (style.bold && fade === 1) parts.push("1");
	const exact = colorDepth() === "truecolor";
	if (style.fg) parts.push(exact ? `38;2;${scale(style.fg, (style.level ?? 1) * fade).join(";")}` : `38;5;${nearest256(scale(style.fg, (style.level ?? 1) * fade))}`);
	if (style.bg) parts.push(exact ? `48;2;${scale(style.bg, fade).join(";")}` : `48;5;${nearest256(scale(style.bg, fade))}`);
	return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
};

/** Text in a style, as a terminal takes it. */
export const styled = (text: string, style: Style): string => {
	const code = sgr(style);
	return code === "" ? text : `${code}${text}\x1b[0m`;
};

export class Grid {
	readonly width: number;
	readonly height: number;
	private readonly cells: Cell[];

	constructor(width: number, height: number) {
		this.width = Math.max(1, Math.ceil(width));
		this.height = Math.max(1, Math.ceil(height));
		this.cells = Array.from({ length: this.width * this.height }, () => ({ text: undefined, style: {}, dots: 0, dotStyle: {}, weight: -1 }));
	}

	private at(col: number, row: number): Cell | undefined {
		return col >= 0 && row >= 0 && col < this.width && row < this.height ? this.cells[row * this.width + col] : undefined;
	}

	/** Before a cell is written over: a character two cells wide that loses one of them is gone from the other too. */
	private clear(col: number, row: number): void {
		const cell = this.at(col, row);
		if (!cell) return;
		if (cell.text === "") {
			const lead = this.at(col - 1, row);
			if (lead) lead.text = " ";
		} else if (cell.text !== undefined) {
			const half = this.at(col + 1, row);
			if (half?.text === "") half.text = " ";
		}
	}

	/** Write text starting at a cell. Each character takes the cells it is wide; what falls outside the grid is dropped. */
	text(col: number, row: number, text: string, style: Style = {}): void {
		let at = Math.round(col);
		const line = Math.round(row);
		for (const char of graphemes(text)) {
			const width = cellWidth(char);
			if (width === 0) {
				// A mark on the character before it: it is written with that character.
				const before = this.at(at - 1, line)?.text === "" ? this.at(at - 2, line) : this.at(at - 1, line);
				if (before?.text) before.text += char;
				continue;
			}
			const cell = this.at(at, line);
			if (cell) {
				this.clear(at, line);
				const half = width === 2 ? this.at(at + 1, line) : undefined;
				if (width === 2) this.clear(at + 1, line);
				// Half of a wide character does not fit at the edge: a space stands where it would have started.
				cell.text = width === 2 && !half ? " " : char;
				cell.style = style;
				if (half) {
					half.text = "";
					half.style = style;
				}
			}
			at += width;
		}
	}

	/** Whether a cell holds text. */
	taken(col: number, row: number): boolean {
		return this.at(col, row)?.text !== undefined;
	}

	/** Light one dot, in dot coordinates: twice the columns, four times the rows. The heaviest plot through a cell gives it its colour. */
	plot(x: number, y: number, style: Style = {}, weight = 0): void {
		const dx = Math.round(x);
		const dy = Math.round(y);
		const cell = this.at(dx >> 1, dy >> 2);
		if (!cell || dx < 0 || dy < 0) return;
		cell.dots |= (BIT[dy & 3] as number[])[dx & 1] as number;
		if (weight >= cell.weight) {
			cell.weight = weight;
			cell.dotStyle = style;
		}
	}

	/**
	 * What a cell of a window shows. A window may cut a character two cells wide in half, at its first
	 * column or its last: a space stands for the half that is in it, so that a line is as wide as it says.
	 */
	private shown(col: number, row: number, first: boolean, last: boolean): string {
		const cell = this.at(col, row);
		if (!cell) return " ";
		if (cell.text === "") return first ? " " : "";
		if (cell.text !== undefined) return last && this.at(col + 1, row)?.text === "" ? " " : cell.text;
		return cell.dots > 0 ? String.fromCodePoint(0x2800 + cell.dots) : " ";
	}

	/** The characters of a window on the grid, with no colour: what a test compares. */
	plain(col = 0, row = 0, width = this.width, height = this.height): string[] {
		return Array.from({ length: height }, (_unused, r) => {
			let line = "";
			for (let c = 0; c < width; c++) line += this.shown(col + c, row + r, c === 0, c === width - 1);
			return line.trimEnd();
		});
	}

	/** A window on the grid as terminal lines. Colour is written once for each run of cells that share it. */
	lines(col = 0, row = 0, width = this.width, height = this.height, fade = 1): string[] {
		return Array.from({ length: height }, (_unused, r) => {
			let line = "";
			let open = "";
			for (let c = 0; c < width; c++) {
				const cell = this.at(col + c, row + r);
				const text = this.shown(col + c, row + r, c === 0, c === width - 1);
				// A blank carries on whatever colour is open, unless it has a background of its own to draw or to end.
				const code = cell?.text !== undefined ? sgr(cell.style, fade) : cell && cell.dots > 0 ? sgr(cell.dotStyle, fade) : open.includes("48;2") ? "" : open;
				if (code !== open) {
					line += open === "" ? code : `\x1b[0m${code}`;
					open = code;
				}
				line += text;
			}
			return open === "" ? line : `${line}\x1b[0m`;
		});
	}
}
