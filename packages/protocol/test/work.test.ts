import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEME, fieldProblem, firstState, type Issue, isClosed, ladder, misfit, misplaced, normalizeScheme, type Scheme, schemeProblems, stateKind, wouldLoop } from "../src/index.ts";

const issue = (number: number, type: string, parent?: number, state = "todo"): Issue => ({ number, title: `#${number}`, body: "", type, state, ...(parent !== undefined ? { parent } : {}), labels: [], fields: {}, author: "yan", createdAt: 0, updatedAt: 0, rev: number });

describe("the default scheme", () => {
	it("is epics, features, stories and tasks, with bugs anywhere", () => {
		expect(schemeProblems(DEFAULT_SCHEME)).toEqual([]);
		expect(ladder(DEFAULT_SCHEME)).toEqual([["epic"], ["feature"], ["story"], ["task", "bug"]]);
		expect(firstState(DEFAULT_SCHEME)).toBe("todo");
	});

	it("says where a type goes when it is put somewhere else", () => {
		expect(misplaced(DEFAULT_SCHEME, "epic", undefined)).toBeUndefined();
		expect(misplaced(DEFAULT_SCHEME, "task", "story")).toBeUndefined();
		expect(misplaced(DEFAULT_SCHEME, "bug", undefined)).toBeUndefined();
		expect(misplaced(DEFAULT_SCHEME, "bug", "feature")).toBeUndefined();
		expect(misplaced(DEFAULT_SCHEME, "task", undefined)).toBe("A task goes under a story, not at the top.");
		expect(misplaced(DEFAULT_SCHEME, "task", "epic")).toBe("A task goes under a story, not under an epic.");
		expect(misplaced(DEFAULT_SCHEME, "epic", "feature")).toBe("An epic goes at the top, not under a feature.");
		expect(misplaced(DEFAULT_SCHEME, "chore", undefined)).toBe('"chore" is not a type. The types are: epic, feature, story, task, bug.');
	});

	it("knows what its states mean, and treats one it does not know as open", () => {
		expect(stateKind(DEFAULT_SCHEME, "doing")).toBe("active");
		expect(stateKind(DEFAULT_SCHEME, "in review")).toBe("open");
		expect(isClosed(DEFAULT_SCHEME, { state: "done" })).toBe(true);
		expect(isClosed(DEFAULT_SCHEME, { state: "dropped" })).toBe(true);
		expect(isClosed(DEFAULT_SCHEME, { state: "todo" })).toBe(false);
	});
});

describe("a team's own scheme", () => {
	const flat: Scheme = {
		types: [
			{ name: "goal", level: 0, under: [], top: true },
			{ name: "bet", level: 1, under: ["goal"], top: true },
			{ name: "chore", level: 2, under: ["bet", "goal"], top: true },
		],
		states: [{ name: "next", kind: "open" }, { name: "in review", kind: "active" }, { name: "shipped", kind: "done" }],
		fields: [
			{ name: "estimate", type: "number", on: ["chore"] },
			{ name: "risk", type: "choice", choices: ["low", "high"], required: true, on: ["bet"] },
			{ name: "due", type: "date" },
			{ name: "reviewer", type: "person" },
		],
		rules: {},
	};

	it("is checked for being usable, with every problem named", () => {
		expect(schemeProblems(flat)).toEqual([]);
		expect(normalizeScheme(flat)).toEqual(flat);
		expect(schemeProblems("epics")).toEqual(["A scheme is an object with types, states, fields and rules."]);
		expect(schemeProblems({ types: [], states: [] })).toEqual(["A scheme needs at least one type.", "At least one type must be allowed at the top.", "A scheme needs a state for work that is not finished.", "A scheme needs a state for work that is done."]);
		expect(
			schemeProblems({
				types: [{ name: "Goal", level: 0, under: ["dream"], top: false }, { name: "x", level: 0, under: [], top: false }, { name: "x", level: 99, under: [], top: true }],
				states: [{ name: "open", kind: "open" }, { name: "closed", kind: "finished" }],
				fields: [{ name: "risk", type: "choice" }, { name: "size", type: "tshirt", on: ["nothing"] }],
			}),
		).toEqual([
			'Type "x" needs a level from 0 to 12.',
			'There are two types named "x".',
			'"Goal" cannot be the name of a type: use lower-case letters, digits, spaces, - and _, at most 32.',
			'Type "Goal" may sit under "dream", which is not a type.',
			'Type "x" can be put nowhere: it may sit under nothing and may not be at the top.',
			'State "closed" needs a kind: open, active, done, dropped.',
			"A scheme needs a state for work that is done.",
			'Field "risk" is a choice and needs its choices.',
			'Field "size" needs a type: text, number, date, person, choice.',
			'Field "size" is on "nothing", which is not a type.',
		]);
	});

	it("checks the values of its fields", () => {
		expect(fieldProblem(flat, "chore", { estimate: 3, due: "2026-03-31" })).toBeUndefined();
		expect(fieldProblem(flat, "chore", { estimate: "3" })).toBe('Field "estimate" is a number.');
		expect(fieldProblem(flat, "goal", { estimate: 3 })).toBe('Field "estimate" is for chore, not for a goal.');
		expect(fieldProblem(flat, "chore", { due: "soon" })).toBe('Field "due" is a date, written like 2026-03-31.');
		expect(fieldProblem(flat, "bet", {})).toBe('A bet needs "risk".');
		expect(fieldProblem(flat, "bet", { risk: "medium" })).toBe('Field "risk" is one of: low, high.');
		expect(fieldProblem(flat, "bet", { risk: "low", reviewer: "sam" }, ["yan", "sam"])).toBeUndefined();
		expect(fieldProblem(flat, "bet", { risk: "low", reviewer: "kim" }, ["yan", "sam"])).toBe('Field "reviewer" is a person in the team: yan, sam.');
		expect(fieldProblem(flat, "goal", { colour: "red" })).toBe('"colour" is not a field. The fields are: estimate, risk, due, reviewer.');
		expect(fieldProblem(DEFAULT_SCHEME, "task", { colour: "red" })).toBe('"colour" is not a field. The fields are: url.');
		expect(fieldProblem({ ...DEFAULT_SCHEME, fields: [] }, "task", { colour: "red" })).toBe('"colour" is not a field. The scheme has no fields.');
	});

	it("marks what a changed scheme left behind, without touching it", () => {
		const issues = new Map([issue(1, "epic"), issue(2, "feature", 1), issue(3, "task", 2), issue(4, "story", 2, "in qa")].map((entry) => [entry.number, entry]));
		expect(misfit(DEFAULT_SCHEME, issues.get(2) as Issue, issues)).toBeUndefined();
		expect(misfit(DEFAULT_SCHEME, issues.get(3) as Issue, issues)).toBe("A task goes under a story, not under a feature.");
		expect(misfit(DEFAULT_SCHEME, issues.get(4) as Issue, issues)).toBe('"in qa" is no longer a state.');
		expect(misfit(flat, issues.get(1) as Issue, issues)).toBe('"epic" is not a type. The types are: goal, bet, chore.');
	});
});

describe("the tree of issues", () => {
	it("refuses a parent that is the issue itself or anything under it", () => {
		const issues = new Map([issue(1, "epic"), issue(2, "feature", 1), issue(3, "story", 2)].map((entry) => [entry.number, entry]));
		expect(wouldLoop(issues, 1, 3)).toBe(true);
		expect(wouldLoop(issues, 2, 2)).toBe(true);
		expect(wouldLoop(issues, 3, 1)).toBe(false);
	});
});
