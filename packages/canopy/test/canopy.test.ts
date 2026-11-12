import { describe, expect, it } from "vitest";
import { buildWorld, Grid, type Item, layout, paint, pathTo, ROOT_ID, roleOf, walk } from "../src/index.ts";
import { colorOf, letterOf, PEOPLE } from "../src/palette.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

const harbor = () => buildWorld([world(HARBOR)], LEVELS);
const get = (w: ReturnType<typeof harbor>, id: string): Item => w.items.get(id) as Item;

describe("the work, from the state a host gives", () => {
	it("puts each item on the level its kind names, under the network", () => {
		const w = harbor();
		expect(w.root).toMatchObject({ id: ROOT_ID, name: "harbor", level: -1 });
		expect(w.root.children.map((item) => item.name)).toEqual(["checkout-v2", "pricing-migration", "sso-rollout"]);
		expect(get(w, "payments")).toMatchObject({ level: 1, owner: "yan" });
		expect(get(w, "copy")).toMatchObject({ level: 3 });
		expect(pathTo(get(w, "copy")).map((item) => item.name)).toEqual(["copy", "tables", "new-tables", "pricing-migration", "harbor"]);
	});

	it("says who sits on an item, and that nobody does on a planned one", () => {
		const w = harbor();
		expect(get(w, "checkout-v2").agent).toMatchObject({ role: "coordinator", state: "working" });
		expect(get(w, "webhooks").agent).toMatchObject({ role: "reviewer", state: "asking" });
		expect(get(w, "e2e").agent).toMatchObject({ state: "waiting" });
		expect(get(w, "cards")).toMatchObject({ planned: true, agent: undefined });
		expect(roleOf({ fragments: ["protocol", "reporting"], name: "checkout" })).toBe("checkout");
	});

	it("counts progress at the tips", () => {
		const w = harbor();
		expect(get(w, "totals-api")).toMatchObject({ leaves: 3, landed: 3 });
		expect(get(w, "checkout-v2")).toMatchObject({ leaves: 15, landed: 6 });
		expect(get(w, "card-vault")).toMatchObject({ leaves: 1, landed: 1 });
	});

	it("hangs a helper on the item it serves, and does not count it as work", () => {
		const w = harbor();
		// `review` is of kind verify, which is not a level.
		expect(get(w, "export").buds.map((bud) => bud.name)).toEqual(["review"]);
		expect(get(w, "export").children.map((item) => item.name)).toEqual(["csv", "pdf", "fixtures"]);
		expect(get(w, "export")).toMatchObject({ leaves: 3, landed: 2 });
		expect(walk(get(w, "export")).map((item) => item.name)).toEqual(["export", "review", "csv", "pdf", "fixtures"]);
	});

	it("treats a root whose kind is not a level as the top, and what cannot be deeper as a helper", () => {
		const w = buildWorld([world([["shop", "session", "run", [["a", "task", "run", [["b", "task", "run"]]], ["c", "grilling", "idle"]]]])], LEVELS);
		expect(get(w, "shop").level).toBe(0);
		expect(get(w, "a").level).toBe(3);
		// A task under a task is not a deeper level: it helps.
		expect(get(w, "a").buds.map((bud) => bud.name)).toEqual(["b"]);
		expect(get(w, "shop").buds.map((bud) => bud.name)).toEqual(["c"]);
	});

	it("lists the people, the person looking first, with what each has going", () => {
		const w = harbor();
		expect(w.people.map((person) => person.name)).toEqual(["yan", "mira", "sam", "teo"]);
		expect(w.people.find((person) => person.name === "sam")).toMatchObject({ working: 4, asking: 1, online: true });
		expect(w.people.find((person) => person.name === "teo")).toMatchObject({ online: false, owned: 4 });
		expect(get(w, "offline").away).toBe(true);
	});

	it("carries what a session is working on, when it is not its own item", () => {
		const w = buildWorld([world(HARBOR, "yan", { focus: { "checkout-v2": { nodeId: "webhooks", at: 5 } } })], LEVELS);
		expect(get(w, "checkout-v2").agent).toMatchObject({ focus: "webhooks", focusAt: 5 });
		expect(get(w, "payments").agent?.focus).toBeUndefined();
	});
});

describe("colour", () => {
	it("gives each person one hue, none of them amber, red or the root's", () => {
		const w = harbor();
		const hues = w.people.map((person) => colorOf(w, person.name));
		expect(new Set(hues).size).toBe(4);
		for (const reserved of ["#e8b755", "#f0717b", "#e06bd0"]) expect(PEOPLE).not.toContain(reserved);
	});

	it("tells people apart by a letter when colour cannot", () => {
		const w = buildWorld([world([["a", "epic", "@sam run"], ["b", "epic", "@sara run"], ["c", "epic", "@stu run"]], "yan")], LEVELS);
		expect(["sam", "sara", "stu"].map((name) => letterOf(w, name))).toEqual(["s", "a", "t"]);
	});
});

