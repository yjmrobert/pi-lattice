import { describe, expect, it } from "vitest";
import { childrenOf, depthOf, formatTree, type NodeMeta, treeOf } from "../src/index.ts";

const node = (id: string, parentId: string | null, over: Partial<NodeMeta> = {}): NodeMeta => ({
	id, parentId, rootId: "r", kind: "task", name: id, brief: "", fragments: [], owner: "yan", version: 1, status: "idle",
	sessionId: null, sessionFile: null, cwd: "/w", workspace: "shared", branch: null, createdAt: `2026-01-01T00:00:0${id.length}.000Z`, updatedAt: "",
	...over,
});
const nodes = [
	node("r", null, { kind: "feature", name: "checkout", fragments: ["coordinator"] }),
	node("a", "r", { createdAt: "2026-01-01T00:00:01.000Z" }),
	node("b", "r", { createdAt: "2026-01-01T00:00:02.000Z", branch: "lattice/b" }),
	node("a1", "a"),
];

describe("tree helpers", () => {
	it("finds children in creation order", () => {
		expect(childrenOf(nodes, "r").map((n) => n.id)).toEqual(["a", "b"]);
		expect(childrenOf(nodes, "b")).toEqual([]);
	});

	it("computes depth, and survives a broken parent chain", () => {
		expect([depthOf(nodes, "r"), depthOf(nodes, "a"), depthOf(nodes, "a1")]).toEqual([0, 1, 2]);
		expect(depthOf([node("x", "missing")], "x")).toBe(0);
		expect(depthOf([node("x", "y"), node("y", "x")], "x")).toBeLessThan(3);
	});

	it("walks a tree parents first", () => {
		expect(treeOf(nodes, "r").map((n) => n.id)).toEqual(["r", "a", "a1", "b"]);
		expect(treeOf(nodes, "a").map((n) => n.id)).toEqual(["a", "a1"]);
	});

	it("renders an indented tree and marks the asking node", () => {
		expect(formatTree(nodes, { self: "a1" })).toBe(
			[
				"checkout  [feature]  r  idle  roles=coordinator",
				"├─ a  [task]  a  idle",
				"│  └─ a1  [task]  a1  idle  (you)",
				"└─ b  [task]  b  idle  branch=lattice/b",
			].join("\n"),
		);
	});
});
