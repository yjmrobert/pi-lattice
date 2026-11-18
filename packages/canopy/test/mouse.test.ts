/** The mouse: a click selects what is under it, a second click does what enter does, the wheel moves the window, and nothing else is taken. */
import { describe, expect, it } from "vitest";
import { anchorOf, type Asking, buildWorld, type CanopyState, initial, interpret, interpretMouse, itemAt, MOUSE, placed, placeOf, planOf, renderPlain, ROOT_ID } from "../src/index.ts";
import { allOpen, HARBOR, LEVELS, world } from "./fixture.ts";

const W = 150;
const H = 44;
const harbor = () => buildWorld([world(HARBOR)], LEVELS);
type Harbor = ReturnType<typeof harbor>;
/** With everything opened by hand: the whole tree, wider than the window. */
const whole = (w: Harbor, id?: string): CanopyState => ({ ...initial(w, id), opened: allOpen(w.items.values()) });
/** Everything that can be selected: the items, and the helpers written under them. */
const everything = (w: Harbor): string[] => [...w.items.values()].filter((item) => item.id !== ROOT_ID && placeOf(planOf(w, whole(w), W, H), item.id)).map((item) => item.id);
/** The state with its window on what is selected, and the cell that is drawn in. */
const shown = (w: Harbor, id: string, width = W, height = H): { state: CanopyState; col: number; row: number } => {
	const state = placed(w, whole(w, id), width, height);
	return { state, ...(anchorOf(w, state, width, height) as { col: number; row: number }) };
};
/** The cell something starts in where it is written on the tree: under the two rows at the top, which name what is selected. */
const written = (lines: string[], text: string): { x: number; y: number } => {
	const y = lines.findIndex((line, row) => row >= 2 && line.includes(text));
	return { x: [...(lines[y] as string).slice(0, (lines[y] as string).indexOf(text))].length, y };
};
const click = (x: number, y: number, count = 1) => ({ type: "click", x, y, count }) as const;

