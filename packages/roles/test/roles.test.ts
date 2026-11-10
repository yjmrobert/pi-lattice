import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advisories, builtinFragmentsDir, editRoles, type Fragment, fragmentRoots, loadFragments, parseFragment, roleSections } from "../src/index.ts";

const fragment = (name: string, over: Partial<Fragment> = {}): Fragment => ({
	name, summary: `${name} summary`, body: `${name} body`, requires: [], conflicts: [], suggests: [], source: "test", path: `/x/${name}.md`, ...over,
});
const available = new Map(
	[fragment("coordinator", { conflicts: ["worker"] }), fragment("worker"), fragment("planning", { requires: ["coordinator"] }), fragment("feature")].map((f) => [f.name, f]),
);

describe("parseFragment", () => {
	it("reads frontmatter and body", () => {
		const parsed = parseFragment("---\nname: grilling\nsummary: Ask hard questions\nrequires: [worker]\nconflicts: a, b\n---\n\nInterrogate the story.\n", "/r/x.md", "user");
		expect(parsed).toMatchObject({ name: "grilling", summary: "Ask hard questions", body: "Interrogate the story.", requires: ["worker"], conflicts: ["a", "b"], source: "user" });
	});

	it("falls back to the file name when there is no frontmatter", () => {
		expect(parseFragment("Just guidance.", "/r/my-role.md", "user")).toMatchObject({ name: "my-role", body: "Just guidance." });
	});

	it("rejects names that could not be a section tag, and empty bodies", () => {
		expect(parseFragment("---\nname: Bad Name!\n---\nbody", "/r/x.md", "user")).toBeUndefined();
		expect(parseFragment("---\nname: empty\n---\n\n", "/r/x.md", "user")).toBeUndefined();
	});
});

describe("loadFragments", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-lattice-roles-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const write = (dir: string, file: string, content: string) => {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, file), content);
	};

	it("ships built-in fragments that all parse", () => {
		const builtin = loadFragments([{ dir: builtinFragmentsDir(), source: "builtin" }]);
		expect([...builtin.keys()]).toEqual(expect.arrayContaining(["coordinator", "worker", "planning"]));
		for (const f of builtin.values()) expect(f.summary).not.toBe("");
	});

	it("lets an earlier root override a later one by name, and finds nested files", () => {
		write("project", "coordinator.md", "---\nname: coordinator\nsummary: ours\n---\nProject coordinator.");
		write("user/nested", "reviewer.md", "Review carefully.");
		write("user", "README.md", "not a fragment");
		const found = loadFragments([
			{ dir: join(root, "project"), source: "project" },
			{ dir: join(root, "user"), source: "user" },
			{ dir: builtinFragmentsDir(), source: "builtin" },
		]);
		expect(found.get("coordinator")).toMatchObject({ source: "project", body: "Project coordinator." });
		expect(found.get("reviewer")?.source).toBe("user");
		expect(found.has("readme")).toBe(false);
		expect(found.get("worker")?.source).toBe("builtin");
	});

	it("reads project fragments only when the project is trusted", () => {
		const sources = (projectTrusted: boolean) => fragmentRoots({ cwd: root, agentDir: join(root, "agent"), projectTrusted }).map((r) => r.source);
		expect(sources(true)).toEqual(["project", "user", "builtin"]);
		expect(sources(false)).toEqual(["user", "builtin"]);
	});
});

describe("editRoles", () => {
	it("sets, adds in order without duplicates, and removes", () => {
		expect(editRoles([], "set", ["coordinator", "planning"], available).fragments).toEqual(["coordinator", "planning"]);
		expect(editRoles(["coordinator"], "add", ["feature", "coordinator"], available).fragments).toEqual(["coordinator", "feature"]);
		expect(editRoles(["coordinator", "planning"], "remove", ["planning"], available).fragments).toEqual(["coordinator"]);
	});

	it("applies nothing when a name is unknown", () => {
		expect(editRoles(["worker"], "add", ["feature", "nope"], available)).toEqual({ fragments: ["worker"], unknown: ["nope"], changed: false });
	});

	it("can remove a fragment that is no longer installed", () => {
		expect(editRoles(["gone", "worker"], "remove", ["gone"], available).fragments).toEqual(["worker"]);
	});

	it("reports whether anything changed", () => {
		expect(editRoles(["worker"], "add", ["worker"], available).changed).toBe(false);
		expect(editRoles(["worker", "feature"], "set", ["feature", "worker"], available).changed).toBe(true);
	});
});

describe("advisories", () => {
	it("notes missing companions and conflicts without blocking anything", () => {
		expect(advisories(["planning"], available)).toEqual(['"planning" is usually combined with "coordinator".']);
		expect(advisories(["coordinator", "worker"], available)).toEqual(['"coordinator" and "worker" give competing guidance.']);
		expect(advisories(["coordinator", "planning", "feature"], available)).toEqual([]);
	});

	it("notes an applied fragment that is not installed", () => {
		expect(advisories(["gone"], available)[0]).toContain("no such fragment");
	});
});

describe("roleSections", () => {
	it("emits an index then one section per fragment, in list order", () => {
		const sections = roleSections(["planning", "coordinator"], available);
		expect(Object.keys(sections)).toEqual(["lattice-roles", "lattice-role-planning", "lattice-role-coordinator"]);
		expect(sections["lattice-roles"]).toContain("planning, coordinator");
		expect(sections["lattice-role-planning"]).toBe("planning body");
	});

	it("emits nothing when no installed fragment is applied", () => {
		expect(roleSections([], available)).toEqual({});
		expect(roleSections(["gone"], available)).toEqual({});
	});
});
