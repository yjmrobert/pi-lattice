/** The keys: what the foot says, what `?` lists, and what a press does are held to agreeing with each other. */
import { DEFAULT_SCHEME, type Issue, type WorkSession, type WorkState } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { ALL_KEYS, buildWorld, type CanopyKey, type CanopyState, FLOOR, footerKeys, initial, interpret, renderPlain, type World } from "../src/index.ts";
import { HARBOR, LEVELS, world } from "./fixture.ts";

const W = 150;
const H = 44;
const harbor = () => buildWorld([world(HARBOR)], LEVELS);

/** A board with this person's session on one issue and a teammate's on another. */
const board = (): World => {
	let next = 1;
	const issue = (title: string, type: string, parent?: number, more: Partial<Issue> = {}): Issue => ({ number: next++, rank: next, title, body: "", type, state: "todo", ...(parent !== undefined ? { parent } : {}), labels: [], fields: {}, author: "yan", createdAt: 1, updatedAt: 1, ...more }) as Issue;
	const issues = [issue("Checkout", "epic"), issue("Pay by card", "feature", 1, { state: "doing" }), issue("Refunds", "feature", 1, { state: "doing" }), issue("Receipts", "feature", 1)];
	const session = (owner: string, id: string, on: number): WorkSession => ({ host: `${owner}:shop`, owner, repo: "shop", id, name: id, role: "implementation", state: "working", issue: on, asks: 0 }) as WorkSession;
	const work: WorkState = { url: "https://lattice.example.com", me: "yan", connected: true, scheme: DEFAULT_SCHEME, issues, people: [{ name: "yan", online: true }, { name: "sam", online: true }], sessions: [session("sam", "sam-refunds", 3)], hosts: [], recent: [], seen: 0 };
	const source = world([["card work", "task", "implementation run"]], "yan", { work });
	(source.state.nodes[0] as { issue?: number }).issue = 2;
	source.state.sharing = null;
	return buildWorld([source], LEVELS);
};

/** Every key a terminal can send the canopy: the named ones and each printable character. */
const EVERY: CanopyKey[] = ["up", "down", "left", "right", "shift+up", "shift+down", "shift+left", "shift+right", "home", "tab", "enter", "escape", "backspace", ...Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(32 + index))];

/** The keys the list names, as a press arrives. */
const listed = (): Set<string> => {
	const out = new Set<string>();
	const arrows: Record<string, string> = { "←": "left", "↑": "up", "↓": "down", "→": "right" };
	for (const [, keys] of ALL_KEYS) {
		for (const [names] of keys) {
			const shifted = names.startsWith("shift+");
			for (const name of names.replace("shift+", "").split(/\s+/).filter(Boolean)) {
				if (arrows[name]) out.add(shifted ? `shift+${arrows[name]}` : (arrows[name] as string));
				else if (name === "1-9") for (let digit = 1; digit <= 9; digit++) out.add(String(digit));
				else out.add(name === "⏎" ? "enter" : name === "space" ? " " : name);
			}
		}
	}
	return out;
};

/** One item of each kind there is to select: what a key does depends on the kind, not on which one it is. */
const kinds = (w: World): string[] => {
	const seen = new Map<string, string>();
	for (const item of w.items.values()) {
		if (item.level < 0) continue;
		const kind = [item.issue !== undefined, item.planned, item.done, item.children.length > 0, item.node !== undefined, item.session !== undefined, item.owner === w.me, item.asks > 0, item.agent?.state, item.parent?.buds.includes(item), item.waitsOn.length > 0].join();
		if (!seen.has(kind)) seen.set(kind, item.id);
	}
	return [...seen.values()];
};

/** Whether a press did anything: something to carry out, or a screen that is not the one before it. */
const acts = (w: World, state: CanopyState, key: CanopyKey): boolean => {
	const next = interpret(w, state, key, W, H);
	return next.actions.length > 0 || renderPlain(w, next.state, W, H).join("\n") !== renderPlain(w, state, W, H).join("\n") || next.state.typing !== undefined;
};

