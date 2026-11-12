/** The canopy of a team with a server: issues on the levels of the team's scheme, with sessions on them. */
import { DEFAULT_SCHEME, type Issue, type Scheme, type WorkSession, type WorkState } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, initial, interpret, pathTo, renderPlain } from "../src/index.ts";
import { LEVELS, world } from "./fixture.ts";

let next = 1;
const issue = (title: string, type: string, parent?: number, more: Partial<Issue> = {}): Issue => ({ number: next++, title, body: "", type, state: "todo", ...(parent !== undefined ? { parent } : {}), labels: [], fields: {}, author: "yan", createdAt: 0, updatedAt: 0, rev: 1, ...more });
const session = (owner: string, id: string, on: number | undefined, state: WorkSession["state"], more: Partial<WorkSession> = {}): WorkSession => ({ host: `${owner}:shop`, owner, repo: "shop", id, name: id, role: "implementation", state, ...(on !== undefined ? { issue: on } : {}), asks: state === "asking" ? 1 : 0, ...more });

/** A small team: yan runs this canopy; sam and teo are teammates, teo away. */
const team = (scheme: Scheme = DEFAULT_SCHEME): WorkState => {
	next = 1;
	const issues = [
		issue("Checkout", "epic", undefined, { state: "doing", assignee: "yan" }), // 1
		issue("Pay by card", "feature", 1, { state: "doing", assignee: "sam", labels: ["web"] }), // 2
		issue("Enter a card", "story", 2, { state: "doing", assignee: "sam" }), // 3
		issue("Card form", "task", 3, { state: "doing" }), // 4
		issue("Validate number", "task", 3, { state: "done" }), // 5
		issue("Error states", "task", 3), // 6
		issue("Refunds", "feature", 1, { assignee: "teo" }), // 7
		issue("Search", "epic"), // 8
		issue("Total is wrong", "bug", 2, { state: "doing", assignee: "yan" }), // 9
		issue("Old idea", "epic", undefined, { state: "dropped" }), // 10
		issue("Loose end", "task", 8), // 11: a task under an epic, which the default scheme does not allow
	];
	return {
		url: "https://lattice.example.com", me: "yan", connected: true, scheme, issues,
		people: [{ name: "yan", online: true }, { name: "sam", online: true }, { name: "teo", online: false }],
		sessions: [session("sam", "sam-form", 4, "working", { activity: "editing form.tsx" }), session("sam", "sam-review", 4, "idle", { role: "review" }), session("sam", "sam-story", 3, "asking"), session("teo", "teo-scratch", undefined, "idle")],
	};
};
/** yan's own sessions, as their host has them: one on the bug, one on no issue. */
const mine = (work: WorkState) => {
	const source = world([["fix total", "task", "implementation run"], ["scratch", "task", "idle"]], "yan", { work });
	(source.state.nodes[0] as { issue?: number }).issue = 9;
	source.state.sharing = null;
	return source;
};
const build = (work = team()) => buildWorld([mine(work)], LEVELS);
const press = (w: ReturnType<typeof build>, state: ReturnType<typeof initial>, ...keys: CanopyKey[]) => keys.reduce((at, key) => interpret(w, at.state, key, 150, 40), { state, actions: [] as ReturnType<typeof interpret>["actions"] });

