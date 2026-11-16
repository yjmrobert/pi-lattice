/** How a list of role names becomes prompt sections: parts, conditions and values. */
import { describe, expect, it } from "vitest";
import { expand, type Fragment, render, roleSections } from "../src/index.ts";

const fragment = (name: string, over: Partial<Fragment> = {}): Fragment => ({
	name, summary: `${name} summary`, body: `${name} body`, requires: [], conflicts: [], suggests: [], includes: [], when: [], unless: [], keep: false, source: "builtin", path: `/b/${name}.md`, ...over,
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
