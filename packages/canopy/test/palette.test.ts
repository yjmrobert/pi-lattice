/** What the canopy is drawn in, held to what can be read: on a dark terminal and on a light one, and with no colour at all. */
import { DEFAULT_SCHEME, type Issue, type WorkState } from "@pi-lattice/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Appearance, buildWorld, COLOR, contrast, initial, MARK, PAGES, PALETTES, PEOPLE, render, renderPlain, usePalette } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

afterEach(() => usePalette("dark"));

const BOTH: Appearance[] = ["dark", "light"];

/** A board as a teammate first sees it: everything unstarted, nothing theirs. */
const board = () => {
	let next = 1;
	const issue = (title: string, type: string, parent?: number, more: Partial<Issue> = {}): Issue => ({ number: next++, rank: next, title, body: "", type, state: "todo", ...(parent !== undefined ? { parent } : {}), labels: [], fields: {}, author: "yan", createdAt: 1, updatedAt: 1, ...more }) as Issue;
	const issues = [issue("Checkout", "epic", undefined, { assignee: "yan" }), issue("Pay by card", "feature", 1), issue("Enter a card", "story", 2), issue("Card form", "task", 3), issue("Error states", "task", 3), issue("Refunds", "feature", 1)];
	const work: WorkState = { url: "https://lattice.example.com", me: "sam", connected: true, scheme: DEFAULT_SCHEME, issues, people: [{ name: "sam", online: true }, { name: "yan", online: true }], sessions: [], hosts: [], recent: [], seen: 0 };
	const source = world([], "sam", { work });
	source.state.sharing = null;
	return buildWorld([source], LEVELS);
};

interface Cell {
	char: string;
	fg: string | undefined;
	bg: string | undefined;
}

