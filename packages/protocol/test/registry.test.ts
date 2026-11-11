import { describe, expect, it } from "vitest";
import { decodeTree, encodeTree, latticeHome, treeEntryName } from "../src/index.ts";

describe("the list of trees", () => {
	it("gives each state directory its own entry, with a name that says which", () => {
		expect(treeEntryName("/home/yan/src/shop/.lattice")).toMatch(/^home-yan-src-shop-lattice-[0-9a-f]{8}\.json$/);
		expect(treeEntryName("/a/b")).not.toBe(treeEntryName("/a-b"));
		expect(treeEntryName("/a/b")).toBe(treeEntryName("/a/b"));
	});

	it("reads back what it wrote, and treats a damaged entry as nothing", () => {
		const tree = { stateDir: "/a/.lattice", root: "/a" };
		expect(decodeTree(encodeTree(tree))).toEqual(tree);
		expect(decodeTree("{")).toBeUndefined();
		expect(decodeTree("null")).toBeUndefined();
		expect(decodeTree('{"stateDir":1,"root":"/a"}')).toBeUndefined();
	});

	it("lives in LATTICE_HOME, else under Pi's agent directory", () => {
		expect(latticeHome({ LATTICE_HOME: "/x" }, "/home/yan")).toBe("/x");
		expect(latticeHome({ PI_CODING_AGENT_DIR: "/agent" }, "/home/yan")).toBe("/agent/lattice");
		expect(latticeHome({}, "/home/yan")).toBe("/home/yan/.pi/agent/lattice");
	});
});
