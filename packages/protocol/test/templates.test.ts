import { describe, expect, it } from "vitest";
import { renderTemplate, TEMPLATE_NAMES, TEMPLATES, templatePaths } from "../src/index.ts";

describe("templates", () => {
	it("fills names in, and keeps a section only when its name has a value", () => {
		const values = { "parent.name": "checkout", "parent.id": "nd_1", name: "payments", kind: "task", brief: "Do it." };
		expect(renderTemplate(TEMPLATES.brief.text, { ...values, branch: "lattice/payments" })).toBe(
			[
				'[pi-lattice] This session was created by another agent session, "checkout" (nd_1), as its child "payments" (kind: task).',
				"The brief below is from that agent, not typed by the user. The user can see this session and may join it at any time; their instructions take priority.",
				"You are working in your own git worktree on branch lattice/payments. Commit your work there.",
				"",
				"Brief:",
				"Do it.",
			].join("\n"),
		);
		expect(renderTemplate(TEMPLATES.brief.text, { ...values, branch: null })).not.toContain("worktree");
		expect(renderTemplate(TEMPLATES.brief.text, { ...values, branch: null })).toContain("priority.\n\nBrief:\nDo it.");
	});

	it("puts values in once, so braces in a brief are left as written", () => {
		expect(renderTemplate("{{brief}} / {{name}}", { brief: "use {{name}} and {{#x}}y{{/x}}", name: "n" })).toBe("use {{name}} and {{#x}}y{{/x}} / n");
		// A name the template has no value for is left alone, so a typo is visible.
		expect(renderTemplate("{{nmae}}", { name: "n" })).toBe("{{nmae}}");
	});

	it("mentions only the names it says it may", () => {
		for (const name of TEMPLATE_NAMES) {
			const template = TEMPLATES[name];
			const used = [...template.text.matchAll(/\{\{[#/]?([\w.-]+)\}\}/g)].map((match) => match[1]);
			for (const each of used) expect(template.vars, `${name} uses {{${each}}}`).toContain(each);
		}
	});

	it("looks in this repository's folder before the person's own", () => {
		expect(templatePaths("brief", { stateDir: "/r/.lattice", userDir: "/h/lattice" })).toEqual([
			{ path: "/r/.lattice/templates/brief.md", source: "repo" },
			{ path: "/h/lattice/templates/brief.md", source: "user" },
		]);
		expect(templatePaths("brief", { userDir: "/h/lattice" })).toEqual([{ path: "/h/lattice/templates/brief.md", source: "user" }]);
	});
});
