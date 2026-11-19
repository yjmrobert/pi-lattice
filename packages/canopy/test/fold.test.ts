/**
 * A tree too wide for its window folds around this person's work. What is folded is one line
 * that says what is in it, so nothing that needs someone goes out of sight; what a person folds
 * or opens stays as they left it; and a tree of thousands of items is drawn in the time of a frame.
 */
import { describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, type CanopyState, type Fold, initial, interpret, type Item, layout, paint, placeOf, planOf, render, renderPlain, rollup, ROOT_ID, walk } from "../src/index.ts";
import { HARBOR, LEVELS, large, world } from "./fixture.ts";

const W = 150;
const H = 44;
const harbor = () => buildWorld([world(HARBOR)], LEVELS);
type World = ReturnType<typeof harbor>;
type Spec = [name: string, kind: string, how: string, kids?: Spec[]];
const press = (w: World, state: CanopyState, ...keys: CanopyKey[]): CanopyState => keys.reduce((at, key) => interpret(w, at, key, W, H).state, state);
const screen = (w: World, state: CanopyState, cols = W, rows = H): string => renderPlain(w, state, cols, rows).join("\n");
/** The room beside the panel on a screen this wide. */
const room = (cols: number, rows: number) => ({ width: cols - 40, height: rows - 3 });
const drawn = (w: World, state: CanopyState, id: string, cols = W, rows = H): boolean => placeOf(planOf(w, state, cols, rows), id) !== undefined;
/** A test of how long something takes. Not put to mutants (ADR 0047): the code that switches them on is slow, and a slow answer is not a wrong one. */
const timed = it.skipIf(process.env.LATTICE_TEST_MUTANTS !== undefined);

