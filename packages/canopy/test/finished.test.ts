/**
 * What is finished can be left out of what is open, so that what remains is what is read. It is
 * counted where it was, nothing that still has something in it for someone goes with it, and
 * what a person goes to by name is arrived at.
 */
import { describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, type CanopyState, finishedIn, footerKeys, initial, interpret, layout, placeOf, planOf, renderPlain, sameFolds } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

const W = 150;
const H = 44;
type Spec = [name: string, kind: string, how: string, kids?: Spec[]];
type World = ReturnType<typeof buildWorld>;
const press = (w: World, state: CanopyState, ...keys: CanopyKey[]): CanopyState => keys.reduce((at, key) => interpret(w, at, key, W, H).state, state);
const screen = (w: World, state: CanopyState): string => renderPlain(w, state, W, H).join("\n");
const drawn = (w: World, state: CanopyState, id: string): boolean => placeOf(planOf(w, state, W, H), id) !== undefined;

/** One feature: a story all landed, one under way, and one whose tasks are done with a check on the last still asking. */
const SHOP: Spec[] = [["shop", "epic", "coordinator run", [
	["feature", "feature", "plan", [
		["shipped", "story", "plan", [["a1", "task", "worker done"], ["a2", "task", "worker done"]]],
		["doing", "story", "plan", [["b1", "task", "worker done"], ["b2", "task", "worker run"], ["b3", "task", "plan"]]],
		["asked", "story", "plan", [["c1", "task", "worker done"], ["c2", "task", "worker done", [["check", "verify", "verifier ask"]]]]],
	]],
]]];
const shop = (): World => buildWorld([world(SHOP)], LEVELS);

