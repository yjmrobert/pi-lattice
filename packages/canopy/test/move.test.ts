/** Moving over the tree with the arrows: everything is reached, the way back is the way one came, and what is selected stays in view. */
import { describe, expect, it } from "vitest";
import { type Arrow, buildWorld, type CanopyKey, type CanopyState, initial, interpret, placeOf, planOf, renderPlain, ROOT_ID } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

const W = 150;
const H = 44;
const harbor = () => buildWorld([world(HARBOR)], LEVELS);
type Harbor = ReturnType<typeof harbor>;
const ARROWS: Arrow[] = ["up", "down", "left", "right"];
const OPPOSITE: Record<Arrow, Arrow> = { up: "down", down: "up", left: "right", right: "left" };
const press = (w: Harbor, state: CanopyState, ...keys: CanopyKey[]): CanopyState => keys.reduce((at, key) => interpret(w, at, key, W, H).state, state);
/** Everything that can be selected: the items, and the helpers written under them. */
const everything = (w: Harbor): string[] => [...w.items.values()].filter((item) => item.id !== ROOT_ID && placeOf(planOf(w, initial(w), W, H), item.id)).map((item) => item.id);

describe("the arrows", () => {
	it("reach everything on the tree, helpers included", () => {
		const w = harbor();
		const start = initial(w);
		const seen = new Map<string, CanopyState>([[start.selected as string, start]]);
		const queue = [start];
		for (let at = queue.shift(); at; at = queue.shift()) {
			for (const key of ARROWS) {
				// Each move is tried from a fresh arrival, so nothing is reached only by retracing.
				const next = press(w, { ...at, back: undefined as never, came: new Map() }, key);
				if (next.selected && !seen.has(next.selected)) {
					seen.set(next.selected, next);
					queue.push(next);
				}
			}
		}
		expect(everything(w).filter((id) => !seen.has(id))).toEqual([]);
		expect(seen.has("review")).toBe(true);
	});

	it("go back the way they came: a key and then its opposite is where one started", () => {
		const w = harbor();
		const failed: string[] = [];
		for (const id of everything(w)) {
			for (const key of ARROWS) {
				const moved = press(w, initial(w, id), key);
				if (moved.selected === id) continue;
				if (press(w, moved, OPPOSITE[key]).selected !== id) failed.push(`${id} ${key} → ${moved.selected} ${OPPOSITE[key]} → ${press(w, moved, OPPOSITE[key]).selected}`);
			}
		}
		expect(failed).toEqual([]);
	});

	it("retrace a path of several steps: down to the top and up again ends on the task it began on", () => {
		const w = harbor();
		for (const task of ["verify-copy", "3ds-flow", "conflicts", "review"]) {
			let at = initial(w, task);
			let steps = 0;
			for (let next = press(w, at, "down"); next.selected !== at.selected; next = press(w, at, "down")) {
				at = next;
				steps++;
			}
			expect(steps, task).toBeGreaterThan(1);
			expect(press(w, at, ...Array.from({ length: steps }, () => "up" as const)).selected, task).toBe(task);
		}
	});

	it("go along a level: left and right land on something of the same level wherever there is one on that side", () => {
		const w = harbor();
		const plan = planOf(w, initial(w), W, H);
		for (const id of everything(w)) {
			const from = placeOf(plan, id);
			if (!from || from.helper) continue;
			for (const key of ["left", "right"] as const) {
				const alike = [...plan.places.values()].filter((place) => place.item.id !== ROOT_ID && place.leaf === from.leaf && (from.leaf || place.item.level === from.item.level) && (key === "right" ? place.col > from.col : place.col < from.col));
				const to = placeOf(plan, press(w, initial(w, id), key).selected);
				if (alike.length === 0) continue;
				expect(to?.leaf, `${id} ${key} → ${to?.item.name}`).toBe(from.leaf);
				if (!from.leaf) expect(to?.item.level, `${id} ${key} → ${to?.item.name}`).toBe(from.item.level);
			}
		}
	});

	it("do nothing only at an edge of the tree", () => {
		const w = harbor();
		const plan = planOf(w, initial(w), W, H);
		const cols = [...plan.places.values()].filter((place) => place.item.id !== ROOT_ID).map((place) => place.col);
		for (const id of everything(w)) {
			const from = placeOf(plan, id);
			if (!from) continue;
			const stuck = ARROWS.filter((key) => press(w, initial(w, id), key).selected === id);
			for (const key of stuck) {
				const item = from.item;
				const edge =
					key === "left" ? (from.helper ? placeOf(plan, item.parent?.id)?.col : from.col) === Math.min(...cols)
					: key === "right" ? (from.helper ? placeOf(plan, item.parent?.id)?.col : from.col) === Math.max(...cols)
					: key === "down" ? (from.helper ? item.parent?.parent?.id : item.parent?.id) === ROOT_ID
					: from.helper ? false : from.leaf ? true : item.children.length === 0;
				expect(edge, `${key} does nothing on ${id}`).toBe(true);
			}
		}
	});

	it("read through an item's helpers on the way down, and back up to it", () => {
		const w = harbor();
		const at = initial(w, "export");
		expect(press(w, at, "down").selected).toBe("review");
		expect(press(w, at, "down", "up").selected).toBe("export");
		expect(press(w, at, "down", "down").selected).toBe("invoices");
		// Across, a helper is where the item it helps is.
		expect(press(w, initial(w, "review"), "right").selected).toBe(press(w, at, "right").selected);
		// It is pointed at like anything else, and the path at the top leads to it.
		const drawn = renderPlain(w, initial(w, "review"), W, H).join("\n");
		expect(drawn).toContain("▸review");
	});

	it.each([[150, 44], [100, 30], [80, 24], [60, 20]])("keep what is selected in the window, whatever is pressed, at %i by %i", (cols, rows) => {
		const w = harbor();
		// A fixed run of keys, different at every step: the same walk every time the test runs.
		let seed = 42;
		const random = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
		const keys: CanopyKey[] = ["up", "down", "left", "right", "up", "down", "left", "right", "tab", ".", "f", "a", "o", "r"];
		let state = interpret(w, initial(w), "right", cols, rows).state;
		for (let step = 0; step < 1500; step++) {
			const key = keys[Math.floor(random() * keys.length)] as CanopyKey;
			state = interpret(w, state, key, cols, rows).state;
			const plan = planOf(w, state, cols, rows);
			const place = placeOf(plan, state.selected);
			expect(place, `after ${key} at step ${step}, ${state.selected} is drawn`).toBeDefined();
			if (!place) return;
			const win = { width: cols - (state.side !== "none" && cols >= 100 ? 40 : 0), height: rows - 3 };
			const [col, row] = [place.col - state.camera.col, place.row - state.camera.row];
			expect(col >= 0 && col < win.width && row >= 0 && row < win.height, `after ${key} at step ${step}, ${state.selected} is at ${col},${row} of a window ${win.width} by ${win.height}`).toBe(true);
		}
	});
});

