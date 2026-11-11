import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { NodeMeta } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { renderTreeRows, type TreeViewState } from "../src/index.ts";

const node = (id: string, parentId: string | null, over: Partial<NodeMeta> = {}): NodeMeta => ({
	id, parentId, rootId: "r", kind: "task", name: id, brief: "", fragments: [], owner: "yan", version: 1, status: "idle",
	sessionId: null, sessionFile: null, cwd: "/w", workspace: "shared", branch: null, createdAt: `2026-01-01T00:00:0${id.length}.000Z`, updatedAt: "", ...over,
});
const state = (over: Partial<TreeViewState> = {}): TreeViewState => ({
	nodes: [node("r", null, { name: "checkout", kind: "feature" }), node("a", "r", { name: "grilling", status: "blocked" }), node("b", "r", { name: "impl", status: "dormant", owner: "sam" })],
	selected: "a", current: "r", focused: true, localOwner: "yan", attention: new Map(), ...over,
});
const plain = (s: TreeViewState, width = 60) => renderTreeRows(s, width).map((line) => stripTerminalSequences(line));

describe("renderTreeRows", () => {
	it("shows one row per node with status, kind and nesting", () => {
		expect(plain(state())).toEqual(["  ● checkout feature", "› ├─ ! grilling task", "  └─ ○ impl task @sam"]);
	});

	it("badges nodes that need the human", () => {
		const rows = plain(state({ attention: new Map([["a", { dialogs: 1, pending: 0 }], ["r", { dialogs: 0, pending: 2 }]]) }));
		expect(rows[0]).toContain("✉ 2");
		expect(rows[1]).toContain("? 1");
	});

	it("marks another owner's nodes and not the local owner's", () => {
		const rows = plain(state());
		expect(rows[2]).toContain("@sam");
		expect(rows[0]).not.toContain("@yan");
	});

	it("never exceeds the available width", () => {
		for (const line of renderTreeRows(state(), 12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
	});

	it("says so when there are no sessions", () => {
		expect(plain(state({ nodes: [] }))).toEqual(["  (no sessions)"]);
	});
});