describe("a click", () => {
	it("selects what is under it: every item on the tree, and every helper, by its node and by its name", () => {
		const w = harbor();
		const missed: string[] = [];
		for (const id of everything(w)) {
			const { state, col, row } = shown(w, id);
			const other = everything(w).find((candidate) => candidate !== id) as string;
			for (const x of [col, col + 2, col + 3]) {
				// From the same window with something else selected: the click is what selects it.
				const next = interpretMouse(w, { ...state, selected: other }, click(x, row), W, H);
				if (next?.state.selected !== id || next.actions.length > 0) missed.push(`${id} at ${x},${row} → ${next?.state.selected}`);
			}
		}
		expect(missed).toEqual([]);
	});

	it("lands where the name is written on the screen, and on the line under it", () => {
		const w = harbor();
		const state = placed(w, initial(w, "tables"), W, H);
		const lines = renderPlain(w, state, W, H);
		for (const name of ["schema", "copy", "verify-copy", "new-tables", "checkout-v2"]) {
			const at = written(lines, ` ${name}`);
			expect(itemAt(w, state, at.x + 1, at.y, W, H), name).toBe(name);
			expect(itemAt(w, state, at.x + name.length, at.y, W, H), `the end of ${name}`).toBe(name);
			// The cell after a name is not the name.
			expect(itemAt(w, state, at.x + name.length + 1, at.y, W, H), `past ${name}`).toBeUndefined();
		}
		// Under the name of an item is who sits there and how far along it is: that is the item too.
		const under = written(lines, "planned · 1/7");
		expect(itemAt(w, state, under.x, under.y, W, H)).toBe("new-tables");
		expect(itemAt(w, state, under.x + 12, under.y, W, H)).toBe("new-tables");
		// A folded item is one line: its name and how far along what is in it is.
		const folded = written(lines, "dual-write 0/4");
		expect(itemAt(w, state, folded.x + 13, folded.y, W, H)).toBe("dual-write");
	});

	it("leaves the window where it is, and leaves no way back for an arrow to retrace", () => {
		const w = harbor();
		const { state, col, row } = shown(w, "copy");
		const from = { ...interpret(w, { ...state, selected: "schema" }, "down", W, H).state, camera: state.camera };
		expect(from.back).toBeDefined();
		const next = interpretMouse(w, from, click(col + 2, row), W, H)?.state as CanopyState;
		expect(next.selected).toBe("copy");
		expect(next.camera).toEqual(state.camera);
		expect(next.back).toBeUndefined();
		// What is drawn is the same tree with the mark moved.
		expect(renderPlain(w, next, W, H).some((line) => line.includes("▸copy"))).toBe(true);
	});

	it("is not the canopy's anywhere else: on nothing, on the top and the foot, on the panel, on the list of keys, or while a line is typed", () => {
		const w = harbor();
		const { state, col, row } = shown(w, "copy");
		const lines = renderPlain(w, state, W, H);
		// A cell of the tree with nothing in it or beside it.
		const empty = lines.findIndex((line, y) => y > 2 && y < H - 2 && line.slice(0, 12).trim() === "");
		expect(empty).toBeGreaterThan(0);
		expect(interpretMouse(w, state, click(1, empty), W, H)).toBeUndefined();
		expect(interpretMouse(w, state, click(col + 2, 0), W, H)).toBeUndefined();
		expect(interpretMouse(w, state, click(col + 2, H - 1), W, H)).toBeUndefined();
		// The panel beside the tree names what is selected and what is under it: reading it is not pointing at it.
		expect(lines.some((line) => line.includes("│"))).toBe(true);
		for (let y = 0; y < H; y++) expect(itemAt(w, state, W - 20, y, W, H), `row ${y}`).toBeUndefined();
		expect(interpretMouse(w, { ...state, help: 0 }, click(col + 2, row), W, H)).toBeUndefined();
		const typing = interpret(w, { ...state, selected: "schema" }, "/", W, H).state;
		expect(typing.typing).toBeDefined();
		expect(interpretMouse(w, typing, click(col + 2, row), W, H)).toBeUndefined();
		// Smaller than the canopy draws in, there is nothing to point at.
		expect(interpretMouse(w, state, click(2, 2), 50, 12)).toBeUndefined();
	});

	it("is taken when the button goes down on an item, and does nothing until it is let go there", () => {
		const w = harbor();
		const { state, col, row } = shown(w, "copy");
		const from = { ...state, selected: "schema" };
		expect(interpretMouse(w, from, { type: "press", x: col + 2, y: row }, W, H)).toEqual({ state: from, actions: [] });
		expect(interpretMouse(w, from, { type: "press", x: col + 2, y: 0 }, W, H)).toBeUndefined();
	});
});

describe("a second click", () => {
	it("does what enter does on what the first selected: every item, whatever its kind", () => {
		const w = harbor();
		for (const id of everything(w)) {
			const { state, col, row } = shown(w, id);
			const twice = interpretMouse(w, state, click(col + 2, row, 2), W, H);
			const enter = interpret(w, state, "enter", W, H);
			expect(twice?.actions, id).toEqual(enter.actions);
			expect(twice?.state.selected, id).toBe(enter.state.selected);
		}
	});

	it("opens the session on an item, and unfolds a folded one", () => {
		const w = harbor();
		const { state, col, row } = shown(w, "tables");
		expect(interpretMouse(w, state, click(col + 2, row, 2), W, H)?.actions).toEqual([{ do: "open", id: "tables", tree: (w.items.get("tables") as { tree: string }).tree }]);
		const folded = placed(w, { ...interpret(w, state, "f", W, H).state, framed: false }, W, H);
		const at = anchorOf(w, folded, W, H) as { col: number; row: number };
		expect(planOf(w, folded, W, H).folded.has("tables")).toBe(true);
		const unfolded = interpretMouse(w, folded, click(at.col + 2, at.row, 2), W, H)?.state as CanopyState;
		expect(planOf(w, unfolded, W, H).folded.has("tables")).toBe(false);
	});

	it("on something not yet selected only selects it: the window moved, or the tree did, between the two", () => {
		const w = harbor();
		const { state, col, row } = shown(w, "copy");
		const next = interpretMouse(w, { ...state, selected: "schema" }, click(col + 2, row, 2), W, H);
		expect([next?.state.selected, next?.actions]).toEqual(["copy", []]);
	});

	it("never answers what the session asks, even where enter would", () => {
		const w = harbor();
		const { state, col, row } = shown(w, "tables");
		const asking: Asking = { id: "ask-1", title: "Send it?", text: "A message waits to be sent.", keys: [{ key: "enter", does: "send" }], more: 0 };
		expect(interpret(w, state, "enter", W, H, asking).actions).toEqual([{ do: "answer", id: "ask-1", key: "enter" }]);
		const at = anchorOf(w, state, W, H) as { col: number; row: number };
		expect([at.col, at.row]).toEqual([col, row]);
		const twice = interpretMouse(w, state, click(col + 2, row, 2), W, H, { animations: [], now: 0, asking } as never);
		expect(twice?.actions.map((action) => action.do)).toEqual(["open"]);
	});
});

