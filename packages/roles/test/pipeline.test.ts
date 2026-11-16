/** How a list of role names becomes prompt sections: parts, conditions and values; and the layers a role is read from. */
import { describe, expect, it } from "vitest";
import { bodyHash, expand, type Fragment, layer, render, roleSections } from "../src/index.ts";

const fragment = (name: string, over: Partial<Fragment> = {}): Fragment => ({
	name, summary: `${name} summary`, body: `${name} body`, requires: [], conflicts: [], includes: [], when: [], unless: [], keep: false, mode: "replace", source: "builtin", path: `/b/${name}.md`, ...over,
});
const catalog = (...fragments: Fragment[]): Map<string, Fragment> => new Map(fragments.map((f) => [f.name, f]));
const names = (fragments: readonly Fragment[]): string[] => fragments.map((f) => f.name);

describe("expand", () => {
	const all = catalog(
		fragment("coordinator", { includes: ["tending", "plan-items"] }),
		fragment("tending", { includes: ["directions"] }),
		fragment("directions"),
		fragment("plan-items"),
		fragment("worker"),
	);

	it("puts a fragment's parts after it, and theirs after them", () => {
		expect(names(expand(["coordinator", "worker"], all))).toEqual(["coordinator", "tending", "directions", "plan-items", "worker"]);
	});

	it("applies each fragment once, where it first comes", () => {
		expect(names(expand(["plan-items", "coordinator"], all))).toEqual(["plan-items", "coordinator", "tending", "directions"]);
	});

	it("passes over names that are not installed, as parts or by themselves", () => {
		expect(names(expand(["gone", "worker"], all))).toEqual(["worker"]);
		expect(names(expand(["a"], catalog(fragment("a", { includes: ["gone", "b"] }), fragment("b"))))).toEqual(["a", "b"]);
	});

	it("does not go round for ever when two fragments include each other", () => {
		expect(names(expand(["a"], catalog(fragment("a", { includes: ["b"] }), fragment("b", { includes: ["a"] }))))).toEqual(["a", "b"]);
	});
});

describe("expand, given what is so", () => {
	const all = catalog(
		fragment("worker"),
		fragment("tending", { when: ["board"] }),
		fragment("plan-items", { when: ["tool.plan_item"], unless: ["board"] }),
		fragment("lead", { when: ["board"], includes: ["always"] }),
		fragment("always"),
	);
	const applied = ["worker", "tending", "plan-items"];

	it("keeps a fragment only while what it needs is so", () => {
		expect(names(expand(applied, all, {}))).toEqual(["worker"]);
		expect(names(expand(applied, all, { "tool.plan_item": "yes" }))).toEqual(["worker", "plan-items"]);
		expect(names(expand(applied, all, { "tool.plan_item": "yes", board: "yes" }))).toEqual(["worker", "tending"]);
	});

	it("leaves out the parts of a fragment that does not apply, and gives everything when not told what is so", () => {
		expect(names(expand(["lead"], all, {}))).toEqual([]);
		expect(names(expand(["lead"], all, { board: "yes" }))).toEqual(["lead", "always"]);
		expect(names(expand(["lead", "tending"], all))).toEqual(["lead", "always", "tending"]);
	});
});

describe("render", () => {
	it("fills in what is so, and leaves a name nobody gave as it was written", () => {
		expect(render(fragment("x", { body: "Levels: {{levels}}. Unknown: {{nope}}." }), { levels: "goal, step" })).toBe("Levels: goal, step. Unknown: {{nope}}.");
	});

	it("leaves text with nothing to fill in exactly as it is", () => {
		const body = "Do the work.\n\n- One.\n- Two { braces } stay.";
		expect(render(fragment("x", { body }), { levels: "a" })).toBe(body);
	});
});

