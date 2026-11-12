/**
 * A grid of terminal cells with a finer grid of braille dots under it: two dots across and
 * four down in every cell. Text is written into cells; branches are plotted as dots; a cell
 * that holds text hides the dots behind it. No Pi, no terminal.
 */

export interface Style {
	/** Colour as #rrggbb. */
	fg?: string;
	bg?: string;
	bold?: boolean;
	/** Brightness from 0 to 1. Colour is scaled by it, so a dim branch keeps its hue. */
	level?: number;
}

interface Cell {
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

const scale = (hex: string, level: number): [number, number, number] => {
	const value = Number.parseInt(hex.slice(1), 16);
	const k = Math.max(0, Math.min(1, level));
	return [Math.round(((value >> 16) & 255) * k), Math.round(((value >> 8) & 255) * k), Math.round((value & 255) * k)];
};

const sgr = (style: Style): string => {
	const parts: string[] = [];
	if (style.bold) parts.push("1");
	if (style.fg) parts.push(`38;2;${scale(style.fg, style.level ?? 1).join(";")}`);
	if (style.bg) parts.push(`48;2;${scale(style.bg, 1).join(";")}`);
	return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
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

	/** Write text starting at a cell. One character a cell; what falls outside the grid is dropped. */
	text(col: number, row: number, text: string, style: Style = {}): void {
		let at = Math.round(col);
		for (const char of text) {
			const cell = this.at(at++, Math.round(row));
			if (cell) {
				cell.text = char;
				cell.style = style;
			}
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

	/** The characters of a window on the grid, with no colour: what a test compares. */
	plain(col = 0, row = 0, width = this.width, height = this.height): string[] {
		return Array.from({ length: height }, (_unused, r) => {
			let line = "";
			for (let c = 0; c < width; c++) {
				const cell = this.at(col + c, row + r);
				line += cell?.text ?? (cell && cell.dots > 0 ? String.fromCodePoint(0x2800 + cell.dots) : " ");
			}
			return line.trimEnd();
		});
	}

	/** A window on the grid as terminal lines. Colour is written once for each run of cells that share it. */
	lines(col = 0, row = 0, width = this.width, height = this.height): string[] {
		return Array.from({ length: height }, (_unused, r) => {
			let line = "";
			let open = "";
			for (let c = 0; c < width; c++) {
				const cell = this.at(col + c, row + r);
				const text = cell?.text ?? (cell && cell.dots > 0 ? String.fromCodePoint(0x2800 + cell.dots) : " ");
				// A blank carries on whatever colour is open, unless it has a background of its own to draw or to end.
				const code = cell?.text !== undefined ? sgr(cell.style) : cell && cell.dots > 0 ? sgr(cell.dotStyle) : open.includes("48;2") ? "" : open;
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