/** Every cell of coloured lines that is not blank, with the colours it is drawn in. */
function cells(lines: string[]): Cell[] {
	const hex = (parts: number[]): string => `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
	const out: Cell[] = [];
	for (const line of lines) {
		let fg: string | undefined;
		let bg: string | undefined;
		// biome-ignore lint/suspicious/noControlCharactersInRegex: reading colour
		for (const match of line.matchAll(/\x1b\[([0-9;]*)m|([\s\S])/gu)) {
			if (match[1] !== undefined) {
				const codes = match[1].split(";").map(Number);
				for (let at = 0; at < codes.length; at++) {
					if (codes[at] === 0) fg = bg = undefined;
					else if (codes[at] === 38 && codes[at + 1] === 2) fg = hex(codes.slice(at + 2, (at += 4) + 1));
					else if (codes[at] === 48 && codes[at + 1] === 2) bg = hex(codes.slice(at + 2, (at += 4) + 1));
				}
			} else if (match[2] !== " ") out.push({ char: match[2] as string, fg, bg });
		}
	}
	return out;
}

const braille = (char: string): boolean => char >= "⠀" && char <= "⣿";

describe("the colours", () => {
	it.each(BOTH)("read on a %s terminal: names, what is said about them, people, and what needs someone", (appearance) => {
		const { color, people } = PALETTES[appearance];
		for (const page of PAGES[appearance]) {
			for (const name of ["bright", "text"] as const) expect(contrast(color[name], page), `${name} on ${page}`).toBeGreaterThanOrEqual(7);
			for (const name of ["dim", "attention", "failed", "root", "wait"] as const) expect(contrast(color[name], page), `${name} on ${page}`).toBeGreaterThanOrEqual(4);
			for (const hue of people) expect(contrast(hue, page), `${hue} on ${page}`).toBeGreaterThanOrEqual(4);
			// What is selected is told from the page by its tint, and is pointed at besides.
			expect(contrast(color.select, page), `the selection on ${page}`).toBeGreaterThanOrEqual(1.8);
		}
		expect(contrast(color.bright, color.select)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(color.text, color.selectAway)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(color.bright, color.keycap)).toBeGreaterThanOrEqual(7);
		expect(contrast(color.onAttention, color.attention)).toBeGreaterThanOrEqual(4.5);
	});

	it("are one set for a dark terminal and another for a light one, with nobody given amber, red or the root's colour", () => {
		expect(COLOR.bright).toBe(PALETTES.dark.color.bright);
		usePalette("light");
		expect(COLOR.bright).toBe(PALETTES.light.color.bright);
		expect(PEOPLE).toEqual(PALETTES.light.people);
		for (const reserved of [COLOR.attention, COLOR.failed, COLOR.root]) expect(PEOPLE).not.toContain(reserved);
	});

	it.each(BOTH)("leave no word unreadable on a %s terminal, on a board where nothing is started", (appearance) => {
		usePalette(appearance);
		const w = board();
		const task = [...w.items.values()].find((item) => item.name === "Card form");
		const drawn = cells(render(w, initial(w, task?.id), 120, 36));
		for (const page of PAGES[appearance]) {
			const fallback = appearance === "dark" ? "#ffffff" : "#000000";
			const hard = drawn.filter((cell) => /[\p{L}\p{N}]/u.test(cell.char) && contrast(cell.fg ?? fallback, cell.bg ?? page) < 4);
			expect(hard.map((cell) => `${cell.char} ${cell.fg} on ${cell.bg ?? page}`), `on ${page}`).toEqual([]);
			// A branch to work nobody has started is quiet, and it is there.
			const faint = drawn.filter((cell) => braille(cell.char) && contrast(cell.fg ?? fallback, page) < 1.8);
			expect(faint.map((cell) => `${cell.fg} on ${page}`), `branches on ${page}`).toEqual([]);
		}
	});

	it("fade toward the page, not toward black, on a light terminal", () => {
		usePalette("light");
		const w = buildWorld([world(HARBOR)], LEVELS);
		const dimmed = cells(render(w, initial(w, "tables"), 150, 44, 0, { animations: [], now: 0, dim: 0.4 }));
		// Behind an open session everything is paler: nothing gets darker than the text it was.
		for (const cell of dimmed) if (cell.fg && /[\p{L}]/u.test(cell.char) && !cell.bg) expect(contrast(cell.fg, "#ffffff")).toBeLessThan(contrast(PALETTES.light.color.bright, "#ffffff"));
	});
});

describe("what is selected", () => {
	const tree = (w: ReturnType<typeof board>, id: string | undefined, away = false): string[] => renderPlain(w, { ...initial(w, id), side: "none" }, 120, 36, 0, away ? { animations: [], now: 0, away: true } : undefined).slice(2, -1);

	it("is pointed at with a mark, so it is found with no colour at all", () => {
		const w = buildWorld([world(HARBOR)], LEVELS);
		for (const name of ["tables", "copy", "payments", "review"]) {
			const rows = tree(w, name);
			expect(rows.filter((row) => row.includes(`${MARK}${name}`)), name).toHaveLength(1);
			expect(rows.join("\n").split(MARK)).toHaveLength(2);
		}
		expect(tree(w, "copy")).not.toEqual(tree(w, "schema"));
	});

	it("is still pointed at while the keyboard is in the chat", () => {
		const w = board();
		const task = [...w.items.values()].find((item) => item.name === "Card form");
		expect(tree(w, task?.id, true).join("\n")).toContain(`${MARK}Card form`);
	});

	it.each(BOTH)("is tinted behind the mark and the name, on a %s terminal", (appearance) => {
		usePalette(appearance);
		const w = board();
		const task = [...w.items.values()].find((item) => item.name === "Card form");
		const tinted = cells(render(w, { ...initial(w, task?.id), side: "none" }, 120, 36)).filter((cell) => cell.bg === COLOR.select);
		expect(tinted.map((cell) => cell.char).join("")).toBe(`${MARK}Cardform`);
		for (const cell of tinted) expect(cell.fg).toBe(COLOR.bright);
	});
});

describe("work nobody has started", () => {
	it("hangs on an unbroken line", () => {
		const w = board();
		const plan = renderPlain(w, { ...initial(w), side: "none", shape: "ruled" }, 120, 40).slice(2, -1);
		// The stem under a story's tasks, and the branch below the story: no row between two items is left empty.
		const column = (text: string): { col: number; row: number } => {
			const row = plan.findIndex((line) => line.includes(text));
			return { row, col: [...(plan[row] as string)].indexOf("○", [...(plan[row] as string)].join("").indexOf(text) - 3) };
		};
		const story = column("Enter a card");
		const feature = column("Pay by card");
		expect(feature.row).toBeGreaterThan(story.row + 2);
		for (let row = story.row + 2; row < feature.row - 1; row++) expect(braille([...(plan[row] as string)][story.col] ?? " "), `row ${row}: ${plan[row]}`).toBe(true);
	});
});