describe("the canopy of a team with a server", () => {
	it("draws issues on the levels of the scheme, owned by whoever they are assigned to, with the sessions on them", () => {
		const w = build();
		expect(w.root.name).toBe("lattice.example.com");
		expect(w.levels).toEqual(["epic", "feature", "story", "task / bug"]);
		expect(w.me).toBe("yan");
		expect(w.people.map((person) => [person.name, person.online])).toEqual([["yan", true], ["sam", true], ["teo", false]]);

		const at = (id: string) => w.items.get(id);
		expect(pathTo(at("#4") as never).map((item) => item.id)).toEqual(["#4", "#3", "#2", "#1", "canopy:root"]);
		expect([at("#1")?.level, at("#2")?.level, at("#3")?.level, at("#4")?.level, at("#9")?.level]).toEqual([0, 1, 2, 3, 3]);
		// Assigned to nobody, it is whoever's session is on it; with nobody on it either, nobody's.
		expect([at("#2")?.owner, at("#4")?.owner, at("#6")?.owner]).toEqual(["sam", "sam", ""]);

		// The most pressing session on an issue is its agent; the other sits beside it.
		expect(at("#4")?.agent).toMatchObject({ role: "implementation", state: "working", owner: "sam", activity: "editing form.tsx" });
		expect(at("#4")?.buds.map((bud) => [bud.id, bud.agent?.role])).toEqual([["sam-review", "review"]]);
		expect(at("#3")).toMatchObject({ asks: 1, agent: { state: "asking" } });
		// This person's own session comes from their host, so it can be opened.
		expect(at("#9")).toMatchObject({ owner: "yan", agent: { state: "working", owner: "yan" }, node: { id: "fix total" } });

		expect(at("#5")).toMatchObject({ done: true, planned: false });
		expect(at("#6")).toMatchObject({ done: false, planned: true, agent: undefined });
		expect(at("#10")).toBeUndefined();
		expect(at("#11")?.misfit).toBe("A task goes under a story, not under an epic.");
		// Sessions on no issue are still shown: nothing that runs is hidden.
		expect(w.root.children.map((item) => item.id)).toEqual(["#1", "#8", "scratch", "teo-scratch"]);
		// Progress is counted at the tips: of the story's three tasks, one is done.
		expect([at("#3")?.landed, at("#3")?.leaves]).toEqual([1, 3]);
		expect(w.people.find((person) => person.name === "sam")).toMatchObject({ working: 1, asking: 1 });
	});

	it("follows the team's own scheme: other types, other levels", () => {
		const scheme: Scheme = {
			types: [{ name: "goal", level: 0, under: [], top: true }, { name: "chore", level: 1, under: ["goal"], top: true }],
			states: [{ name: "next", kind: "open" }, { name: "now", kind: "active" }, { name: "shipped", kind: "done" }],
			fields: [], rules: {},
		};
		const base = team(scheme);
		next = 1;
		const work: WorkState = { ...base, issues: [issue("Sell things", "goal", undefined, { state: "now" }), issue("Renew the certificate", "chore", 1, { state: "shipped" }), issue("An old epic", "epic", undefined, { state: "todo" })], sessions: [] };
		const w = build(work);
		expect(w.levels).toEqual(["goal", "chore"]);
		expect(w.items.get("#2")).toMatchObject({ level: 1, done: true });
		// What the scheme left behind is still drawn, and says why it does not fit.
		expect(w.items.get("#3")).toMatchObject({ level: 0, misfit: '"epic" is not a type. The types are: goal, chore.' });
	});

	it("is drawn as a screen: the issue, its state, who it is for, and whose session is on it", async () => {
		const w = build();
		const state = { ...initial(w, undefined), selected: "#4" };
		const lines = renderPlain(w, state, 150, 40);
		await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot("./snapshots/work-screen.txt");
		const text = lines.join("\n");
		expect(lines[1]).toMatch(/^ lattice\.example\.com ▸ Checkout ▸ Pay by card ▸ Enter a card ▸ Card form {2}task #4/);
		expect(text).toMatch(/#4 {2}doing {2}unassigned/);
		expect(text).toContain("sam's, in shop");
		expect(text).toContain("editing form.tsx");
		expect(lines.at(-1)).toContain("put this session on it");
		const misplaced = renderPlain(w, { ...state, selected: "#11" }, 150, 40).join("\n");
		expect(misplaced).toContain("▲ misplaced");
		expect(misplaced).toContain("A task goes under a story,");
	});

	it("puts this session on an issue with s, opens this person's own session, and says whose a teammate's is", () => {
		const w = build();
		const state = initial(w, undefined);
		expect(press(w, { ...state, selected: "#6" }, "s").actions).toEqual([{ do: "on", number: 6 }]);
		expect(press(w, { ...state, selected: "#6" }, "enter").actions).toEqual([{ do: "say", text: "Nobody is on #6 yet. Press s to put the session open here on it." }]);
		expect(press(w, { ...state, selected: "#9" }, "enter").actions).toEqual([{ do: "open", id: "fix total", tree: "/shop/.lattice" }]);
		expect(press(w, { ...state, selected: "#4" }, "enter").actions).toEqual([{ do: "say", text: "That is sam's session, running on their machine." }]);
		expect(press(w, { ...state, selected: "teo-scratch" }, "enter").actions).toEqual([{ do: "say", text: "That is teo's session, running on their machine." }]);
		expect(press(w, { ...state, selected: "#5" }, "enter").actions).toEqual([{ do: "say", text: "#5 is finished, and nobody is on it." }]);
		// What needs someone is found the same way as before.
		expect(press(w, state, "tab").state.selected).toBe("#3");
	});

	it("adds an issue where the scheme allows one, typed at the foot of the screen", () => {
		const w = build();
		const state = { ...initial(w, undefined), selected: "#2" };
		// Under a feature goes a story: the first type the scheme allows there.
		const typing = press(w, state, "n", "R", "e", "t", "r", "y", "x", "backspace", " ", "q");
		expect(typing.state.typing).toEqual({ what: "add", label: "New story under #2", text: "Retry q", number: 2 });
		expect(typing.actions).toEqual([]);
		expect(renderPlain(w, typing.state, 150, 40).at(-1)).toMatch(/^ {2}New story under #2: Retry q▏ +⏎ {2}add +esc {2}cancel/);
		// Keys that mean something elsewhere are text here; escape leaves without adding.
		expect(press(w, typing.state, "escape").state.typing).toBeUndefined();
		expect(press(w, typing.state, "escape").actions).toEqual([]);
		const added = press(w, typing.state, "enter");
		expect(added.actions).toEqual([{ do: "run", command: "/lattice issue add 2 Retry q", saying: "Adding it…" }]);
		expect(added.state.typing).toBeUndefined();
		// At the top goes an epic; under a task goes nothing.
		expect(press(w, state, "N", "X", "enter").actions).toEqual([{ do: "run", command: "/lattice issue add top X", saying: "Adding it…" }]);
		expect(press(w, { ...state, selected: "#4" }, "n").state.typing?.label).toBe("New bug under #4");
		expect(press(w, { ...state, selected: "#9" }, "n").actions).toEqual([{ do: "say", text: "Nothing goes under a bug in your team's scheme." }]);
		// Nothing typed adds nothing.
		expect(press(w, state, "n", "enter").actions).toEqual([]);
	});

	it("moves an issue to its next state, assigns it, and comments on it, each with one key", () => {
		const w = build();
		const state = initial(w, undefined);
		expect(press(w, { ...state, selected: "#6" }, "e").actions).toEqual([{ do: "run", command: "/lattice issue set 6 state doing", saying: "Moving #6 to doing…" }]);
		expect(press(w, { ...state, selected: "#4" }, "e").actions).toEqual([{ do: "run", command: "/lattice issue set 4 state review", saying: "Moving #4 to review…" }]);
		// After the last state comes the first: finished work is reopened, never dropped by this key.
		expect(press(w, { ...state, selected: "#5" }, "e").actions).toEqual([{ do: "run", command: "/lattice issue set 5 state todo", saying: "Moving #5 to todo…" }]);
		expect(press(w, { ...state, selected: "#6" }, "m").actions).toEqual([{ do: "run", command: "/lattice issue set 6 assignee yan", saying: "Assigning #6 to you…" }]);
		expect(press(w, { ...state, selected: "#9" }, "m").actions).toEqual([{ do: "run", command: "/lattice issue set 9 assignee none", saying: "Taking #9 off you…" }]);
		expect(press(w, { ...state, selected: "#6" }, "t", "o", "k", "enter").actions).toEqual([{ do: "run", command: "/lattice issue comment 6 ok", saying: "Commenting…" }]);
		// A session is not an issue.
		expect(press(w, { ...state, selected: "scratch" }, "e").actions).toEqual([{ do: "say", text: "Select an issue first." }]);
		expect(renderPlain(w, { ...state, selected: "#6" }, 190, 40).at(-1)).toMatch(/s {2}put this session on it +n {2}new under it +e {2}next state +m {2}mine +t {2}comment/);
	});

	it("changes nothing while the server cannot be reached, and says why", () => {
		const w = build({ ...team(), connected: false, problem: "The server at https://lattice.example.com cannot be reached." });
		expect(press(w, { ...initial(w, undefined), selected: "#6" }, "e").actions).toEqual([{ do: "say", text: "Nothing can be changed: The server at https://lattice.example.com cannot be reached." }]);
	});
});
