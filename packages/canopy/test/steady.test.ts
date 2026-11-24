/**
 * What is selected is always something drawn, the window stays on it when the work moves it,
 * and a tree far wider than its window costs what the window costs, not what the tree does.
 */
import { DEFAULT_SCHEME, type Issue, type IssueEvent, type WorkSession, type WorkState } from "@pi-lattice/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, type CanopyState, cells, dotCount, dotsIn, followed, Grid, initial, interpret, paint, placed, placeOf, planOf, render, renderFirst, renderPlain, useColorDepth, wrapMessage } from "../src/index.ts";
import { LEVELS, world } from "./fixture.ts";

afterEach(() => useColorDepth("truecolor"));

const [W, H] = [150, 40];
type World = ReturnType<typeof buildWorld>;
let next = 1;
const issue = (title: string, type: string, parent?: number, more: Partial<Issue> = {}): Issue => ({ number: next++, rank: next, title, body: "", type, state: "todo", ...(parent !== undefined ? { parent } : {}), labels: [], fields: {}, author: "yan", createdAt: 0, updatedAt: 0, rev: 1, ...more });
const session = (owner: string, id: string, on: number, state: WorkSession["state"]): WorkSession => ({ host: `${owner}:shop`, owner, repo: "shop", id, name: id, role: "implementation", state, issue: on, asks: 0 });
const team = (issues: Issue[], more: Partial<WorkState> = {}): World => {
	const work: WorkState = { url: "https://lattice.example.com", me: "yan", connected: true, scheme: DEFAULT_SCHEME, issues, people: [{ name: "yan", online: true }, { name: "sam", online: true }], sessions: [], hosts: [], recent: [], seen: 0, ...more };
	const source = world([], "yan", { work });
	source.state.sharing = null;
	return buildWorld([source], LEVELS);
};
const press = (w: World, state: CanopyState, ...keys: CanopyKey[]) => keys.reduce((at, key) => interpret(w, at.state, key, W, H), { state, actions: [] as ReturnType<typeof interpret>["actions"] });
const drawn = (w: World, state: CanopyState): boolean => placeOf(planOf(w, state, W, H), state.selected) !== undefined;

describe("what is selected", () => {
	const board = (): World => {
		next = 1;
		// The first thing filed is finished, and at the top: with what is finished left out, nothing stands for it.
		return team([issue("Old epic", "epic", undefined, { state: "done" }), issue("Checkout", "epic", undefined, { state: "doing", assignee: "yan" }), issue("Pay", "feature", 2), issue("Refunds", "feature", 2)]);
	};

	it("is something drawn when the canopy opens with what is finished left out, so that the arrows lead somewhere", () => {
		const w = board();
		const state = initial(w, undefined, "grown", "dependency", "hidden");
		for (const key of ["right", "left", "up", "down", " "] as CanopyKey[]) {
			const after = press(w, state, key).state;
			expect([key, drawn(w, after), after.selected !== "#1"]).toEqual([key, true, true]);
		}
		expect(press(w, state, " ").state.typing).toMatchObject({ what: "say" });
	});

	it("moves to something drawn when what it was on is left out with d", () => {
		const w = board();
		const hidden = press(w, initial(w, "#1"), "d").state;
		expect([hidden.selected, drawn(w, hidden)]).toEqual(["#2", true]);
		expect(drawn(w, press(w, hidden, "right").state)).toBe(true);
	});

	it("is never the top of the tree: going through what agents changed stays on what is drawn", () => {
		next = 1;
		const change: IssueEvent = { rev: 2, issue: 1, who: "sam", at: 5, what: "state", from: "doing", to: "done", as: "sam-worker", why: "all merged" };
		// The change is on something finished at the top, which is left out: nothing above it is drawn but the top of the tree.
		const w = team([issue("Old epic", "epic", undefined, { state: "done" }), issue("Checkout", "epic", undefined, { state: "doing" }), issue("Pay", "feature", 2)], { recent: [change] });
		const state = initial(w, "#2", "grown", "dependency", "hidden");
		const looking = press(w, state, "u").state;
		expect(looking.viewing).toBeDefined();
		expect(looking.selected).toBe("#2");
		expect(drawn(w, looking)).toBe(true);
		// Whatever is selected, space is said about something, and never to the top of the tree.
		const saying = press(w, { ...state, selected: w.root.id }, " ").state;
		expect(saying.selected).not.toBe(w.root.id);
		expect(saying.typing).not.toMatchObject({ nodeId: w.root.id });
	});
});

