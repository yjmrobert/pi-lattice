import { describe, expect, it } from "vitest";
import { assignmentFromEnv, assignmentToEnv, type HostAssignment, newNodeId, sameAssignment } from "../src/index.ts";

const assignment: HostAssignment = {
	socket: "/run/x.sock", token: "t0k", nodeId: newNodeId(), parentId: newNodeId(), rootId: newNodeId(), kind: "task", name: "payments",
	fragments: ["worker", "implementation"], owner: "yan", home: "/proj/.lattice/home",
};

describe("host assignment", () => {
	it("survives the trip through an environment", () => {
		expect(assignmentFromEnv(assignmentToEnv(assignment))).toEqual(assignment);
	});

	it("keeps a root's missing parent as null, and an empty role list empty", () => {
		const root = { ...assignment, parentId: null, fragments: [] };
		expect(assignmentFromEnv(assignmentToEnv(root))).toEqual(root);
	});

	it("is absent unless a host supplied a complete one", () => {
		const env = assignmentToEnv(assignment);
		expect(assignmentFromEnv({})).toBeUndefined();
		for (const key of ["LATTICE_SOCK", "LATTICE_TOKEN", "LATTICE_NODE_ID", "LATTICE_HOME", "LATTICE_OWNER"]) {
			const { [key]: _dropped, ...partial } = env;
			expect(assignmentFromEnv(partial)).toBeUndefined();
		}
		expect(assignmentFromEnv({ ...env, LATTICE_NODE_ID: "../etc" })).toBeUndefined();
	});

	it("is not confused by a lone owner or home, which standalone sessions also set", () => {
		expect(assignmentFromEnv({ LATTICE_OWNER: "yan", LATTICE_HOME: "/x", LATTICE_NODE_NAME: "alpha" })).toBeUndefined();
	});

	it("compares by host, node and token", () => {
		expect(sameAssignment(assignment, { ...assignment, name: "renamed" })).toBe(true);
		expect(sameAssignment(assignment, { ...assignment, token: "other" })).toBe(false);
		expect(sameAssignment(null, undefined)).toBe(true);
		expect(sameAssignment(assignment, null)).toBe(false);
	});
});