describe("a tree too wide for its window", () => {
	it("is drawn whole while it fits, and folded only as far as it takes to fit", () => {
		const w = harbor();
		const whole = layout(w, { room: { width: 240, height: 60 } });
		expect(whole.fold).toBe("whole");
		expect(whole.folded.size).toBe(0);
		// Beside the panel on a screen 150 wide there are 110 columns, and all of it is 213: it folds, and fits.
		const beside = layout(w, { room: room(150, 44) });
		expect(beside.fold).toBe("yours");
		expect(beside.width).toBeLessThanOrEqual(110);
		// On a small screen too.
		expect(layout(w, { room: room(120, 36) }).width).toBeLessThanOrEqual(80);
		// With no room given it is the size it likes to be: nothing is folded for a window there is not.
		expect(layout(w).fold).toBe("whole");
	});

	it("folds what is finished before anything else", () => {
		// Two features: one all landed, one this person is working in. A little too wide for the room.
		const w = buildWorld([world([["shop", "epic", "coordinator run", [
			["shipped", "feature", "plan", [["a", "story", "plan", [["a1", "task", "worker done"], ["a2", "task", "worker done"]]], ["b", "story", "plan", [["b1", "task", "worker done"]]]]],
			["doing", "feature", "plan", [["c", "story", "plan", [["c1", "task", "worker run"], ["c2", "task", "plan"]]], ["d", "story", "@sam plan", [["d1", "task", "plan"]]]]],
		]]])], LEVELS);
		// Narrower and narrower: each step folds more, and the first thing to go is what is finished.
		const steps: Array<{ fold: Fold; width: number }> = [];
		for (let width = layout(w).width; width > 20; width--) {
			const fold = layout(w, { room: { width, height: 60 } }).fold;
			if (steps.at(-1)?.fold !== fold) steps.push({ fold, width });
		}
		expect(steps.map((step) => step.fold)).toEqual(["whole", "unfinished", "yours", "here"]);
		const plan = layout(w, { room: { width: steps[1]?.width ?? 0, height: 60 } });
		expect(plan.places.get("shipped")?.leaf).toBe(true);
		expect(plan.places.has("a")).toBe(false);
		// What is not finished is all still there, a teammate's too.
		for (const id of ["doing", "c", "c1", "c2", "d", "d1"]) expect(plan.places.has(id), id).toBe(true);
	});

	it("stays open around this person's work, with everything else one line each", () => {
		const w = harbor();
		const plan = planOf(w, initial(w), W, H);
		// The way to each of yan's sessions is open: the tasks they run are drawn.
		for (const id of ["checkout-v2", "payments", "cards", "3ds-flow", "webhooks", "stripe-listen", "retry-queue"]) expect(plan.places.has(id), id).toBe(true);
		// A teammate's epic is a line, and what is under it is not drawn.
		for (const id of ["pricing-migration", "sso-rollout"]) expect(plan.places.get(id)?.leaf, id).toBe(true);
		for (const id of ["new-tables", "tables", "sign-on", "oidc"]) expect(plan.places.has(id), id).toBe(false);
		// So is a feature of yan's own with none of their sessions in it.
		expect(plan.places.get("cart")?.leaf).toBe(true);
		const text = screen(w, initial(w));
		expect(text).toContain("⠋ pricing-migration 3/10 ●1 s");
		expect(text).toContain("⠋ sso-rollout 2/6 m");
		expect(text).toContain("○ cart 4/6 ●1");
	});

	it("gives up this person's other work before where they are, when even that is too wide", () => {
		// Sessions in two epics; the one open in this Pi is in the second. With room for one of them, that is the one.
		const spec = (name: string): Spec => [name, "epic", "coordinator run", [[`${name}-feature`, "feature", "plan", [[`${name}-story`, "story", "planner run", [[`${name}-task-one`, "task", "worker run"], [`${name}-task-two`, "task", "plan"]]]]]]];
		const source = world([spec("first"), spec("second")]);
		const w = buildWorld([{ ...source, state: { ...source.state, foreground: ["second-story"] } }], LEVELS);
		expect(layout(w, { room: { width: 200, height: 60 } }).fold).toBe("whole");
		const narrow = layout(w, { room: { width: 34, height: 60 } });
		expect(narrow.fold).toBe("here");
		expect(narrow.places.has("second-task-one")).toBe(true);
		expect(narrow.places.get("first")?.leaf).toBe(true);
	});

	it("keeps folded what a person folded and open what they opened, whatever the room", () => {
		const w = harbor();
		// Opened by hand, a teammate's epic stays open while the rest is folded to fit: one level of it, the next still folded.
		const opened = press(w, { ...initial(w), selected: "pricing-migration" }, "f");
		expect(opened.opened.has("pricing-migration")).toBe(true);
		const plan = planOf(w, opened, W, H);
		expect(plan.places.get("pricing-migration")?.leaf).toBe(false);
		expect(plan.places.get("new-tables")?.leaf).toBe(true);
		expect(plan.places.get("invoices")?.leaf).toBe(true);
		expect(plan.places.has("tables")).toBe(false);
		// Enter opens the next level, as f does.
		expect(drawn(w, press(w, opened, "up", "enter"), "export") || drawn(w, press(w, opened, "up", "enter"), "tables")).toBe(true);
		// Folded by hand, this person's own work stays folded although the way to it would be open.
		const shut = press(w, { ...initial(w), selected: "payments" }, "f");
		expect(shut.folded.has("payments")).toBe(true);
		expect(planOf(w, shut, W, H).places.get("payments")?.leaf).toBe(true);
		expect(drawn(w, shut, "webhooks")).toBe(false);
		// And on a screen with room for everything too.
		expect(planOf(w, shut, 300, 60).places.get("payments")?.leaf).toBe(true);
		// f again opens it, and it is this person's doing either way: it is in one of the two, never both.
		const again = press(w, shut, "f");
		expect([again.folded.has("payments"), again.opened.has("payments")]).toEqual([false, true]);
		expect(drawn(w, again, "webhooks")).toBe(true);
	});

	it("says what the keys do to what is selected: unfold on a folded line, fold on what is open", () => {
		const w = harbor();
		expect(screen(w, { ...initial(w), selected: "pricing-migration" }).split("\n").at(-1)).toMatch(/⏎ {2}unfold/);
		expect(screen(w, { ...initial(w), selected: "pricing-migration" }).split("\n").at(-1)).not.toMatch(/f {2}fold/);
		expect(screen(w, { ...initial(w), selected: "payments" }).split("\n").at(-1)).toMatch(/f {2}fold/);
		expect(screen(w, { ...initial(w), selected: "pricing-migration" })).toContain("UNDER IT (folded)");
	});

	it("selects the line something is folded into when it is folded away", () => {
		const w = harbor();
		// With room for everything, tables is selected; on a narrower screen it is inside sam's epic, which is one line.
		const state: CanopyState = { ...initial(w), selected: "tables" };
		expect(screen(w, state, 300, 60)).toContain("▸tables");
		expect(screen(w, state)).toContain("▸pricing-migration");
		// A key acts on what is seen selected: up from that line is the line over it.
		expect(press(w, state, "up").selected).toBe("sso-rollout");
		// Closing the panel gives room, opening it takes it away: what is selected is always something drawn.
		let at = press(w, { ...initial(w), side: "none", selected: "checkout-v2" }, "right");
		for (const key of ["a", "a", "a", "a"] as const) {
			at = press(w, at, key);
			expect(drawn(w, at, at.selected as string), `${at.side}: ${at.selected}`).toBe(true);
		}
	});
});

