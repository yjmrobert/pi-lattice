import type { NodeMeta, UiState } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { paneNotices, paneOrder, renderCompact, renderPane } from "../src/index.ts";

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
const view = (over = {}) => ({ state: state(), current: "r", selected: "r", focused: false, ...over });

describe("renderPane", () => {
	it("lists the hierarchy with each session's name, owner, repository and kind", () => {
		expect(renderPane(view(), 34)).toEqual([
			" SESSIONS",
			"▸ ● checkout",
			"    you · shop · feature",
			" ├ ◐ grilling",
			"     you · shop · task",
			" └ ● impl",
			"     @sam · shop · task",
		]);
	});

	it("greys out a session whose owner is offline, as last seen", () => {
		const s = state();
		if (s.sharing) (s.sharing.people[1] as { online: boolean }).online = false;
		const lines = renderPane(view({ state: s }), 34);
		expect(lines[5]).toBe(" └ ○ impl");
		expect(lines[6]).toBe("     @sam · shop · task · offline");
	});

	it("treats an owner it has never been paired with as offline", () => {
		expect(renderPane(view({ state: state({ sharing: null }) }), 34)[6]).toContain("offline");
	});

	it("marks sessions that need the human", () => {
		const lines = renderPane(view({ state: state({ attention: { a: { dialogs: 1, pending: 2 } } }) }), 34);
		expect(lines[3]).toBe(" ├ ◐ grilling ?1 ✉2");
		expect(lines.join("\n")).toContain("2 messages to approve");
	});

	it("shows the cursor only while focused, on the selected session", () => {
		const lines = renderPane(view({ focused: true, selected: "a" }), 34);
		expect(lines[1]).toBe("  ● checkout");
		expect(lines[3]).toContain("›├ ◐ grilling");
	});

	it("shows key hints only while focused, and never exceeds its width", () => {
		expect(renderPane(view(), 34).join("\n")).not.toContain("enter open");
		const focused = renderPane(view({ focused: true }), 24);
		expect(focused.join("\n")).toContain("enter open");
		for (const line of focused) expect([...line].length).toBeLessThanOrEqual(23);
	});

	it("truncates long names instead of wrapping", () => {
		const s = state();
		(s.nodes[0] as { name: string }).name = "a-very-long-session-name-that-will-not-fit";
		expect(renderPane(view({ state: s }), 24)[1]).toMatch(/…$/);
	});

	it("explains itself when there is no tree", () => {
		expect(renderPane({ state: undefined, current: undefined, selected: undefined, focused: false, hint: "Run /lattice to start." }, 34)).toEqual([" SESSIONS", " Run /lattice to start."]);
	});
});

describe("pane helpers", () => {
	it("orders rows as displayed, for moving the cursor", () => {
		expect(paneOrder(state())).toEqual(["r", "a", "b"]);
		expect(paneOrder(undefined)).toEqual([]);
	});

	it("summarises what is waiting on this person", () => {
		const s = state({
			sharing: {
				people: [{ name: "kim", fingerprint: "k", trust: "unknown", online: false, self: false }],
				handoffs: [
					{ nodeId: "b", nodeName: "impl", from: "sam", to: "yan", state: "offered", role: "recipient" },
					{ nodeId: "a", nodeName: "grilling", from: "yan", to: "sam", state: "accepted", role: "owner" },
				],
				pendingTransfers: [{ nodeId: "a", to: "sam" }],
			},
		});
		expect(paneNotices(s)).toEqual(["kim wants to pair", "sam offers impl", "confirm grilling → sam", "sending to sam…"]);
	});

	it("falls back to one line per session, marking the one open here", () => {
		expect(renderCompact(view())).toEqual(["▸ ● checkout  you · shop", "  ├─ ◐ grilling  you · shop", "  └─ ● impl  @sam · shop"]);
		expect(renderCompact(view(), 2)).toEqual(["▸ ● checkout  you · shop", "  … 2 more (/lattice)"]);
	});
});
