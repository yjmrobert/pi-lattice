import { describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, type CanopyState, initial, interpret, planOf, render, renderPlain } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

const W = 150;
const H = 44;
const harbor = (extra = {}) => buildWorld([world(HARBOR, "yan", extra)], LEVELS);
const press = (w: ReturnType<typeof harbor>, state: CanopyState, ...keys: CanopyKey[]): CanopyState => keys.reduce((at, key) => interpret(w, at, key, W, H).state, state);
const screen = (w: ReturnType<typeof harbor>, state: CanopyState): string => renderPlain(w, state, W, H).join("\n");

describe("the screen", () => {
	it("is the people, the path, a window on the tree with the inspector beside it, and the keys", async () => {
		const w = harbor({ focus: { "checkout-v2": { nodeId: "webhooks", at: 5 } } });
		const lines = renderPlain(w, initial(w, "tables"), W, H);
		expect(lines).toHaveLength(H);
		expect(lines[0]).toBe(" ◆ harbor  1 @yan ⠋4 ●2 19   2 @mira ⠋4 10   3 @sam ⠋4 ●1 17   4 ○@teo away ●1 4");
		expect(lines[1]).toMatch(/^ harbor ▸ pricing-migration ▸ new-tables ▸ tables  story +first to last · 7 can start · ⧗4 held$/);
		expect(lines.at(-1)).toContain("tab  next that needs someone");
		await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./snapshots/screen.txt");
	});

	it("is exactly as wide and as tall as it is asked to be, in colour too", () => {
		const w = harbor();
		const lines = render(w, initial(w, "tables"), W, H, 7);
		expect(lines).toHaveLength(H);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour
		for (const line of lines) expect([...line.replace(/\x1b\[[0-9;]*m/g, "")].length).toBe(W);
	});

	it("says how much room it needs when there is too little", () => {
		const w = harbor();
		expect(renderPlain(w, initial(w), 50, 18).join("\n")).toContain("The canopy needs 60 columns by 20 rows.");
	});

	it("opens on the session the terminal is in, or on the first item", () => {
		const w = harbor();
		expect(initial(w, "copy").selected).toBe("copy");
		expect(initial(w, "nowhere").selected).toBe("checkout-v2");
	});
});

describe("moving", () => {
	it("goes down to what an item belongs to and up into what is under it", () => {
		const w = harbor();
		const at = initial(w, "tables");
		expect(press(w, at, "down").selected).toBe("new-tables");
		expect(press(w, at, "down", "down").selected).toBe("pricing-migration");
		// The root is not something to select.
		expect(press(w, at, "down", "down", "down").selected).toBe("pricing-migration");
		// A frond is read upward: what comes first is nearest the item.
		expect(press(w, at, "up").selected).toBe("schema");
		expect(press(w, at, "up", "up", "up").selected).toBe("verify-copy");
		expect(press(w, at, "up", "down").selected).toBe("tables");
	});

	it("goes across to what is beside an item", () => {
		const w = harbor();
		const at = initial(w, "payments");
		expect(press(w, at, "right").selected).toBe("cart");
		expect(press(w, at, "left").selected).toBe("invoices");
		expect(press(w, at, "l", "h").selected).toBe("payments");
	});

	it("jumps to the next thing that needs someone", () => {
		const w = harbor();
		const seen = [1, 2, 3, 4, 5].map((n) => press(w, initial(w, "tables"), ...Array.from({ length: n }, () => "tab" as const)).selected);
		expect(seen).toEqual(["webhooks", "stripe-listen", "conflicts", "pdf", "webhooks"]);
	});

	it("keeps what is selected in the window, moving it only as far as needed", () => {
		const w = harbor();
		const plan = planOf(w, initial(w));
		let state = press(w, initial(w, "checkout-v2"), "tab");
		const place = plan.places.get("webhooks");
		expect(place).toBeDefined();
		const inView = (s: CanopyState, id: string): boolean => {
			const p = planOf(w, s).places.get(id);
			return p !== undefined && p.col >= s.camera.col && p.col < s.camera.col + W - 40 && p.row >= s.camera.row && p.row < s.camera.row + H - 3;
		};
		expect(inView(state, "webhooks")).toBe(true);
		const before = state.camera;
		// A step that stays in view does not move the window.
		expect(press(w, state, "up").camera).toEqual(before);
		state = press(w, state, "tab", "tab", "tab");
		expect(state.selected).toBe("pdf");
		expect(inView(state, "pdf")).toBe(true);
		expect(state.camera.col).toBeGreaterThan(before.col);
	});

	it("pans with shift and the arrows, and never past the edge of the tree", () => {
		const w = harbor();
		const start = press(w, initial(w, "checkout-v2"), "home");
		const right = press(w, start, "shift+right");
		expect(right.camera.col).toBe(start.camera.col + 12);
		expect(right.selected).toBe("checkout-v2");
		const far = press(w, start, ...Array.from({ length: 40 }, () => "shift+right" as const));
		expect(far.camera.col).toBe(planOf(w, far).width - (W - 40));
		expect(press(w, far, ...Array.from({ length: 80 }, () => "shift+left" as const)).camera.col).toBe(0);
	});

	it("says at the edge how many things that need someone are out of view", () => {
		const w = harbor();
		const text = screen(w, press(w, initial(w, "tables")));
		expect(text).toMatch(/1▶/);
	});
});

describe("acting", () => {
	it("opens the session on an item, and says a planned one has nobody on it", () => {
		const w = harbor();
		expect(interpret(w, initial(w, "copy"), "enter", W, H).actions).toEqual([{ do: "open", id: "copy", tree: "/shop/.lattice" }]);
		expect(interpret(w, initial(w, "cards"), "enter", W, H).actions).toEqual([{ do: "say", text: 'Nobody is on "cards" yet. Press s to put a session on it.' }]);
	});

	it("puts a session on a planned item of one's own with s", () => {
		const w = harbor();
		expect(interpret(w, initial(w, "cards"), "s", W, H).actions).toEqual([{ do: "start", id: "cards", tree: "/shop/.lattice" }]);
		expect(interpret(w, initial(w, "dual-write"), "s", W, H).actions).toEqual([{ do: "say", text: '"dual-write" is sam\'s to start.' }]);
		expect(interpret(w, initial(w, "copy"), "s", W, H).actions).toEqual([{ do: "say", text: '"copy" has already started.' }]);
	});

	it("closes with escape", () => {
		const w = harbor();
		expect(interpret(w, initial(w), "escape", W, H).actions).toEqual([{ do: "close" }]);
	});

	it("folds an item to one node and unfolds it", () => {
		const w = harbor();
		const folded = press(w, initial(w, "checkout-v2"), "f");
		expect(planOf(w, folded).places.has("payments")).toBe(false);
		// It says how many items it holds, and the inspector still lists what is under it.
		expect(screen(w, folded)).toContain("◉ checkout-v2 +22");
		expect(screen(w, folded)).toContain("UNDER IT (folded)");
		expect(planOf(w, press(w, folded, "enter")).places.has("payments")).toBe(true);
	});

	it("keeps one person's colour and greys the rest with a digit", () => {
		const w = harbor();
		const one = press(w, initial(w, "tables"), "3");
		expect(one.spotlight).toBe("sam");
		// Sam's blue stays; yan's cyan is gone from the whole screen.
		expect(render(w, initial(w, "tables"), W, H).join("")).toContain("38;2;95;212;208");
		expect(render(w, one, W, H).join("")).not.toContain("38;2;95;212;208");
		expect(render(w, one, W, H).join("")).toContain("38;2;122;167;255");
		expect(press(w, one, "3").spotlight).toBeUndefined();
		expect(press(w, one, "0").spotlight).toBeUndefined();
	});

	it("lists every agent by owner in the roster, with what it is working on", () => {
		const w = harbor({ focus: { "checkout-v2": { nodeId: "webhooks", at: 5 } } });
		const text = screen(w, press(w, initial(w, "tables"), "a"));
		expect(text).toContain("@sam  s");
		expect(text).toMatch(/● worker\s+pdf/);
		expect(text).toMatch(/coordinator\s+checkout-… → webhooks/);
		expect(text).toMatch(/@teo {2}away {2}t/);
	});
});