describe("looking at a teammate", () => {
	it("opens the tree around their work, and folds one's own", () => {
		const w = harbor();
		expect(w.people.map((person) => person.name)).toEqual(["yan", "mira", "sam", "teo"]);
		const mira = press(w, initial(w), "2");
		expect(mira.spotlight).toBe("mira");
		const plan = planOf(w, mira, W, H);
		// The way to each of mira's sessions is open, down to the tasks they run.
		for (const id of ["sso-rollout", "sign-on", "oidc", "provider", "sessions", "store"]) expect(plan.places.has(id), id).toBe(true);
		// yan's epic is a line now: it is where the eye was, and it is still selected.
		expect(plan.places.get("checkout-v2")?.leaf).toBe(true);
		expect(plan.places.has("webhooks")).toBe(false);
		expect(mira.selected).toBe("checkout-v2");
		expect(screen(w, mira)).toContain("⠋▸checkout-v2 6/15 ●3 y");
		// 0, or their number again, is back to one's own.
		for (const key of ["0", "2"] as const) {
			const back = press(w, mira, key);
			expect(back.spotlight).toBeUndefined();
			expect(planOf(w, back, W, H).places.has("webhooks")).toBe(true);
			expect(planOf(w, back, W, H).places.get("sso-rollout")?.leaf).toBe(true);
		}
		// What this person opened stays open under any of it.
		const kept = press(w, { ...initial(w), selected: "pricing-migration" }, "f", "2");
		expect(planOf(w, kept, W, H).places.get("pricing-migration")?.leaf).toBe(false);
	});

	it("changes nothing of a tree that is all on the screen but the colours", () => {
		const w = harbor();
		const before = planOf(w, initial(w), 300, 60);
		const after = planOf(w, press(w, initial(w), "2"), 300, 60);
		expect(after.fold).toBe("whole");
		expect([...after.places.keys()]).toEqual([...before.places.keys()]);
	});
});