describe("the keys", () => {
	it("are all in the list that ? shows: nothing the canopy acts on is left out of it", () => {
		const names = listed();
		// Escape and q lead out, and are listed with the keys of wherever the canopy is shown.
		for (const leaving of ["escape", "q"]) names.add(leaving);
		const unlisted = new Set<string>();
		for (const w of [harbor(), board()]) {
			for (const id of kinds(w)) for (const key of EVERY) if (acts(w, initial(w, id), key) && !names.has(key)) unlisted.add(key);
		}
		expect([...unlisted]).toEqual([]);
	});

	it("at the foot are keys that do something where they are said", () => {
		const names = listed().add("escape");
		const press: Record<string, CanopyKey> = { "←↑↓→": "right", "⏎": "enter", space: " ", esc: "escape" };
		for (const w of [harbor(), board()]) {
			for (const item of w.items.values()) {
				if (item.level < 0) continue;
				const state = initial(w, item.id);
				for (const [key, does] of footerKeys(w, state)) {
					const sent = press[key] ?? key;
					if (key === "←↑↓→") continue; // an arrow may be at an edge of the tree; move.test.ts holds them
					if (key === "tab" || key === ".") continue; // they say so when there is nothing to go to
					expect(acts(w, state, sent), `"${key}  ${does}" on ${item.name}`).toBe(true);
					expect(names.has(sent), `"${key}" is in the list`).toBe(true);
				}
			}
		}
	});

	it("always say at the foot how to see the rest, down to the smallest terminal the canopy draws in", () => {
		const w = harbor();
		for (const [cols, rows] of [[FLOOR.cols, FLOOR.rows], [80, 24], [100, 30], [150, 44]] as const) {
			expect(renderPlain(w, initial(w, "tables"), cols, rows).at(-1), `${cols} columns`).toMatch(/ \? {2}keys$/);
			// Where it is in a layout, the keys that lead out come first and are still there.
			expect(renderPlain(w, initial(w, "tables"), cols, rows, 0, { animations: [], now: 0, leave: [["alt+l", "chat"], ["p", "sessions"]] }).at(-1), `${cols} columns`).toMatch(/^ +alt\+l {2}chat +p {2}sessions.* \? {2}keys$/);
		}
	});

	it("are listed in place of the tree with ?, with the keys that lead out of wherever the canopy is, and the list closes with ? or escape", () => {
		const w = harbor();
		const open = interpret(w, initial(w, "tables"), "?", W, H).state;
		const leave = [["alt+l", "chat"], ["p", "sessions"]] as const;
		const drawn = renderPlain(w, open, W, H, 0, { animations: [], now: 0, leave }).join("\n");
		for (const text of ["MOVING", "WHAT IS SELECTED", "offer the session on it to a teammate", "ask a teammate for the session on it", "go to an item by part of its name", "LEAVING", "the sessions as a list"]) expect(drawn).toContain(text);
		expect(drawn).not.toContain("◉▸tables");
		expect(drawn.split("\n").at(-1)).toMatch(/\? {2}back to the tree/);
		// Nothing else is done from it: f does not fold what is selected behind the list.
		expect(interpret(w, open, "f", W, H).state).toEqual(open);
		expect(interpret(w, open, "?", W, H).state.help).toBeUndefined();
		const closed = interpret(w, open, "escape", W, H);
		expect([closed.state.help, closed.actions]).toEqual([undefined, []]);
		// Opened over the chat, escape leads back there, and the list says so.
		expect(renderPlain(w, open, W, H).join("\n")).toContain("back to where the canopy was opened from");
	});

	it("reads on through a list longer than the window, and no further than its end", () => {
		const w = harbor();
		let state = interpret(w, initial(w, "tables"), "?", 80, 24).state;
		expect(renderPlain(w, state, 80, 24).join("\n")).not.toContain("show or hide this list");
		for (let press = 0; press < 60; press++) state = interpret(w, state, "down", 80, 24).state;
		const end = renderPlain(w, state, 80, 24).join("\n");
		expect(end).toContain("show or hide this list");
		expect(state.help).toBeLessThan(40);
		expect(interpret(w, state, "up", 80, 24).state.help).toBe((state.help as number) - 1);
	});
});

describe("handing a session over, from the tree", () => {
	it("offers this person's session with o, and asks a teammate for theirs with t", () => {
		const w = board();
		expect(interpret(w, initial(w, "#2"), "o", W, H).actions).toEqual([{ do: "hand", what: "offer", id: "card work" }]);
		expect(interpret(w, initial(w, "#3"), "t", W, H).actions).toEqual([{ do: "hand", what: "take", id: "sam-refunds" }]);
		expect(footerKeys(w, initial(w, "#2"))).toContainEqual(["o", "offer"]);
		expect(footerKeys(w, initial(w, "#3"))).toContainEqual(["t", "take"]);
		// Without a server the sessions are the items: the same keys, on the session itself.
		const h = harbor();
		expect(interpret(h, initial(h, "stripe-listen"), "o", W, H).actions).toEqual([{ do: "hand", what: "offer", id: "stripe-listen" }]);
		expect(interpret(h, initial(h, "copy"), "t", W, H).actions).toEqual([{ do: "hand", what: "take", id: "copy" }]);
	});

	it("says whose a session is when the key is the other one, and that there is none where nobody is on the item", () => {
		const w = board();
		expect(interpret(w, initial(w, "#3"), "o", W, H).actions).toEqual([{ do: "say", text: "That session is sam's. Press t to ask them for it." }]);
		expect(interpret(w, initial(w, "#2"), "t", W, H).actions).toEqual([{ do: "say", text: "That session is yours already. Press o to offer it to a teammate." }]);
		expect(interpret(w, initial(w, "#4"), "o", W, H).actions).toEqual([{ do: "say", text: 'Nobody is on "Receipts": there is no session to hand over.' }]);
		expect(footerKeys(w, initial(w, "#4")).map(([key]) => key)).not.toContain("o");
	});

	it("does not offer to nobody: alone, the foot leaves the key out, and the key still says how to get on a team", () => {
		const alone = buildWorld([world([["solo", "task", "worker run"]])], LEVELS);
		expect(alone.people).toHaveLength(1);
		expect(footerKeys(alone, initial(alone, "solo")).map(([key]) => key)).not.toContain("o");
		expect(interpret(alone, initial(alone, "solo"), "o", W, H).actions).toEqual([{ do: "hand", what: "offer", id: "solo" }]);
	});
});
