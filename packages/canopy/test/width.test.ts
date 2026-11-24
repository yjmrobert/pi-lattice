/** Names that are not one cell a character, and terminals without 24-bit colour: every line is as wide as it says, as Pi measures it. */
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorld, cellWidth, cells, colorOf256, contrast, cut, fit, Grid, graphemes, initial, interpret, nearest256, PAGES, PALETTES, render, renderFirst, renderPlain, sessionFrame, tail, useColorDepth, usePalette } from "../src/index.ts";
import { LEVELS, world } from "./fixture.ts";

afterEach(() => {
	useColorDepth("truecolor");
	usePalette("dark");
});

/** Names as people write them: Chinese, Japanese, Korean, emoji alone and joined, a flag, a letter with a mark on it, and full-width forms. */
const NAMES = ["结账流程重构", "支払いフロー", "결제 흐름", "🚀 launch plan", "café ☕ menu", "family 👨‍👩‍👧 plan", "🇨🇦 rollout", "résumé upload", "ＦＵＬＬ width", "fix 🐛 in ✅ flow", "naïve façade", "→ arrows ← and │ lines", "⚠️ warning", "é"];

type Spec = Parameters<typeof world>[0][number];
const AWKWARD: Spec[] = [
	[NAMES[0] as string, "epic", "coordinator run", [
		[NAMES[3] as string, "feature", "planner run", [
			[NAMES[1] as string, "story", "plan", [[NAMES[4] as string, "task", "worker run"], [NAMES[5] as string, "task", "worker ask"], [NAMES[7] as string, "task", "plan"]]],
			[NAMES[2] as string, "story", "@美咲 plan", [[NAMES[6] as string, "task", "worker done"], [NAMES[9] as string, "task", "worker run"], ["review 审查", "review", "reviewer run"]]],
		]],
		[NAMES[8] as string, "feature", "@josé plan", [[NAMES[12] as string, "story", "plan", [[NAMES[10] as string, "task", "plan"], [NAMES[11] as string, "task", "plan"]]]]],
	]],
];
const awkward = () => buildWorld([world(AWKWARD, "yan")], LEVELS);
const SIZES = [[60, 20], [80, 24], [100, 30], [120, 36], [151, 43], [200, 60]] as const;

