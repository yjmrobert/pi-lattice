import { describe, expect, it } from "vitest";
import { advance, branchTo, buildWorld, durationOf, happenings, type Item, layout, paint, route, trail } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

type Spec = (typeof HARBOR)[number];
const build = (specs: Spec[], extra = {}) => buildWorld([world(specs, "yan", extra)], LEVELS);
const harbor = (extra = {}) => build(HARBOR, extra);
const get = (w: ReturnType<typeof harbor>, id: string): Item => w.items.get(id) as Item;
/** The same tree with one item's few words changed. */
const change = (name: string, how: string, specs: Spec[] = HARBOR): Spec[] => specs.map(([n, kind, was, kids]) => [n, kind, n === name ? how : was, kids ? change(name, how, kids) : undefined] as Spec);
// biome-ignore lint/suspicious/noControlCharactersInRegex: counting colour codes
const bright = (lines: string[]): number => lines.join("").split("\x1b[38;2;243;246;251m").length - 1;
const dots = (lines: string[]): number => lines.join("").replace(/[^⠁-⣿]/g, "").length;

describe("what happened between two looks", () => {
	it("is nothing when nothing changed", () => {
		expect(happenings(harbor(), harbor())).toEqual([]);
	});

	it("sees a task land, a question start, a session put on an item, and a change of hands", () => {
		expect(happenings(harbor(), build(change("3ds-flow", "worker done")))).toEqual([{ kind: "landed", id: "3ds-flow" }]);
		expect(happenings(harbor(), build(change("copy", "worker ask")))).toEqual([{ kind: "asked", id: "copy" }]);
		expect(happenings(harbor(), build(change("cards", "planner run")))).toEqual([{ kind: "seated", id: "cards" }]);
		expect(happenings(harbor(), build(change("tables", "@mira planner idle")))).toContainEqual({ kind: "handed", id: "tables", from: "sam" });
	});

	it("sees an item appear", () => {
		const more: Spec[] = [...HARBOR, ["search", "epic", "plan"]];
		expect(happenings(harbor(), build(more))).toEqual([{ kind: "planted", id: "search" }]);
	});

	it("sees each message once", () => {
		const sent = { traffic: [{ from: "copy", to: "pricing-migration", intent: "result", at: 100 }] };
		expect(happenings(harbor(), harbor(sent))).toEqual([{ kind: "message", from: "copy", to: "pricing-migration" }]);
		expect(happenings(harbor(sent), harbor(sent))).toEqual([]);
	});
});

