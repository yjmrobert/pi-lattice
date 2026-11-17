/** The tree drawn in to fit the window on it: a small project is seen whole, without scrolling. */
import { describe, expect, it } from "vitest";
import { buildWorld, chipOf, cut, initial, layout, planOf, renderPlain } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

type Spec = Parameters<typeof world>[0][number];

/** One epic, two features, three stories, six tasks: a week of one person's work. */
const SMALL: Spec[] = [
	["checkout", "epic", "coordinator run", [
		["payments", "feature", "planner run", [
			["cards", "story", "plan", [["card-form", "task", "worker done"], ["3ds-flow", "task", "worker run"]]],
			["webhooks", "story", "plan", [["listener", "task", "worker run"], ["retries", "task", "plan"]]],
		]],
		["cart", "feature", "plan", [["totals", "story", "plan", [["endpoint", "task", "worker done"], ["cache", "task", "plan"]]]]],
	]],
];
/** Two epics, five features, eight stories, twenty tasks. */
const MEDIUM: Spec[] = [
	["checkout", "epic", "coordinator run", [
		["payments", "feature", "planner run", [
			["cards", "story", "plan", [["card-form", "task", "worker done"], ["3ds-flow", "task", "worker run"], ["vault", "task", "plan"]]],
			["webhooks", "story", "plan", [["listener", "task", "worker run"], ["retries", "task", "plan"]]],
		]],
		["cart", "feature", "plan", [
			["totals", "story", "plan", [["endpoint", "task", "worker done"], ["cache", "task", "plan"], ["docs", "task", "plan"]]],
			["offline", "story", "plan", [["store", "task", "plan"], ["sync", "task", "plan"]]],
		]],
		["receipts", "feature", "plan", [["email", "story", "plan", [["template", "task", "plan"], ["send", "task", "plan"], ["bounce", "task", "plan"]]]]],
	]],
	["accounts", "epic", "plan", [
		["sign-in", "feature", "plan", [["oidc", "story", "plan", [["claims", "task", "plan"], ["logout", "task", "plan"]]], ["sessions", "story", "plan", [["cookie", "task", "plan"], ["expiry", "task", "plan"]]]]],
		["profile", "feature", "plan", [["avatar", "story", "plan", [["upload", "task", "plan"], ["crop", "task", "plan"], ["cdn", "task", "plan"]]]]],
	]],
];

const build = (specs: Spec[]) => buildWorld([world(specs)], LEVELS);
/** The window on the tree at a terminal size, as the screen has it: two rows of header, one of keys, and the panel beside it where there is room. */
const windowAt = (cols: number, rows: number, panel = true): { width: number; height: number } => ({ width: cols - (panel && cols >= 100 ? 40 : 0), height: rows - 3 });

describe("the tree, in the room there is", () => {
	it.each([
		["a small project", SMALL, 80, 24],
		["a small project", SMALL, 100, 30],
		["a small project", SMALL, 120, 36],
		["a small project", SMALL, 160, 45],
		["a larger one", MEDIUM, 200, 50],
		["a larger one, with the panel closed", MEDIUM, 160, 40],
	] as const)("shows %s whole in a terminal of %i columns", (name, specs, cols, rows) => {
		const w = build([...specs]);
		const state = { ...initial(w), ...(name.includes("panel closed") ? { side: "none" as const } : {}) };
		const plan = planOf(w, state, cols, rows);
		const room = windowAt(cols, rows, state.side !== "none");
		expect({ width: plan.width <= room.width, height: plan.height <= room.height }, `a tree of ${plan.width} by ${plan.height} in ${room.width} by ${room.height}`).toEqual({ width: true, height: true });
		// Every item's name is on the screen as it is first drawn: nothing has to be scrolled to.
		const drawn = renderPlain(w, state, cols, rows).join("\n");
		for (const item of w.items.values()) if (item.level >= 0) expect(drawn, item.name).toContain(cut(item.name, plan.nameMax));
	});

	it("is the size it likes to be while that fits", () => {
		const w = build(SMALL);
		const roomy = layout(w);
		const plan = planOf(w, initial(w), 200, 55);
		expect([plan.width, plan.height, plan.band, plan.nameMax]).toEqual([roomy.width, roomy.height, 9, 24]);
	});

	it("brings its levels closer before it shortens a name, and shortens names only when that makes it fit", () => {
		const w = build(SMALL);
		const tight = planOf(w, initial(w), 80, 24);
		expect(tight.band).toBeLessThan(9);
		expect(tight.nameMax).toBe(24);
		// Too wide whatever is done: the names stay whole, since it is scrolled either way.
		const harbor = build(HARBOR);
		expect(planOf(harbor, initial(harbor), 100, 30).nameMax).toBe(24);
		const long = build([["an-epic-with-a-long-name", "epic", "plan", [["a-feature-with-a-long-name", "feature", "plan"], ["another-feature-long-name", "feature", "plan"], ["a-third-feature-long-name", "feature", "plan"]]]]);
		const short = planOf(long, { ...initial(long), side: "none" }, 60, 20);
		expect(short.nameMax).toBeLessThan(24);
		expect(short.width).toBeLessThanOrEqual(60);
		expect(renderPlain(long, { ...initial(long), side: "none" }, 60, 20).join("\n")).toContain(cut("another-feature-long-name", short.nameMax));
	});

	it("gives the tree the room the panel had when the panel is closed", () => {
		const w = build(MEDIUM);
		const open = planOf(w, initial(w), 160, 40);
		const closed = planOf(w, { ...initial(w), side: "none" }, 160, 40);
		expect(open.width).toBeGreaterThan(120);
		expect(closed.width).toBeLessThanOrEqual(160);
	});

	it.each([[80, 24], [100, 30], [120, 36], [160, 45], [220, 60]])("keeps every item above what it belongs to, and no two labels on the same cells, at %i by %i", (cols, rows) => {
		for (const specs of [SMALL, MEDIUM, HARBOR]) {
			for (const shape of ["grown", "ruled"] as const) {
				const w = build(specs);
				const plan = layout(w, { shape, room: windowAt(cols, rows) });
				const taken = new Map<string, string>();
				const claim = (col: number, row: number, length: number, who: string): void => {
					for (let at = 0; at < length; at++) {
						const key = `${col + at},${row}`;
						expect(taken.get(key), `${who} and ${taken.get(key)} share a cell (band ${plan.band})`).toBeUndefined();
						taken.set(key, who);
					}
				};
				for (const place of plan.places.values()) {
					const item = place.item;
					if (item.level < 0) continue;
					const parent = item.parent ? plan.places.get(item.parent.id) : undefined;
					if (parent && !item.parent?.buds.includes(item)) expect(place.row, `${item.name} is above ${parent.item.name}`).toBeLessThan(parent.row);
					claim(place.col, place.row, 2 + [...cut(item.name, plan.nameMax)].length, item.name);
					if (place.leaf) continue;
					// Under the name: who is on it and how far along it is, then the helpers.
					const chip = chipOf(item);
					const chipLength = [chip.agent ? chip.agent.length + 2 : 0, chip.progress.length, chip.owner.length].filter((length) => length > 0).reduce((sum, length) => sum + length + 3, -3);
					if (chipLength > 0) claim(place.col + 2, place.row + 1, chipLength, `${item.name}'s second line`);
					item.buds.slice(0, 2).forEach((bud, index) => claim(place.col + 2, place.row + 2 + index, 4 + [...cut(bud.name, 16)].length, `${item.name}'s helper`));
				}
				expect(Math.min(...[...plan.places.values()].map((place) => place.row))).toBeGreaterThanOrEqual(0);
			}
		}
	});
});
