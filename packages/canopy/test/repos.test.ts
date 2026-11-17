/** Every repository a person has work in is on the canopy, whichever one the terminal is in (ADR 0041). */
import { describe, expect, it } from "vitest";
import { buildWorld, footerKeys, initial, interpret, placeId, renderPlain } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

const W = 150;
const H = 44;
const PLACES = { asleep: [{ key: "/billing/.lattice", repo: "billing-api" }], here: { key: "/docs/.lattice", repo: "docs", starting: false } };
const build = (places = PLACES) => buildWorld([world(HARBOR)], LEVELS, "", places);

describe("repositories with nothing of theirs to draw", () => {
	it("are one item each at the foot of the tree: the one that is asleep, and the one this terminal is in", () => {
		const w = build();
		const [asleep, here] = [w.items.get(placeId("/billing/.lattice")), w.items.get(placeId("/docs/.lattice"))];
		expect([asleep?.name, asleep?.place, asleep?.parent?.id]).toEqual(["billing-api", "asleep", w.root.id]);
		expect([here?.name, here?.place]).toEqual(["docs", "here"]);
		const drawn = renderPlain(w, { ...initial(w, here?.id), side: "none" }, 240, 60).join("\n");
		expect(drawn).toContain("○▸docs");
		expect(drawn).toMatch(/nothing here yet/);
		expect(drawn).toMatch(/○ billing-api/);
		expect(drawn).toMatch(/asleep/);
		// The work comes first, and they come after it.
		expect(w.flow.ordered.get(w.root.id)?.slice(-2).map((item) => item.place)).toEqual(["here", "asleep"]);
	});

	it("are not work: nothing counts them as something to start, or as anybody's", () => {
		const [without, with_] = [buildWorld([world(HARBOR)], LEVELS), build()];
		expect(renderPlain(with_, initial(with_, "tables"), W, H)[1]).toMatch(/7 can start/);
		expect(with_.people.map((person) => person.owned)).toEqual(without.people.map((person) => person.owned));
		expect(with_.root.leaves).toBe(without.root.leaves);
		// The next thing to start is never one of them.
		let state = initial(with_, "tables");
		for (let press = 0; press < 12; press++) {
			state = interpret(with_, state, ".", W, H).state;
			expect(with_.items.get(state.selected as string)?.place).toBeUndefined();
		}
	});

	it("name the canopy for all of a person's work, not for the one repository that is running", () => {
		expect(buildWorld([world([["solo", "task", "worker run"]])], LEVELS).root.name).toBe("harbor");
		const alone = world([["solo", "task", "worker run"]]);
		alone.state.sharing = null;
		expect(buildWorld([alone], LEVELS).root.name).toBe("shop");
		expect(buildWorld([alone], LEVELS, "", PLACES).root.name).toBe("your work");
	});

	it("wake with enter when asleep, and say so", () => {
		const w = build();
		const state = initial(w, placeId("/billing/.lattice"));
		expect(interpret(w, state, "enter", W, H).actions).toEqual([{ do: "say", text: "Waking billing-api…" }, { do: "wake", key: "/billing/.lattice" }]);
		expect(footerKeys(w, state)).toContainEqual(["⏎", "wake"]);
		expect(renderPlain(w, state, W, H).join("\n")).toContain("Its host is asleep");
	});

	it("open the chat with enter where nothing is started yet: the first message there starts the tree", () => {
		const w = build();
		const state = initial(w, placeId("/docs/.lattice"));
		expect(interpret(w, state, "enter", W, H).actions).toEqual([{ do: "chat" }]);
		expect(footerKeys(w, state)).toContainEqual(["⏎", "start here"]);
		const panel = renderPlain(w, state, W, H);
		expect(panel[1]).toMatch(/▸ docs {2}repository/);
		expect(panel.join("\n")).toContain("Press enter for the chat: your first");
		// While it starts, there is nothing to press.
		const starting = build({ asleep: [], here: { key: "/docs/.lattice", repo: "docs", starting: true } });
		const at = initial(starting, placeId("/docs/.lattice"));
		expect(footerKeys(starting, at).map(([key]) => key)).not.toContain("⏎");
		expect(renderPlain(starting, { ...at, side: "none" }, 240, 60).join("\n")).toContain("starting…");
	});

	it("take no other key as if there were a session on them", () => {
		const w = build();
		for (const id of [placeId("/billing/.lattice"), placeId("/docs/.lattice")]) {
			for (const key of ["s", "o", "t", " "]) {
				const acted = interpret(w, initial(w, id), key, W, H);
				expect(acted.actions.map((action) => action.do), `${key} on ${id}`).toEqual(["say"]);
				expect(acted.state.typing).toBeUndefined();
			}
			expect(interpret(w, initial(w, id), "f", W, H).actions).toEqual([]);
		}
	});
});
