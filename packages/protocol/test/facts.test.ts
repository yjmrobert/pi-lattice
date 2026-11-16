import { describe, expect, it } from "vitest";
import { applies, FACTS, holds, isFactName, isKnownFact, nodeFacts, toolFacts, YES } from "../src/facts.ts";
import { DEFAULT_SCHEME } from "../src/work.ts";

describe("facts", () => {
	it("hold when they have a text, like the names a template mentions", () => {
		expect(holds({ board: YES }, "board")).toBe(true);
		expect(holds({ board: "" }, "board")).toBe(false);
		expect(holds({}, "board")).toBe(false);
	});

	it("decide whether something applies: every fact of `when`, none of `unless`", () => {
		const facts = { board: YES, "tool.plan_item": YES };
		expect(applies({}, facts)).toBe(true);
		expect(applies({ when: ["board"] }, facts)).toBe(true);
		expect(applies({ when: ["board", "issue"] }, facts)).toBe(false);
		expect(applies({ when: ["tool.plan_item"], unless: ["board"] }, facts)).toBe(false);
		expect(applies({ when: ["tool.plan_item"], unless: ["board"] }, { "tool.plan_item": YES })).toBe(true);
	});

	it("know which names mean something: the ones a host gives, and any tool", () => {
		expect(FACTS.map((fact) => fact.name)).toEqual(["name", "kind", "parent.name", "issue", "board", "levels", "types"]);
		expect(isKnownFact("board")).toBe(true);
		expect(isKnownFact("tool.spawn_session")).toBe(true);
		expect(isKnownFact("tool.")).toBe(false);
		expect(isKnownFact("weather")).toBe(false);
		expect(isFactName("parent.name")).toBe(true);
		expect(isFactName("not a name")).toBe(false);
	});

	it("make a fact of each tool a session has", () => {
		expect(toolFacts(["spawn_session", "bash"])).toEqual({ "tool.spawn_session": YES, "tool.bash": YES });
	});

	describe("of a session", () => {
		const node = { name: "card form", kind: "task" };

		it("say where it is in the tree, and leave out what is not so", () => {
			expect(nodeFacts({ node, levels: ["epic", "feature", "story", "task"] })).toEqual({ name: "card form", kind: "task", levels: "epic, feature, story, task" });
			expect(nodeFacts({ node: { ...node, issue: 38 }, parent: { name: "checkout" }, levels: [] })).toEqual({ name: "card form", kind: "task", "parent.name": "checkout", issue: "38" });
		});

		it("take the levels and the types from the team's scheme once there is a server", () => {
			const facts = nodeFacts({ node, levels: ["big", "small"], work: { scheme: DEFAULT_SCHEME } });
			expect(facts.board).toBe(YES);
			// One name for each level: bug shares task's level and is not a level of its own.
			expect(facts.levels).toBe("epic, feature, story, task");
			expect(facts.types).toBe("epic, feature, story, task, bug");
		});

		it("name the team's own levels when its scheme is not the default one", () => {
			const scheme = { ...DEFAULT_SCHEME, types: [{ name: "goal", level: 0, under: [], top: true }, { name: "step", level: 1, under: ["goal"], top: false }] };
			expect(nodeFacts({ node, levels: ["epic"], work: { scheme } })).toMatchObject({ levels: "goal, step", types: "goal, step" });
		});
	});
});
