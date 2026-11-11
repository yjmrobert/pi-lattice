import type { NodeMeta, UiState } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { cursorKeys, inboxItems, interpretKey, itemKey, nodeKey, type Paint, type PaneRepo, type PaneView, paneOrder, PLAIN, renderCompact, renderPane } from "../src/index.ts";

const node = (id: string, parentId: string | null, over: Partial<NodeMeta> = {}): NodeMeta => ({
	id, parentId, rootId: "r", kind: "task", name: id, brief: "", fragments: [], owner: "yan", version: 1, status: "idle",
	sessionId: null, sessionFile: null, cwd: "/w", workspace: "shared", branch: null, createdAt: `2026-01-01T00:00:0${id.length}.000Z`, updatedAt: "", repo: "shop", ...over,
});
const state = (over: Partial<UiState> = {}): UiState => ({
	owner: "yan",
	nodes: [node("r", null, { name: "checkout", kind: "feature" }), node("a", "r", { name: "grilling", status: "running" }), node("b", "r", { name: "impl", owner: "sam", status: "idle" })],
	attention: {}, foreground: ["r"],
	sharing: { people: [{ name: "yan", fingerprint: "f", trust: "trusted", online: true, self: true }, { name: "sam", fingerprint: "g", trust: "trusted", online: true, self: false }], handoffs: [], pendingTransfers: [] },
	...over,
});
const repo = (s: UiState = state(), over: Partial<PaneRepo> = {}): PaneRepo => ({ key: "/shop/.lattice", name: "shop", state: s, here: true, inbox: inboxItems(s), ...over });
const view = (over: Partial<PaneView> = {}, s: UiState = state()): PaneView => ({ repos: [repo(s)], current: "r", cursor: undefined, focused: false, ...over });
/** Marks what would be styled, so tests can see it. */
const MARKED: Paint = { ...PLAIN, select: (text) => `[${text}]`, warn: (text) => `!${text}!` };

describe("renderPane", () => {
	it("lists a repository's sessions one line each: tree, status, name, and the kind on the right", () => {
		expect(renderPane(view(), 34)).toEqual([
			" ◆ shop               3 sessions ",
			"▸ ● checkout             feature ",
			"  ├ ⠋ grilling              task ",
			"  └ ● impl                  @sam ",
			"─────────────────────────────────",
			" alt+l sessions  nothing waiting ",
		]);
	});

	it("names the owner only when the session is someone else's, and says when they are away", () => {
		const s = state();
		if (s.sharing) (s.sharing.people[1] as { online: boolean }).online = false;
		expect(renderPane(view({}, s), 34)[3]).toBe("  └ ○ impl          @sam offline ");
		expect(renderPane(view({}, state({ sharing: null })), 34)[3]).toContain("offline");
	});

	it("puts what is waiting on the person above the tree, and marks the rows it comes from", () => {
		const lines = renderPane(view({}, state({ attention: { a: { dialogs: 1, pending: 2 } } })), 34);
		expect(lines.slice(0, 6)).toEqual([
			" NEEDS YOU                     2 ",
			" ? grilling",
			"   asks a question",
			" ✉ grilling",
			"   2 messages to approve",
			"─────────────────────────────────",
		]);
		expect(lines[8]).toBe("  ├ ● grilling        ?1 ✉2 task ");
		expect(lines.at(-1)).toBe(" alt+l to answer       2 waiting ");
	});

	it("uses the attention colour only for what is waiting on the person", () => {
		const calm = renderPane(view(), 34, MARKED).join("\n");
		expect(calm).not.toContain("!");
		const waiting = renderPane(view({}, state({ attention: { a: { dialogs: 1, pending: 0 } } })), 34, MARKED);
		const row = waiting.find((line) => line.includes("task")) ?? "";
		expect(row).toContain("!●! grilling");
		expect(row).toContain("!?1!");
	});

	it("keeps the open-here mark while the cursor is on another row", () => {
		const lines = renderPane(view({ focused: true, cursor: nodeKey("a") }), 34, MARKED);
		expect(lines[1]).toBe("▸ ● checkout             feature ");
		expect(lines[2]).toBe("[  ├ ⠋ grilling              task ]");
	});

	it("moves the cursor through waiting items first, then sessions", () => {
		const v = view({ focused: true }, state({ attention: { a: { dialogs: 1, pending: 0 } } }));
		expect(paneOrder(v)).toEqual([itemKey("q:a"), nodeKey("r"), nodeKey("a"), nodeKey("b")]);
		const lines = renderPane({ ...v, cursor: itemKey("q:a") }, 34, MARKED);
		expect(lines[1]).toBe("[ 1 !?! grilling                    ]");
		expect(lines[2]).toBe("[     asks a question             ]");
	});

	it("shows the keys only while it has the keyboard", () => {
		expect(renderPane(view(), 34).join("\n")).not.toContain("⏎ open");
		expect(renderPane(view({ focused: true }), 34).join("\n")).toContain("⏎ open");
	});

	it("drops the kind before it cuts the name, and never drops what is waiting", () => {
		const s = state({ attention: { r: { dialogs: 1, pending: 0 } } });
		(s.nodes[0] as { name: string }).name = "a-very-long-session-name";
		const lines = renderPane(view({}, s), 30);
		expect(lines.findLast((line) => line.includes("a-very"))).toBe("▸ ● a-very-long-session-… ?1 ");
		for (const line of renderPane(view({ focused: true }, s), 24)) expect([...line].length).toBeLessThanOrEqual(23);
	});

	it("animates a working session with the frame it is given", () => {
		expect(renderPane(view({ frame: 2 }), 34)[2]).toContain("⠹ grilling");
	});

	it("pins the footer to the bottom and scrolls a long list with the cursor", () => {
		const tall = renderPane(view({ height: 10 }), 34);
		expect(tall).toHaveLength(10);
		expect(tall.at(-1)).toContain("alt+l");
		expect(tall[5]).toBe("");
		const many = state({ nodes: [node("r", null), ...Array.from({ length: 12 }, (_, index) => node(`n${String(index).padStart(2, "0")}`, "r"))] });
		const short = renderPane(view({ height: 8, focused: true, cursor: nodeKey("n11") }, many), 34, MARKED);
		expect(short).toHaveLength(8);
		expect(short[0]).toMatch(/↑ \d+ more/);
		expect(short.join("\n")).toContain("[  └ ● n11");
	});

	it("explains itself when there is no tree", () => {
		expect(renderPane({ repos: [], current: undefined, cursor: undefined, focused: false, hint: "Run /lattice to start." }, 34).slice(0, 1)).toEqual([" Run /lattice to start."]);
	});
});