describe("the grid", () => {
	it("lights braille dots, two across and four down in a cell", () => {
		const grid = new Grid(3, 2);
		grid.plot(0, 0);
		grid.plot(1, 3);
		grid.plot(2, 4);
		expect(grid.plain()).toEqual(["⢁", " ⠁"]);
	});

	it("lets text hide the dots behind it, and drops what falls outside", () => {
		const grid = new Grid(4, 1);
		grid.plot(2, 1);
		grid.text(1, 0, "ab");
		grid.text(3, 0, "xyz");
		grid.plot(99, 99);
		expect(grid.plain()).toEqual([" abx"]);
		expect(grid.taken(1, 0)).toBe(true);
	});

	it("writes a colour once for each run of cells that share it", () => {
		const grid = new Grid(6, 1);
		grid.text(0, 0, "aaa", { fg: "#ff0000" });
		grid.text(3, 0, "bb", { fg: "#00ff00", bold: true });
		expect(grid.lines()).toEqual(["\x1b[38;2;255;0;0maaa\x1b[0m\x1b[1;38;2;0;255;0mbb \x1b[0m"]);
		expect(grid.lines(1, 0, 2, 1)).toEqual(["\x1b[38;2;255;0;0maa\x1b[0m"]);
	});
});

describe("the layout", () => {
	it("keeps every item above its parent, and no two labels on the same cells", () => {
		for (const shape of ["grown", "ruled"] as const) {
			const w = harbor();
			const plan = layout(w, { shape });
			const seen = new Map<string, string>();
			for (const place of plan.places.values()) {
				const parent = place.item.parent ? plan.places.get(place.item.parent.id) : undefined;
				if (parent && place.item.level >= 0 && !place.item.parent?.buds.includes(place.item)) expect(place.row, `${place.item.name} is above ${parent.item.name}`).toBeLessThan(parent.row);
				if (place.item.level < 0) continue;
				for (let i = 0; i < [...place.item.name].length; i++) {
					const key = `${place.col + 2 + i},${place.row}`;
					expect(seen.get(key), `${place.item.name} and ${seen.get(key)} share a cell`).toBeUndefined();
					seen.set(key, place.item.name);
				}
			}
			expect(plan.width).toBeGreaterThan(100);
		}
	});

	it("draws the same tree the same way every time", () => {
		const once = paint(harbor(), layout(harbor())).plain();
		expect(paint(harbor(), layout(harbor())).plain()).toEqual(once);
	});

	it("folds an item to one node", () => {
		const w = harbor();
		const plan = layout(w, { folded: new Set(["checkout-v2"]) });
		expect(plan.places.has("payments")).toBe(false);
		expect(plan.places.has("checkout-v2")).toBe(true);
		expect(plan.width).toBeLessThan(layout(w).width);
	});

	it("cuts a long name and keeps the rest of the label", () => {
		const w = buildWorld([world([["a-very-long-name-for-an-epic-that-goes-on", "epic", "coordinator run"]])], LEVELS);
		expect(paint(w, layout(w)).plain().join("\n")).toContain("◉ a-very-long-name-for-an…");
	});
});

describe("the canopy, as text", () => {
	it("is a tree with every level on its own row when ruled", async () => {
		const w = harbor();
		await expect(`${paint(w, layout(w, { shape: "ruled" }), { selected: "tables" }).plain().join("\n")}\n`).toMatchFileSnapshot("./snapshots/harbor-ruled.txt");
	});

	it("is grown, by default: levels are bands, and bigger branches reach further", async () => {
		const w = harbor();
		await expect(`${paint(w, layout(w), { selected: "tables" }).plain().join("\n")}\n`).toMatchFileSnapshot("./snapshots/harbor-grown.txt");
	});

	it("ties an agent to the item it is working on", () => {
		const still = harbor();
		const tied = buildWorld([world(HARBOR, "yan", { focus: { "checkout-v2": { nodeId: "webhooks", at: 5 } } })], LEVELS);
		const count = (lines: string[]): number => lines.join("").replace(/[^⠁-⣿]/g, "").length;
		expect(count(paint(tied, layout(tied)).plain())).toBeGreaterThan(count(paint(still, layout(still)).plain()));
	});

	it("shows who an item belongs to where that changes, and letters on request", () => {
		const w = harbor();
		const text = paint(w, layout(w), { letters: true }).plain().join("\n");
		expect(text).toContain("planned · 1/3 · @teo");
		expect(text).toContain("coordinator · 3/10 · @sam");
		// Without a change of owner there is no name, so the letter is what says whose it is.
		expect(text).toMatch(/planner · 2\/9 · y/);
	});
});