describe("the width of what is written", () => {
	it("is what Pi measures: for names of every kind, and for every mark the canopy draws with", () => {
		for (const name of NAMES) expect(cells(name), name).toBe(visibleWidth(name));
		for (const mark of "◆●○◉⧗⚑✓✗▸◂⏎←↑↓→▏╭╮╰╯│─█░▲▼◀▶›·…⠋⣿+") expect([mark, cellWidth(mark)]).toEqual([mark, visibleWidth(mark)]);
	});

	it("draws a control character as a space: a title from someone else's agent cannot steer the terminal", () => {
		const title = "fix\u001b]0;pwned\u0007\u001b[2J\r\nlogin\u009b31m";
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this is about
		const control = /[\u0000-\u001a\u001c-\u001f\u007f-\u009f]|\u001b(?!\[[0-9;]*m)/;
		expect(cells(title)).toBe(title.length); // a cell each
		expect(fit(title, 80)).not.toMatch(control);
		expect(tail(title, 80)).not.toMatch(control);
		const grid = new Grid(40, 1);
		grid.text(0, 0, title, { fg: "#ffffff" });
		expect(grid.plain()[0]).toBe("fix ]0;pwned  [2J  login 31m");
		// The colour the canopy writes is the only escape sequence in what goes to the terminal.
		expect(grid.lines().join("\n")).not.toMatch(control);
		const hostile = buildWorld([world([[title, "epic", "coordinator run", [["a\u001b[2Jb", "task", "worker run"]]]], "yan")], LEVELS);
		for (const [width, height] of SIZES) for (const line of render(hostile, initial(hostile), width, height, 0)) expect(line).not.toMatch(control);
	});

	it("counts a letter with its marks, and an emoji made of several, as one character", () => {
		expect(graphemes("é👨‍👩‍👧🇨🇦")).toHaveLength(3);
		expect([cells("é"), cells("👨‍👩‍👧"), cells("🇨🇦"), cells("结账")]).toEqual([1, 2, 2, 4]);
	});

	it("cuts a name to cells, not characters, and never through a character", () => {
		expect(cut("结账流程重构", 8)).toBe("结账流…");
		expect(cells(cut("结账流程重构", 8))).toBeLessThanOrEqual(8);
		expect(fit("ab结", 3)).toBe("ab");
		expect(tail("结账ab", 3)).toBe("ab");
		for (const name of NAMES) for (let max = 2; max < 20; max++) expect(cells(cut(name, max)), `${name} cut to ${max}`).toBeLessThanOrEqual(max);
	});
});

describe("the grid, with characters two cells wide", () => {
	it("gives each the two cells it takes, and what follows starts after them", () => {
		const grid = new Grid(8, 1);
		grid.text(0, 0, "结a账b");
		expect(grid.plain()).toEqual(["结a账b"]);
		expect(grid.taken(1, 0)).toBe(true);
		expect(visibleWidth(grid.lines()[0] as string)).toBe(8);
	});

	it("leaves a space where half of one is written over, or would not fit", () => {
		const grid = new Grid(6, 1);
		grid.text(0, 0, "结账结");
		grid.text(1, 0, "x");
		expect(grid.plain()).toEqual([" x账结"]);
		grid.text(4, 0, "y");
		expect(grid.plain()).toEqual([" x账y"]);
		const edge = new Grid(3, 1);
		edge.text(0, 0, "ab结");
		expect(edge.plain()).toEqual(["ab"]);
		expect(visibleWidth(edge.lines()[0] as string)).toBe(3);
	});

	it("shows a space for half of one that a window on it cuts through", () => {
		const grid = new Grid(8, 1);
		grid.text(0, 0, "结账结账");
		for (const [col, width] of [[1, 4], [0, 3], [1, 3], [3, 5]] as const) expect(visibleWidth(grid.lines(col, 0, width, 1)[0] as string), `from ${col}, ${width} wide`).toBe(width);
		expect(grid.plain(1, 0, 4, 1)).toEqual([" 账"]);
	});

	it("writes a mark onto the character it belongs to", () => {
		const grid = new Grid(4, 1);
		grid.text(0, 0, "éx");
		expect(grid.plain()).toEqual(["éx"]);
	});
});

describe("the screen, with names of every kind", () => {
	it.each(SIZES)("is exactly as wide as the terminal on every line, as Pi measures it, at %i by %i", (cols, rows) => {
		const w = awkward();
		for (const item of w.items.values()) {
			if (item.level < 0) continue;
			for (const side of ["inspector", "roster", "none"] as const) {
				const lines = render(w, { ...initial(w, item.id), side }, cols, rows, 7);
				expect(lines).toHaveLength(rows);
				const off = lines.map((line, row) => [row, visibleWidth(line)] as const).filter(([, width]) => width !== cols);
				expect(off, `${item.name}, ${side}`).toEqual([]);
			}
		}
	});

	it("is as wide as the terminal while a name is typed, a line is said, the list of keys is open, and a session is open over it", () => {
		const w = awkward();
		const first = w.root.children[0]?.id;
		for (const [cols, rows] of SIZES) {
			const states = [
				["/", "结", "账"].reduce((state, key) => interpret(w, state, key, cols, rows).state, initial(w, first)),
				[" ", "先", "に", "🚀"].reduce((state, key) => interpret(w, state, key, cols, rows).state, initial(w, first)),
				interpret(w, initial(w, first), "?", cols, rows).state,
			];
			for (const state of states) for (const line of render(w, state, cols, rows, 3)) expect(visibleWidth(line)).toBe(cols);
			for (const item of w.items.values()) for (const line of sessionFrame(w, item.id, cols, rows, ["alt+l", "tree"], 3)) expect(visibleWidth(line), item.name).toBe(cols);
			for (const line of renderFirst({ repo: "结账 🚀", draft: "先に 🚀 これを\n결제 흐름을 다시 만든다 ".repeat(6) }, cols, rows, 3)) expect(visibleWidth(line)).toBe(cols);
		}
	});

	it("keeps each name whole or cut with an ellipsis, with the mark of what is selected before it", () => {
		const w = awkward();
		const drawn = renderPlain(w, { ...initial(w, "结账流程重构"), side: "none" }, 200, 60).join("\n");
		expect(drawn).toContain("▸结账流程重构");
		for (const name of NAMES.slice(0, 12)) expect(drawn, name).toContain(cut(name));
	});
});

describe("a terminal without 24-bit colour", () => {
	it("is sent the nearest of its 256 colours, and none it cannot take", () => {
		useColorDepth("256");
		const w = awkward();
		const lines = render(w, initial(w), 150, 44, 7).join("");
		expect(lines).not.toMatch(/[34]8;2;/);
		expect(lines).toMatch(/38;5;\d+/);
		expect(lines).toMatch(/48;5;\d+/);
		for (const line of render(w, initial(w), 150, 44, 7)) expect(visibleWidth(line)).toBe(150);
	});

	it.each(["dark", "light"] as const)("still reads on a %s background: names, what is said about them, and what is selected", (appearance) => {
		const { color } = PALETTES[appearance];
		const near = (hex: string): string => colorOf256(nearest256([1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]));
		for (const page of PAGES[appearance]) {
			for (const name of ["bright", "text"] as const) expect(contrast(near(color[name]), page), `${name} on ${page}`).toBeGreaterThanOrEqual(7);
			for (const name of ["dim", "attention"] as const) expect(contrast(near(color[name]), page), `${name} on ${page}`).toBeGreaterThanOrEqual(3.5);
			expect(contrast(near(color.select), page), `the selection on ${page}`).toBeGreaterThanOrEqual(1.6);
		}
		expect(contrast(near(color.bright), near(color.select))).toBeGreaterThanOrEqual(4.5);
	});

	it("finds the nearest colour in the cube and among the greys", () => {
		expect(nearest256([255, 0, 0])).toBe(196);
		expect(nearest256([0, 0, 0])).toBe(16);
		expect(nearest256([128, 128, 128])).toBe(244);
		expect(colorOf256(196)).toBe("#ff0000");
		expect(colorOf256(244)).toBe("#808080");
	});
});
