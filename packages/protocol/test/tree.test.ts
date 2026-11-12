import { describe, expect, it } from "vitest";
import { ancestorsOf, childrenOf, depthOf, formatTree, isHeld, isPlanned, type NodeMeta, reportsTo, treeOf, waitingFor } from "../src/index.ts";

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

	it("lists what is above a node, nearest first, and survives a cycle", () => {
		expect(ancestorsOf(nodes, "a1").map((n) => n.id)).toEqual(["a", "r"]);
		expect(ancestorsOf(nodes, "r")).toEqual([]);
		expect(ancestorsOf([node("x", "y"), node("y", "x")], "x").length).toBeLessThan(3);
	});

	it("says what a node still waits for: the sessions it names that have not sent their result", () => {
		const waiting = node("c", "r", { waitsOn: ["a", "b", "gone"] });
		const all = [...nodes.map((n) => (n.id === "a" ? { ...n, done: true } : n)), waiting];
		expect(waitingFor(all, waiting).map((n) => n.id)).toEqual(["b"]);
		expect(isHeld(waiting)).toBe(true);
		expect(isHeld(node("d", "r"))).toBe(false);
		// The tree names them, or gives the id of one it does not know.
		expect(formatTree(all)).toContain("c  [task]  c  idle  waits-on=a+b+gone");
	});

	it("knows planned work, and who a node answers to past the items nobody is on", () => {
		const feature = node("f", "r", { planned: true });
		const story = node("s", "f", { planned: true });
		const task = node("t", "s");
		const all = [...nodes, feature, story, task];
		expect(isPlanned(story)).toBe(true);
		expect(isHeld(story)).toBe(true);
		expect(isPlanned(task)).toBe(false);
		// The task answers to the root: the two items above it have no session.
		expect(reportsTo(all, task)?.id).toBe("r");
		expect(reportsTo(all, node("x", "a"))?.id).toBe("a");
		expect(reportsTo(all, node("root", null))).toBeUndefined();
		expect(formatTree(all)).toContain("s  [task]  s  idle  planned");
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