describe("a session that helps on an item and asks", () => {
	type Spec = Parameters<typeof world>[0][number];
	const under = (helpers: Spec[]): World => buildWorld([world([["checkout", "epic", "coordinator idle", [["payments", "feature", "planner idle", [["cards", "story", "worker idle", helpers]]]]]])], LEVELS);

	it("is where tab goes, like anything else that needs someone", () => {
		const w = under([["review", "verify", "verifier ask"]]);
		const { state, actions } = press(w, initial(w, "checkout"), "tab");
		expect([state.selected, actions]).toEqual(["review", []]);
	});

	it("is written under the item ahead of the helpers that do not ask, however many there are", () => {
		const w = under([["rev-a", "verify", "verifier idle"], ["rev-b", "verify", "verifier idle"], ["rev-c", "verify", "verifier ask"]]);
		const state = initial(w, "checkout");
		expect(placeOf(planOf(w, state, W, H), "rev-c")).toMatchObject({ helper: true });
		expect(press(w, state, "tab").state.selected).toBe("rev-c");
		expect(renderPlain(w, state, W, H).join("\n")).toMatch(/● rev-c[\s\S]*rev-a \+1/);
	});
});

describe("the window on the tree", () => {
	const backlog = (taken: boolean): World => {
		next = 1;
		const issues = [issue("Shop", "epic", undefined, { state: "doing" }), issue("Backlog", "feature", 1, { state: "doing" })];
		for (let i = 0; i < 40; i++) issues.push(issue(`Story number ${i}`, "story", 2));
		return team(issues, { sessions: taken ? [session("sam", "sam-1", 42, "working")] : [] });
	};
	const onScreen = (w: World, state: CanopyState, width: number): boolean => {
		const place = placeOf(planOf(w, state, width, H), state.selected);
		return place !== undefined && place.col >= state.camera.col && place.col < state.camera.col + width;
	};

	it("goes with what is selected when the work moves it out of sight", () => {
		const [before, after] = [backlog(false), backlog(true)];
		// The last story, far to the right. A teammate's agent takes it: in order, what has started comes before what has not.
		const state = placed(before, initial(before, "#42"), 160, H);
		expect(onScreen(before, state, 160)).toBe(true);
		expect(onScreen(after, state, 160)).toBe(false);
		const moved = followed(before, after, state, 160, H);
		expect(onScreen(after, moved, 160)).toBe(true);
		expect(render(after, moved, 160, H, 0).join("\n")).toContain("Story number 39");
	});

	it("stays where a person moved it, away from what is selected", () => {
		const [before, after] = [backlog(false), backlog(true)];
		const state = placed(before, initial(before, "#42"), 160, H);
		const away = interpret(before, state, "home", 160, H).state;
		expect(onScreen(before, away, 160)).toBe(false);
		expect(followed(before, after, away, 160, H)).toBe(away);
		// Nothing moved: nothing to follow.
		expect(followed(before, backlog(false), state, 160, H)).toBe(state);
	});
});