describe("the way a message goes", () => {
	it("is up to what both are under, then down", () => {
		const w = harbor();
		expect(route(get(w, "copy"), get(w, "pricing-migration")).map((hop) => `${hop.up ? "↑" : "↓"}${hop.child.name}`)).toEqual(["↑copy", "↑tables", "↑new-tables"]);
		expect(route(get(w, "tables"), get(w, "export")).map((hop) => `${hop.up ? "↑" : "↓"}${hop.child.name}`)).toEqual(["↑tables", "↑new-tables", "↓invoices", "↓export"]);
	});

	it("follows the branches that are drawn, dot for dot", () => {
		const w = harbor();
		const plan = layout(w);
		const drawn = new Set(plan.branches.flatMap((branch) => branch.points.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`)));
		const path = trail(plan, get(w, "tables"), get(w, "export"));
		expect(path.length).toBeGreaterThan(40);
		for (const [x, y] of path) expect(drawn.has(`${Math.round(x)},${Math.round(y)}`), `${x},${y} is on a branch`).toBe(true);
		// It starts at the sender and ends at the receiver.
		const tables = plan.places.get("tables");
		const exported = plan.places.get("export");
		expect(path[0]?.[0]).toBe((tables?.col ?? 0) * 2 + 1);
		expect(path.at(-1)?.[0]).toBe((exported?.col ?? 0) * 2 + 1);
		// A leaf is reached up its stem and along its twig.
		expect(branchTo(plan, get(w, "copy")).at(-1)).toEqual([((plan.places.get("copy")?.col ?? 0) - 2) * 2 + 3, (plan.places.get("copy")?.row ?? 0) * 4 + 2]);
	});
});

describe("what is moving", () => {
	it("lasts as long as what it shows, and is dropped when it has finished", () => {
		const w = build(change("3ds-flow", "worker done"));
		const active = advance([], [{ kind: "landed", id: "3ds-flow" }, { kind: "asked", id: "copy" }], w, 1000);
		expect(active.map((animation) => animation.duration)).toEqual([600, 900]);
		expect(advance(active, [], w, 1700).map((animation) => animation.happening.kind)).toEqual(["asked"]);
		expect(advance(active, [], w, 2000)).toEqual([]);
	});

	it("carries a landing on through every item it completes", () => {
		// The last open task of totals-api's sibling: finishing everything under cart lights cart's branch too.
		const all = ["sync-engine", "conflicts"].reduce((specs, name) => change(name, "worker done", specs), HARBOR);
		const w = build(all);
		expect(get(w, "cart")).toMatchObject({ leaves: 6, landed: 6 });
		expect(durationOf({ kind: "landed", id: "conflicts" }, w)).toBe(600 * 3);
	});

	it("shows only so many messages at once", () => {
		const w = harbor();
		const burst = Array.from({ length: 20 }, () => ({ kind: "message" as const, from: "copy", to: "pricing-migration" }));
		expect(advance([], burst, w, 0)).toHaveLength(6);
	});
});

describe("how it is drawn", () => {
	it("runs a bright head along the branches for a message, on dots that were already there", () => {
		const w = harbor();
		const plan = layout(w);
		const still = paint(w, plan);
		const moving = paint(w, plan, { animations: [{ happening: { kind: "message", from: "copy", to: "pricing-migration" }, start: 0, duration: 1000 }], now: 500 });
		expect(moving.plain()).toEqual(still.plain());
		expect(bright(moving.lines())).toBeGreaterThan(bright(still.lines()));
	});

	it("grows a newly planned item out of its parent", () => {
		const w = harbor();
		const plan = layout(w);
		const grow = (t: number): number => dots(paint(w, plan, { animations: [{ happening: { kind: "planted", id: "sign-on" }, start: 0, duration: 400 }], now: t }).plain());
		expect(grow(40)).toBeLessThan(grow(200));
		expect(grow(200)).toBeLessThan(grow(400));
		expect(grow(400)).toBe(dots(paint(w, plan).plain()));
	});

	it("spreads a ring from an item that starts needing someone, and draws nothing extra once it is over", () => {
		const w = harbor();
		const plan = layout(w);
		const ring = (t: number): number => dots(paint(w, plan, { animations: [{ happening: { kind: "asked", id: "payments" }, start: 0, duration: 900 }], now: t }).plain());
		expect(ring(450)).toBeGreaterThan(dots(paint(w, plan).plain()));
	});

	it("sweeps the new owner's colour along the branch of an item that changed hands", () => {
		const w = build(change("tables", "@mira planner idle"));
		const plan = layout(w);
		// How many braille cells are drawn in sam's blue at a growing branch's strength. Colour is written once a run, so runs are walked.
		const sams = (t: number): number => {
			let cells = 0;
			for (const line of paint(w, plan, { animations: [{ happening: { kind: "handed", id: "tables", from: "sam" }, start: 0, duration: 600 }], now: t }).lines()) {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: walking colour runs
				for (const run of line.split("\x1b[").slice(1)) if (run.startsWith("38;2;76;104;158m")) cells += run.replace(/[^\u2801-\u28ff]/g, "").length;
			}
			return cells;
		};
		// Sam's blue, at a growing branch's strength, gives way as the sweep goes on.
		expect(sams(0)).toBeGreaterThan(sams(300));
		expect(sams(300)).toBeGreaterThan(sams(600));
	});
});