describe("the wheel", () => {
	it("moves the window over a tree larger than it, as far as the tree goes, and sideways with alt", () => {
		const w = harbor();
		// A hundred columns by twenty-two: the panel takes forty columns, and the top and the foot three rows.
		const [cols, rows, across, down] = [100, 22, 60, 19];
		const state = placed(w, whole(w, "tables"), cols, rows);
		const plan = planOf(w, state, cols, rows);
		expect(plan.width).toBeGreaterThan(across);
		expect(plan.height).toBeGreaterThan(down);
		const turn = (from: CanopyState, by: number, sideways = false, times = 1): CanopyState => Array.from({ length: times }).reduce<CanopyState>((at) => interpretMouse(w, at, { type: "wheel", by, sideways }, cols, rows)?.state as CanopyState, from);
		let at = turn(state, -3, false, 200);
		expect(at.camera.row).toBe(0);
		at = turn(at, 3);
		expect([at.camera.row, at.camera.col]).toEqual([3, state.camera.col]);
		at = turn(at, 3, false, 200);
		expect(at.camera.row).toBe(plan.height - down);
		at = turn(at, -5, true, 200);
		expect(at.camera.col).toBe(0);
		at = turn(at, 5, true);
		expect([at.camera.col, at.camera.row]).toEqual([5, plan.height - down]);
		at = turn(at, 5, true, 200);
		expect(at.camera.col).toBe(plan.width - across);
		// What is selected is as it was: the wheel looks, it does not go anywhere.
		expect(at.selected).toBe("tables");
	});

	it("leaves a tree that fits where it is, and is still the canopy's: nothing behind it is scrolled", () => {
		const w = buildWorld([world([["shop", "epic", "coordinator idle", [["cart", "feature", "run"]]]])], LEVELS);
		const state = placed(w, initial(w, "cart"), W, H);
		expect(interpretMouse(w, state, { type: "wheel", by: 3 }, W, H)).toEqual({ state, actions: [] });
		expect(interpretMouse(w, state, { type: "wheel", by: -3, sideways: true }, W, H)).toEqual({ state, actions: [] });
	});

	it("reads on in the list of keys, which says what the mouse does", () => {
		const w = harbor();
		const open = interpret(w, placed(w, initial(w, "tables"), 80, 24), "?", 80, 24).state;
		const down = interpretMouse(w, open, { type: "wheel", by: 3 }, 80, 24)?.state as CanopyState;
		expect(down.help).toBe(3);
		expect(interpretMouse(w, down, { type: "wheel", by: -30 }, 80, 24)?.state.help).toBe(0);
		expect(interpretMouse(w, down, { type: "wheel", by: 3000 }, 80, 24)?.state.help).toBeLessThan(60);
		const list = renderPlain(w, { ...open, help: 0 }, W, 80).join("\n");
		expect(list).toContain("THE MOUSE");
		for (const [what, does] of MOUSE) expect(list).toContain(does.slice(0, 30)), expect(list).toContain(what);
	});

	it("still turns while a line is typed: looking at the tree does not lose what was written", () => {
		const w = harbor();
		const state = placed(w, whole(w, "tables"), 100, 22);
		const typing = interpret(w, interpret(w, state, "/", 100, 22).state, "c", 100, 22).state;
		expect(typing.typing?.text).toBe("c");
		const next = interpretMouse(w, typing, { type: "wheel", by: 2 }, 100, 22)?.state as CanopyState;
		expect(next.typing).toEqual(typing.typing);
		expect(next.camera.row).toBe(typing.camera.row + 2);
	});
});