describe("a tree far wider than its window", () => {
	const wide = (count: number): World => {
		next = 1;
		return team(Array.from({ length: count }, (_unused, index) => issue(`Backlog item number ${index}`, "story")));
	};

	it("is drawn the same in its window as when all of it is drawn", () => {
		const w = wide(60);
		const state = placed(w, initial(w, "#30"), 200, 50);
		const plan = planOf(w, state, 200, 50);
		expect(plan.width).toBeGreaterThan(1000);
		const window = { col: state.camera.col, row: state.camera.row, width: 160, height: 40 };
		const whole = paint(w, plan, { selected: "#30" }).lines(window.col, window.row, window.width, window.height);
		expect(paint(w, plan, { selected: "#30", window }).lines(window.col, window.row, window.width, window.height)).toEqual(whole);
		// At the left edge and the right one too, where branches leave the window on one side only.
		for (const col of [0, plan.width - 160]) {
			const at = { ...window, col };
			expect(paint(w, plan, { window: at }).lines(at.col, at.row, at.width, at.height)).toEqual(paint(w, plan).lines(at.col, at.row, at.width, at.height));
		}
	});

	it("gives the dots of a branch that are in the window, each where it is along the whole branch", () => {
		const w = wide(40);
		const plan = planOf(w, initial(w, "#1"));
		for (const branch of plan.branches.filter((entry) => entry.curve)) {
			const all = branch.points;
			expect(dotCount(branch)).toBe(all.length);
			const [from, to] = [600, 900];
			const got: Array<[number, number, number]> = [];
			dotsIn(branch, (x, y, index) => got.push([x, y, index]), from, to);
			// Every dot between the columns is there, as it is in the whole; a step either side of them may be too.
			for (const [x, y, index] of got) expect(all[index]).toEqual([x, y]);
			const wanted = all.flatMap(([x], index) => (x >= from && x <= to ? [index] : []));
			expect(got.map((dot) => dot[2])).toEqual(expect.arrayContaining(wanted));
			expect(got.length).toBeLessThanOrEqual(wanted.length + 8);
		}
	});

	it("is laid out and drawn without working out the dots of what is out of sight", () => {
		const w = wide(400);
		const state = placed(w, initial(w, "#200"), 200, 60);
		const started = performance.now();
		const lines = render(w, state, 200, 60, 1);
		// Every dot of every branch, some five million of them, took seconds here and hundreds of megabytes.
		expect(performance.now() - started).toBeLessThan(1500);
		expect(lines).toHaveLength(60);
		expect(lines.join("\n")).toContain("Backlog item number 199");
	});
});

describe("colour in a terminal with 256 of them", () => {
	it("ends the background of what is selected where its name ends", () => {
		for (const depth of ["truecolor", "256"] as const) {
			useColorDepth(depth);
			const grid = new Grid(24, 1);
			grid.text(2, 0, "name", { fg: "#ffffff", bg: "#3566c4", bold: true });
			grid.text(12, 0, "x", { fg: "#c6ccd9" });
			const line = grid.lines()[0] as string;
			// The blanks after the name are written after the colour has ended.
			expect(line, depth).toMatch(/name\u001b\[0m {6}/);
		}
	});
});

describe("a first message in characters two cells wide", () => {
	it("is wrapped by the cells it takes, and stays inside its box", () => {
		const text = "请为结账页面添加退款功能并且编写完整的端到端测试用例以及相应的文档说明谢谢".repeat(2);
		for (const row of wrapMessage(text, 61)) expect(cells(row)).toBeLessThanOrEqual(61);
		expect(wrapMessage(text, 61).join("")).toBe(text);
		expect(wrapMessage("结账 页面 添加", 5)).toEqual(["结账", "页面", "添加"]);
		const lines = renderFirst({ repo: "shop", draft: text }, 70, 30);
		const box = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "")).filter((line) => line.includes("│"));
		expect(box.length).toBeGreaterThan(2);
		// Every row of the box ends with its border, in the same column.
		for (const row of box) expect([cells(row.trimEnd()), row.trimEnd().endsWith("│")]).toEqual([cells((box[0] as string).trimEnd()), true]);
	});
});