describe("going to something by its name", () => {
	it("goes to the first item that matches as it is typed, and on to the next with tab", () => {
		const w = harbor();
		const typing = press(w, initial(w, "tables"), "/", "c", "a");
		expect(typing.typing).toMatchObject({ what: "find", text: "ca" });
		// Names that start with it come before names that only have it in them.
		expect(typing.selected).toBe("cards");
		const names = [typing, press(w, typing, "tab"), press(w, typing, "tab", "tab")].map((state) => state.selected);
		expect(new Set(names).size).toBe(3);
		for (const name of names) expect(name).toContain("ca");
		expect(renderPlain(w, typing, W, H).at(-1)).toMatch(/go to: ca▏.*⏎\s+stay here.*tab\s+next.*esc\s+back/);
		// Letters are the name, not keys: f does not fold.
		expect(press(w, initial(w, "tables"), "/", "f").folded.size).toBe(0);
	});

	it("stays where it went with enter, and is back where it started with escape", () => {
		const w = harbor();
		const typing = press(w, initial(w, "tables"), "/", "o", "i", "d");
		expect(typing.selected).toBe("oidc");
		const stayed = press(w, typing, "enter");
		expect([stayed.selected, stayed.typing]).toEqual(["oidc", undefined]);
		const back = press(w, typing, "escape");
		expect([back.selected, back.typing]).toEqual(["tables", undefined]);
		// Nothing matches: it stays on the last thing found, and deleting the letters brings the start back.
		expect(press(w, typing, "z", "z").selected).toBe("oidc");
		expect(press(w, typing, "backspace", "backspace", "backspace").selected).toBe("tables");
	});
});