describe("roleSections", () => {
	const all = catalog(
		fragment("protocol"),
		fragment("coordinator", { includes: ["plan-items", "tending"] }),
		fragment("plan-items", { when: ["tool.plan_item"], unless: ["board"], body: "Lay it out by level ({{levels}})." }),
		fragment("tending", { when: ["board"], body: "Keep the issues. Types: {{types}}." }),
	);

	it("writes a section for each fragment that applies, parts included, and lists them in the index", () => {
		const sections = roleSections(["protocol", "coordinator"], all, { board: "yes", types: "epic, task", "tool.plan_item": "yes" });
		expect(Object.keys(sections)).toEqual(["lattice-roles", "lattice-role-protocol", "lattice-role-coordinator", "lattice-role-tending"]);
		expect(sections["lattice-roles"]).toContain("protocol, coordinator, tending");
		expect(sections["lattice-role-tending"]).toBe("Keep the issues. Types: epic, task.");
	});

	it("writes the other part where the facts are the other way", () => {
		const sections = roleSections(["protocol", "coordinator"], all, { "tool.plan_item": "yes", levels: "epic, feature" });
		expect(Object.keys(sections)).toEqual(["lattice-roles", "lattice-role-protocol", "lattice-role-coordinator", "lattice-role-plan-items"]);
		expect(sections["lattice-role-plan-items"]).toBe("Lay it out by level (epic, feature).");
	});

	it("with nothing known, writes only what needs nothing", () => {
		expect(Object.keys(roleSections(["protocol", "coordinator"], all))).toEqual(["lattice-roles", "lattice-role-protocol", "lattice-role-coordinator"]);
	});
});

describe("layer", () => {
	const builtin = fragment("worker", { body: "Do one piece of work.", summary: "One piece", slot: "stance" });

	it("lets a higher place replace a role, as before", () => {
		const mine = fragment("worker", { body: "Mine.", source: "user", path: "/u/worker.md" });
		expect(layer([[builtin], [mine]]).get("worker")).toMatchObject({ body: "Mine.", source: "user", path: "/u/worker.md" });
	});

	it("lets a higher place add to a role, keeping everything else about it", () => {
		const addition = fragment("worker", { body: "Run npm run check before you report.", mode: "append", source: "project", path: "/p/worker.md", summary: "", keep: true });
		const layered = layer([[builtin], [addition]]).get("worker");
		expect(layered).toMatchObject({ body: "Do one piece of work.\n\nRun npm run check before you report.", summary: "One piece", slot: "stance", keep: false, source: "project", path: "/p/worker.md", addsTo: { source: "builtin", path: "/b/worker.md" } });
	});

	it("adds in every place that adds, lowest first", () => {
		const user = fragment("worker", { body: "User rule.", mode: "append", source: "user", path: "/u/worker.md" });
		const project = fragment("worker", { body: "Project rule.", mode: "append", source: "project", path: "/p/worker.md" });
		expect(layer([[builtin], [user], [project]]).get("worker")?.body).toBe("Do one piece of work.\n\nUser rule.\n\nProject rule.");
	});

	it("takes an addition with nothing beneath it as the role itself", () => {
		const alone = fragment("house", { body: "House rules.", mode: "append", source: "user", path: "/u/house.md" });
		const layered = layer([[builtin], [alone]]).get("house");
		expect(layered).toMatchObject({ body: "House rules.", source: "user" });
		expect(layered?.addsTo).toBeUndefined();
	});

	it("marks a copy whose original has changed since it was made, and no other", () => {
		const fresh = fragment("worker", { body: "Mine.", source: "user", path: "/u/worker.md", base: bodyHash(builtin.body) });
		const old = fragment("worker", { body: "Mine.", source: "user", path: "/u/worker.md", base: bodyHash("Do one job.") });
		const unmarked = fragment("worker", { body: "Mine.", source: "user", path: "/u/worker.md" });
		expect(layer([[builtin], [fresh]]).get("worker")?.stale).toBeUndefined();
		expect(layer([[builtin], [old]]).get("worker")?.stale).toBe(true);
		expect(layer([[builtin], [unmarked]]).get("worker")?.stale).toBeUndefined();
	});

	it("uses the first of a name within one place, and sorts by name", () => {
		const first = fragment("b", { body: "first" });
		const second = fragment("b", { body: "second" });
		const layered = layer([[first, second, fragment("a")]]);
		expect([...layered.keys()]).toEqual(["a", "b"]);
		expect(layered.get("b")?.body).toBe("first");
	});
});