describe("what is finished", () => {
	it("is left out of what is open with d, counted after the name of what it was under, and drawn again with d", () => {
		const w = shop();
		const whole = initial(w, "doing");
		for (const id of ["shipped", "a1", "b1", "b2", "b3"]) expect(drawn(w, whole, id), id).toBe(true);
		const remaining = press(w, whole, "d");
		expect(remaining.finished).toBe("hidden");
		// A finished task goes from its story, and a story with everything landed from its feature, with what is under it.
		for (const id of ["b1", "shipped", "a1", "a2"]) expect(drawn(w, remaining, id), id).toBe(false);
		for (const id of ["doing", "b2", "b3", "feature"]) expect(drawn(w, remaining, id), id).toBe(true);
		const text = screen(w, remaining);
		expect(text).toContain("doing ✓1");
		expect(text).toContain("feature ✓1");
		// The top of the screen says how many are left out in all: b1, shipped and c1.
		expect(text).toContain("✓3 finished, hidden");
		expect(planOf(w, remaining, W, H).hidden).toEqual(new Set(["b1", "shipped", "c1"]));
		const back = press(w, remaining, "d");
		expect(back.finished).toBe("shown");
		expect(screen(w, back)).toBe(screen(w, whole));
	});

	it("stays where something in it still asks, an agent still works, or a helper is not done", () => {
		const w = shop();
		const out = finishedIn(w);
		// Every task of `asked` is done, and a check on the last one asks: the way to what asks stays, and the task beside it goes.
		expect(out.has("asked")).toBe(false);
		expect(out.has("c2")).toBe(false);
		expect(out.has("c1")).toBe(true);
		const remaining = press(w, initial(w, "doing"), "d");
		for (const id of ["asked", "c2"]) expect(drawn(w, remaining, id), id).toBe(true);
		expect(screen(w, remaining)).toContain("asked ✓1");
		// A done task whose check has not been made is not finished with.
		const pending = buildWorld([world([["shop", "epic", "coordinator run", [["s", "story", "plan", [["t1", "task", "worker done", [["review", "verify", "plan"]]], ["t2", "task", "worker done"], ["t3", "task", "plan"]]]]]])], LEVELS);
		expect([...finishedIn(pending)]).toEqual(["t2"]);
	});

	it("stays where the session open here is, finished or not", () => {
		const source = world([["shop", "epic", "coordinator run", [["s", "story", "plan", [["mine", "task", "worker done"], ["other", "task", "worker done"], ["next", "task", "plan"]]]]]]);
		const w = buildWorld([{ ...source, state: { ...source.state, foreground: ["mine"] } }], LEVELS);
		const remaining = press(w, initial(w, "mine"), "d");
		expect(drawn(w, remaining, "mine")).toBe(true);
		expect(remaining.selected).toBe("mine");
		expect(drawn(w, remaining, "other")).toBe(false);
	});

	it("takes the selection to what it was under when it goes", () => {
		const w = shop();
		const remaining = press(w, initial(w, "b1"), "d");
		expect(remaining.selected).toBe("doing");
		expect(screen(w, remaining)).toContain("▸doing");
		// And from something under a finished story, to the feature the story was under.
		expect(press(w, initial(w, "a2"), "d").selected).toBe("feature");
	});

	it("is not counted as left out under a folded line: the line says what is in it", () => {
		const w = shop();
		const folded = press(w, initial(w, "doing"), "f", "d");
		expect(screen(w, folded)).toContain("doing 1/3");
		expect(screen(w, folded)).not.toContain("doing ✓");
		expect(planOf(w, folded, W, H).hidden).toEqual(new Set(["shipped", "c1"]));
	});

	it("is found by name all the same, and enter draws it again to arrive at it", () => {
		const w = shop();
		let state = press(w, initial(w, "b2"), "d", "/", "a", "2");
		// While the name is typed, what it was under is selected, and the foot says what enter will do.
		expect(state.selected).toBe("feature");
		expect(renderPlain(w, state, W, H).at(-1)).toContain("show finished, to a2");
		state = press(w, state, "enter");
		expect(state.finished).toBe("shown");
		expect(state.selected).toBe("a2");
		expect(drawn(w, state, "a2")).toBe(true);
		// What is not finished is gone to without drawing the rest again.
		const near = press(w, initial(w, "b2"), "d", "/", "b", "3", "enter");
		expect([near.selected, near.finished]).toEqual(["b3", "hidden"]);
	});

	it("makes a tree narrower, so that less of it is folded to fit", () => {
		const w = buildWorld([world(HARBOR)], LEVELS);
		expect(layout(w, { finished: "hidden" }).width).toBeLessThan(layout(w).width);
		// A room a little too narrow for all of it: a finished story is folded to fit. With what is finished left out, nothing has to be.
		const room = { width: 195, height: 41 };
		const [whole, remaining] = [layout(w, { room }), layout(w, { room, finished: "hidden" })];
		expect([whole.fold, whole.folded.size]).toEqual(["unfinished", 1]);
		expect([remaining.fold, remaining.folded.size]).toEqual(["whole", 0]);
		expect(remaining.width).toBeLessThanOrEqual(room.width);
		// Leaving out moves the tree as folding does: the two are not the same shape.
		expect(sameFolds(whole, remaining)).toBe(false);
		expect(sameFolds(remaining, layout(w, { room, finished: "hidden" }))).toBe(true);
	});

	it("says d at the foot where it does something, and opens as the setting says", () => {
		const w = shop();
		// With something finished drawn under what is selected, d leaves it out; under a story with nothing finished there is nothing to say.
		expect(footerKeys(w, initial(w, "doing"))).toContainEqual(["d", "hide finished"]);
		expect(footerKeys(w, initial(w, "b2")).map(([key]) => key)).not.toContain("d");
		// With finished things left out, the way back is always said.
		const hidden = initial(w, "b2", "grown", "dependency", "hidden");
		expect(hidden.finished).toBe("hidden");
		expect(footerKeys(w, hidden)).toContainEqual(["d", "show finished"]);
		expect(drawn(w, hidden, "b1")).toBe(false);
		expect(renderPlain(w, hidden, W, H).at(-1)).toContain("d  show finished");
	});
});