describe("lines on a branch", () => {
	it("puts a frond on the branch to the one thing open over an item, at no cost in width", () => {
		const w = harbor();
		const plan = planOf(w, initial(w), W, H);
		// The other epics are read up the branch from the root to yan's: under it, in its column.
		const [root, epic] = [plan.places.get(ROOT_ID), plan.places.get("checkout-v2")];
		expect(plan.trunks.has(ROOT_ID)).toBe(true);
		expect(epic?.col).toBe(root?.col);
		for (const id of ["pricing-migration", "sso-rollout"]) {
			const line = plan.places.get(id);
			expect(line?.col).toBe((root?.col ?? 0) + 2);
			expect(line?.row).toBeGreaterThan(epic?.row ?? 0);
			expect(line?.row).toBeLessThan(root?.row ?? 0);
		}
		// With several things open over an item, its frond is a column beside them, level with them.
		const opened = planOf(w, { ...initial(w), opened: new Set(["pricing-migration", "new-tables"]) }, W, H);
		expect(opened.trunks.has(ROOT_ID)).toBe(false);
		expect(opened.places.get("sso-rollout")?.col).toBeLessThan(opened.places.get("pricing-migration")?.col ?? 0);
	});

	it("raises what is over a long frond, so that it is never written over", () => {
		// Nine stories folded under a feature with one open: more lines than there are rows between two levels.
		const stories = Array.from({ length: 10 }, (_unused, n): Spec => [`story-${n}`, "story", "plan", [[`task-${n}`, "task", n === 0 ? "worker run" : "plan"]]]);
		const w = buildWorld([world([["epic", "epic", "coordinator run", [["feature", "feature", "plan", stories]]]])], LEVELS);
		const plan = layout(w, { folded: new Set(stories.slice(1).map(([name]) => name)) });
		const [feature, open] = [plan.places.get("feature"), plan.places.get("story-0")];
		expect(plan.trunks.has("feature")).toBe(true);
		expect(open?.col).toBe(feature?.col);
		const rows = stories.slice(1).map(([name]) => plan.places.get(name)?.row ?? 0);
		expect(new Set(rows).size).toBe(9);
		// Every line is between the feature and the story, clear of both.
		expect(Math.max(...rows)).toBeLessThan(feature?.row ?? 0);
		expect(Math.min(...rows)).toBeGreaterThan((open?.row ?? 0) + 1);
		// Every line is written in full on the screen.
		const text = renderPlain(w, { ...initial(w), folded: new Set(stories.slice(1).map(([name]) => name)), side: "none" }, 120, 60).join("\n");
		for (const [name] of stories.slice(1)) expect(text).toContain(`○ ${name} 0/1`);
	});

	it("reads them with the arrows on the way up and on the way down", () => {
		const w = harbor();
		const at = { ...initial(w), selected: "checkout-v2" };
		// Down from the epic: the lines on the branch under it, nearest first, and no further than the last.
		expect(press(w, at, "down").selected).toBe("sso-rollout");
		expect(press(w, at, "down", "down").selected).toBe("pricing-migration");
		expect(press(w, at, "down", "down", "down").selected).toBe("pricing-migration");
		// And up again, through them, to the epic.
		expect(press(w, { ...at, selected: "pricing-migration" }, "up").selected).toBe("sso-rollout");
		expect(press(w, { ...at, selected: "pricing-migration" }, "up", "up").selected).toBe("checkout-v2");
		// Up from an item with lines on the branch over it is its first line: nothing drawn is skipped.
		expect(press(w, at, "up").selected).toBe("cart");
		expect(press(w, at, "up", "up").selected).toBe("payments");
		expect(press(w, at, "up", "up", "down", "down").selected).toBe("checkout-v2");
	});
});

describe("what needs someone", () => {
	const asks = (item: Item): number => (item.asks > 0 ? item.asks : item.agent?.state === "asking" ? 1 : 0);

	it("is never out of sight: a folded line counts everything in it that asks", () => {
		for (const specs of [HARBOR, large(5, 4, 4, 5), large(8, 5, 6, 8)]) {
			const w = buildWorld([world(specs)], LEVELS);
			for (const [cols, rows] of [[100, 30], [120, 36], [150, 44], [200, 60]] as const) {
				for (const spotlight of [undefined, w.people[1]?.name]) {
					const state: CanopyState = { ...initial(w), spotlight };
					const plan = planOf(w, state, cols, rows);
					// All of the tree as it is laid out for that screen, not only what is in the window.
					const text = paint(w, plan, spotlight ? { spotlight } : {}).plain().join("\n");
					for (const item of walk(w.root)) {
						if (item.level < 0 || asks(item) === 0) continue;
						// It is drawn itself, or it is in a line that is, and that line says so.
						let at: Item | undefined = item;
						while (at && !placeOf(plan, at.id)) at = at.parent;
						expect(at, `${item.name} at ${cols}x${rows}`).toBeDefined();
						if (!at || at === item || !plan.folded.has(at.id)) continue;
						const under = walk(at).reduce((sum, other) => sum + asks(other), 0);
						expect(rollup(at).asks).toBe(under);
						expect(text, `${at.name} at ${cols}x${rows}`).toMatch(new RegExp(` ${at.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+/\\d+ ●${under}( |$)`, "m"));
					}
				}
			}
		}
	});

	it("is gone to with tab: this person's first, and a folded line for what is in it", () => {
		const w = harbor();
		const seen = [1, 2, 3, 4, 5, 6].map((n) => press(w, initial(w, "payments"), ...Array.from({ length: n }, () => "tab" as const)).selected);
		// yan's own, then the lines with someone else's in them: teo's in cart, sam's in the epic that is folded.
		expect(seen).toEqual(["webhooks", "stripe-listen", "cart", "pricing-migration", "webhooks", "stripe-listen"]);
		// Opened, the line gives way to what asks in it.
		const opened = press(w, { ...initial(w), selected: "pricing-migration" }, "enter", "tab", "tab", "tab", "tab");
		expect(opened.selected).toBe("invoices");
	});

	it("is counted at the edge of the window when it is out of view, folded or not", () => {
		const w = buildWorld([world(large(8, 5, 6, 8))], LEVELS);
		// Wider than a small screen even folded: the lines of the other epics are off to one side, each with something that asks.
		const text = screen(w, initial(w), 100, 30);
		expect(text).toMatch(/◀\d|\d▶|\d▲|\d▼/);
	});
});

