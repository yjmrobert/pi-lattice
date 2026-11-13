/** What comes first: the order of the tree, what is held, and how both are drawn. */
import { describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, type CanopyState, canStart, initial, interpret, layout, paint, planOf, renderPlain } from "../src/index.ts";
import { LEVELS, world } from "./fixture.ts";

/**
 * Filed the wrong way round on purpose. `pack` waits on `pay`, which was filed after it; a task in
 * `later` waits on one in `first`; and the tasks of `pay` are filed in no order at all.
 */
const SHOP: Parameters<typeof world>[0] = [
	["later", "epic", "plan", [
		["ship", "feature", "plan", [
			["pack", "story", "wait:pay", [["box", "task", "plan"], ["label", "task", "plan"]]],
			["pay", "story", "plan", [["charge", "task", "worker run"], ["receipt", "task", "worker wait:charge"], ["form", "task", "worker done"], ["icon", "task", "plan"]]],
		]],
		["returns", "feature", "plan", [["refund", "story", "plan", [["undo", "task", "worker wait:signup"]]]]],
	]],
	["first", "epic", "plan", [["accounts", "feature", "plan", [["join", "story", "plan", [["signup", "task", "worker run"]]]]]]],
];
const shop = () => buildWorld([world(SHOP)], LEVELS);
const names = (w: ReturnType<typeof shop>, id: string): string[] => (w.flow.ordered.get(id) ?? []).map((item) => item.name);
const W = 150;
const H = 44;
const press = (w: ReturnType<typeof shop>, state: CanopyState, ...keys: CanopyKey[]): CanopyState => keys.reduce((at, key) => interpret(w, at, key, W, H).state, state);

describe("what comes first", () => {
	it("puts an item after the sibling it waits on", () => {
		const w = shop();
		expect(names(w, "ship")).toEqual(["pay", "pack"]);
		expect(w.items.get("ship")?.children.map((item) => item.name)).toEqual(["pack", "pay"]);
	});

	it("puts everything an item is under after what it waits on in another branch", () => {
		const w = shop();
		// `undo`, in `later`, waits on `signup`, in `first`.
		expect(names(w, w.root.id)).toEqual(["first", "later"]);
	});

	it("where nothing says, reads finished, started, not started, held", () => {
		expect(names(shop(), "pay")).toEqual(["form", "charge", "icon", "receipt"]);
	});

	it("knows what is held, what waits behind an item, and what is there to be taken", () => {
		const w = shop();
		// A held story holds its tasks.
		expect([...w.flow.held].sort()).toEqual(["box", "label", "pack", "receipt", "undo"]);
		expect(w.flow.behind.get("pay")?.map((item) => item.name)).toEqual(["pack"]);
		expect([...w.items.values()].filter((item) => canStart(w.flow, item)).map((item) => item.name)).toEqual(["icon"]);
	});

	it("still draws two items that wait on each other", () => {
		const w = buildWorld([world([["e", "epic", "plan", [["a", "feature", "wait:b"], ["b", "feature", "wait:a"]]]])], LEVELS);
		expect(names(w, "e")).toEqual(["a", "b"]);
		expect(layout(w).places.has("b")).toBe(true);
	});
});

describe("the tree in order", () => {
	it("has what comes first on the left, and at the bottom of a frond", () => {
		const w = shop();
		const plan = layout(w);
		const at = (id: string) => plan.places.get(id) as { col: number; row: number };
		expect(at("first").col).toBeLessThan(at("later").col);
		expect(at("pay").col).toBeLessThan(at("pack").col);
		expect(["form", "charge", "icon", "receipt"].map((id) => at(id).row)).toEqual([...["form", "charge", "icon", "receipt"].map((id) => at(id).row)].sort((a, b) => b - a));
		expect(at("form").row).toBeGreaterThan(at("receipt").row);
	});

	it("is as it was filed when asked", () => {
		const w = shop();
		const plan = layout(w, { order: "filed" });
		const at = (id: string) => plan.places.get(id) as { col: number; row: number };
		expect(at("later").col).toBeLessThan(at("first").col);
		expect(at("pack").col).toBeLessThan(at("pay").col);
		// Filed, a frond is listed downward as before.
		expect(at("charge").row).toBeLessThan(at("receipt").row);
		expect(plan.follows.size).toBe(0);
	});

	it("marks an item that waits on the one before it, and draws no arc between the two", () => {
		const w = shop();
		const plan = layout(w);
		expect(plan.follows.get("pack")?.name).toBe("pay");
		const text = paint(w, plan).plain().join("\n");
		expect(text).toMatch(/›.. pack/);
		expect(text).toContain("pay ⧗1");
		// Filed, the same wait is an arc: more dots.
		const dots = (lines: string[]): number => lines.join("").replace(/[^⠁-⣿]/g, "").length;
		const filed = buildWorld([world([["e", "epic", "plan", [["a", "feature", "plan"], ["b", "feature", "wait:a"]]]])], LEVELS);
		expect(dots(paint(filed, layout(filed, { order: "filed" })).plain())).toBeGreaterThan(dots(paint(filed, layout(filed)).plain()));
	});

	it("draws what is held with nobody on it as held", () => {
		const text = paint(shop(), layout(shop())).plain().join("\n");
		expect(text).toContain("⧗ box");
		expect(text).toContain("○ icon");
	});
});

describe("the screen, in order", () => {
	it("says how the tree is ordered and how much of it can go ahead", () => {
		const w = shop();
		expect(renderPlain(w, initial(w, "pay"), W, H)[1]).toMatch(/first to last · 1 can start · ⧗4 held$/);
		expect(renderPlain(w, press(w, initial(w, "pay"), "o"), W, H)[1]).toMatch(/as filed · 1 can start · ⧗4 held$/);
	});

	it("switches between the two orders with o", () => {
		const w = shop();
		const filed = press(w, initial(w, "pay"), "o");
		expect(filed.order).toBe("filed");
		expect(planOf(w, filed).places.get("pack")?.col).toBeLessThan(planOf(w, filed).places.get("pay")?.col as number);
		expect(press(w, filed, "o").order).toBe("dependency");
	});

	it("jumps to the next thing that is there to be taken", () => {
		const w = shop();
		expect(press(w, initial(w, "pay"), ".").selected).toBe("icon");
		const busy = buildWorld([world([["e", "epic", "coordinator run"]])], LEVELS);
		expect(interpret(busy, initial(busy), ".", W, H).actions).toEqual([{ do: "say", text: "Nothing is there to be taken: everything is started, finished or held." }]);
	});

	it("lists what waits behind an item, and what is under it first to last", () => {
		const w = shop();
		const text = renderPlain(w, initial(w, "pay"), W, H).join("\n");
		expect(text).toMatch(/WAITING BEHIND IT[^\n]*\n[^\n]*⧗ pack +beside it/);
		expect(text).toContain("UNDER IT, FIRST TO LAST");
		expect(text.indexOf("✓ form")).toBeLessThan(text.lastIndexOf("icon"));
		expect(text).toMatch(/icon +can start/);
		const held = renderPlain(w, initial(w, "pack"), W, H).join("\n");
		expect(held).toMatch(/⧗ box +held/);
	});
});