describe("several repositories", () => {
	const other = (over: Partial<UiState> = {}): UiState => state({ nodes: [node("x", null, { name: "invoices", kind: "feature" }), node("y", "x", { name: "pdf" })], foreground: [], ...over });

	it("groups sessions by repository, this terminal's first, and folds one where nothing is happening", () => {
		const lines = renderPane({ repos: [repo(), repo(other(), { key: "/billing/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: false }, 34);
		expect(lines.slice(0, 5)).toEqual([
			" ◆ shop                       ⠋1 ",
			"▸ ● checkout             feature ",
			"  ├ ⠋ grilling              task ",
			"  └ ● impl                  @sam ",
			" ◇ billing-api            2 idle ",
		]);
	});

	it("opens a repository up while something in it is waiting, and says where each item is from", () => {
		const waiting = other({ attention: { y: { dialogs: 1, pending: 0 } } });
		const lines = renderPane({ repos: [repo(), repo(waiting, { key: "/billing/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: false }, 34);
		expect(lines.slice(0, 3)).toEqual([" NEEDS YOU                     1 ", " ? pdf               billing-api ", "   asks a question"]);
		expect(lines.slice(8, 11)).toEqual([" ◇ billing-api                ●1 ", "  ● invoices             feature ", "  └ ● pdf                ?1 task "]);
	});

	it("opens every repository while the pane has the keyboard, so the cursor can reach all of them", () => {
		const v: PaneView = { repos: [repo(), repo(other(), { key: "/billing/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: true };
		expect(renderPane(v, 34).join("\n")).toContain("invoices");
		expect(paneOrder(v)).toContain(nodeKey("y"));
	});
});

describe("pane helpers", () => {
	it("lists what is waiting on this person, one item per thing once the details are known", () => {
		const s = state({
			attention: { a: { dialogs: 2, pending: 1 } },
			sharing: {
				people: [{ name: "kim", fingerprint: "k", trust: "unknown", online: false, self: false }],
				handoffs: [
					{ nodeId: "b", nodeName: "impl", from: "sam", to: "yan", state: "offered", role: "recipient" },
					{ nodeId: "a", nodeName: "grilling", from: "yan", to: "sam", state: "accepted", role: "owner" },
				],
				pendingTransfers: [],
			},
		});
		expect(inboxItems(s).map((item) => `${item.title}: ${item.text}`)).toEqual([
			"grilling: asks 2 questions", "grilling: 1 message to approve", "kim: wants to pair", "sam: offers impl", "grilling: confirm release to sam",
		]);
		const detailed = inboxItems(s, { dialogs: { a: [{ id: "d1", method: "confirm", title: "Run  it?" }, { id: "d2", method: "input", title: "Which port?" }] } });
		expect(detailed.slice(0, 2).map((item) => `${item.id} ${item.text}`)).toEqual(["q:a:d1 Run it?", "q:a:d2 Which port?"]);
	});

	it("shows a session being sent to someone", () => {
		const s = state();
		if (s.sharing) s.sharing.pendingTransfers = [{ nodeId: "a", to: "sam" }];
		expect(renderPane(view({}, s), 34)[2]).toBe("  ├ ⠋ grilling            → sam… ");
	});

	it("falls back to one line per session, marking the one open here", () => {
		expect(renderCompact(view())).toEqual(["▸ ● checkout  you · shop", "  ├─ ⠋ grilling  you · shop", "  └─ ● impl  @sam · shop"]);
		expect(renderCompact(view(), 2)).toEqual(["▸ ● checkout  you · shop", "  … 2 more (/lattice)"]);
	});
});

describe("keys while the pane has the keyboard", () => {
	const envelope = { id: "e1", from: "b", fromOwner: "sam", payload: { text: "Totals endpoint is live at /cart/totals, with the schema attached." } } as never;
	const waiting = state({ attention: { a: { dialogs: 2, pending: 1 } } });
	const details = { dialogs: { a: [{ id: "d1", method: "confirm" as const, title: "Run stripe listen in this shell?" }, { id: "d2", method: "input" as const, title: "Which port?" }] }, mail: [{ nodeId: "a", envelope }] };
	const at = (cursor: string | undefined): PaneView => ({ repos: [repo(waiting, { inbox: inboxItems(waiting, details) })], current: "r", cursor, focused: true });

	it("moves through items then sessions, and jumps to an item by its number", () => {
		expect(interpretKey(at(itemKey("q:a:d1")), "down")).toEqual([{ do: "move", cursor: itemKey("q:a:d2") }]);
		expect(interpretKey(at(itemKey("m:a:e1")), "down")).toEqual([{ do: "move", cursor: nodeKey("r") }]);
		expect(interpretKey(at(nodeKey("r")), "3")).toEqual([{ do: "move", cursor: itemKey("m:a:e1") }]);
		expect(interpretKey(at(nodeKey("r")), "9")).toEqual([]);
	});

	it("answers a yes/no question with one key, where it is", () => {
		expect(interpretKey(at(itemKey("q:a:d1")), "y")).toEqual([{ do: "answer", repo: "/shop/.lattice", nodeId: "a", dialogId: "d1", confirmed: true }]);
		expect(interpretKey(at(itemKey("q:a:d1")), "n")).toEqual([{ do: "answer", repo: "/shop/.lattice", nodeId: "a", dialogId: "d1", confirmed: false }]);
	});

	it("sends any other question to Pi's own prompt", () => {
		expect(interpretKey(at(itemKey("q:a:d2")), "enter")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice answer a" }]);
		expect(interpretKey(at(itemKey("q:a:d2")), "y")).toEqual([]);
	});

	it("approves or rejects a message where it is", () => {
		expect(interpretKey(at(itemKey("m:a:e1")), "a")).toEqual([{ do: "decide", repo: "/shop/.lattice", nodeId: "a", envelopeId: "e1", action: "approve" }]);
		expect(interpretKey(at(itemKey("m:a:e1")), "x")).toEqual([{ do: "decide", repo: "/shop/.lattice", nodeId: "a", envelopeId: "e1", action: "reject" }]);
	});

	it("opens, creates under and shares the session the cursor is on", () => {
		expect(interpretKey(at(nodeKey("a")), "enter")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice open a" }]);
		expect(interpretKey(at(nodeKey("r")), "enter")).toEqual([{ do: "leave" }]);
		expect(interpretKey(at(nodeKey("a")), "n")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice new a" }]);
		expect(interpretKey(at(nodeKey("a")), "escape")).toEqual([{ do: "leave" }]);
	});

	it("shows in the footer exactly the keys that act on what the cursor is on", () => {
		expect(cursorKeys(at(itemKey("q:a:d1")))).toEqual([["y", "yes"], ["n", "no"]]);
		expect(cursorKeys(at(itemKey("q:a:d2")))).toEqual([["⏎", "answer"]]);
		expect(cursorKeys(at(itemKey("m:a:e1")))).toEqual([["a", "approve"], ["x", "reject"]]);
		expect(cursorKeys(at(nodeKey("a")))).toEqual([["⏎", "open"], ["n", "new"], ["o", "share"]]);
		const v = at(itemKey("q:a:d1"));
		expect(renderPane({ ...v, keys: cursorKeys(v) }, 34).at(-1)).toBe(" y yes  n no  ↑↓ move  esc back");
	});

	it("shows all of an item's text under the cursor, wrapped, and one line otherwise", () => {
		const lines = renderPane(at(itemKey("m:a:e1")), 34);
		const from = lines.findIndex((line) => line.includes("✉"));
		expect(lines.slice(from, from + 4)).toEqual([
			" 3 ✉ impl → grilling             ",
			"     Totals endpoint is live at  ",
			"     /cart/totals, with the      ",
			"     schema attached.            ",
		]);
		expect(renderPane(at(nodeKey("r")), 34)[from + 1]).toBe("     Totals endpoint is live at …");
	});
});