describe("a large tree", () => {
	const build = (epics: number, features: number, stories: number, tasks: number) => buildWorld([world(large(epics, features, stories, tasks))], LEVELS);

	it("of five hundred items is all on a small screen, beside the panel", () => {
		const w = build(5, 4, 4, 5);
		expect(w.items.size - 1).toBe(505);
		expect(layout(w).width).toBeGreaterThan(1500);
		for (const [cols, rows] of [[100, 30], [120, 36], [180, 44]] as const) {
			const plan = planOf(w, initial(w), cols, rows);
			expect(plan.width, `${cols}x${rows}`).toBeLessThanOrEqual(cols - 40);
			// Every epic is on it, and the task that asks this person.
			for (const epic of w.root.children) expect(plan.places.has(epic.id), epic.name).toBe(true);
			expect(plan.places.has("task-0-0-0-0")).toBe(true);
		}
	});

	it("of two thousand is a screen or two wide where it was fifty", () => {
		const w = build(8, 5, 6, 8);
		expect(w.items.size - 1).toBe(2208);
		expect(layout(w).width).toBeGreaterThan(4000);
		expect(planOf(w, initial(w), 180, 44).width).toBeLessThanOrEqual(140);
		expect(planOf(w, initial(w), 120, 36).width).toBeLessThanOrEqual(100);
	});

	timed("is drawn in the time of a frame, the work read and laid out anew each time", () => {
		const source = world(large(8, 5, 6, 8));
		const state = initial(buildWorld([source], LEVELS));
		// As the extension does it: the world is built from what the host says, then drawn.
		const frame = (): void => {
			render(buildWorld([source], LEVELS), state, 180, 44, 3);
		};
		for (let warm = 0; warm < 3; warm++) frame();
		const times: number[] = [];
		for (let n = 0; n < 9; n++) {
			const start = performance.now();
			frame();
			times.push(performance.now() - start);
		}
		// Thirty frames a second leaves 33 ms. The middle one of nine: a machine busy with other tests stalls now and then.
		const median = times.sort((a, b) => a - b)[4] as number;
		expect(median).toBeLessThan(33);
	});

	timed("takes a key in less time than a person notices", () => {
		const w = build(8, 5, 6, 8);
		let state = interpret(w, initial(w), "right", 180, 44).state;
		const start = performance.now();
		const keys: CanopyKey[] = ["up", "up", "left", "down", "right", "tab", "down", "f", "f", "up"];
		for (let n = 0; n < 50; n++) state = interpret(w, state, keys[n % keys.length] as CanopyKey, 180, 44).state;
		expect((performance.now() - start) / 50).toBeLessThan(20);
		expect(placeOf(planOf(w, state, 180, 44), state.selected)).toBeDefined();
	});
});
