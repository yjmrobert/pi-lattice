/** The canopy of a team with a server: issues on the levels of the team's scheme, with sessions on them. */
import { DEFAULT_SCHEME, type Issue, type IssueEvent, type Scheme, type Steer, type WorkSession, type WorkState } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { buildWorld, type CanopyKey, initial, interpret, pathTo, renderPlain } from "../src/index.ts";
import { LEVELS, world } from "./fixture.ts";

let next = 1;
const issue = (title: string, type: string, parent?: number, more: Partial<Issue> = {}): Issue => ({ number: next++, rank: next, title, body: "", type, state: "todo", ...(parent !== undefined ? { parent } : {}), labels: [], fields: {}, author: "yan", createdAt: 0, updatedAt: 0, rev: 1, ...more });
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
		hosts: [], recent: [], seen: 0,
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

	it("keeps an issue after what it waited on, once that is finished", () => {
		const work = team();
		// Pay by card (#2) waits on Refunds (#7), which was filed after it and is finished.
		(work.issues[1] as Issue).waitsOn = [7];
		(work.issues[6] as Issue).state = "done";
		const w = build(work);
		expect(w.items.get("#2")?.waitsOn).toEqual([]);
		expect(w.flow.before.get("#2")?.map((item) => item.name)).toEqual(["Refunds"]);
		expect(w.flow.held.has("#2")).toBe(false);
		expect(w.flow.ordered.get("#1")?.map((item) => item.name)).toEqual(["Refunds", "Pay by card"]);
		// Sessions on no issue stay at the foot.
		expect(w.flow.ordered.get(w.root.id)?.map((item) => item.name)).toEqual(["Checkout", "Search", "scratch", "teo-scratch"]);
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
		expect(press(w, { ...state, selected: "#6" }, "enter").actions).toEqual([{ do: "say", text: "Nobody is on #6 yet. Press space to say what should happen to it, or s to put the session open here on it." }]);
		expect(press(w, { ...state, selected: "#9" }, "enter").actions).toEqual([{ do: "open", id: "fix total", tree: "/shop/.lattice" }]);
		expect(press(w, { ...state, selected: "#4" }, "enter").actions).toEqual([{ do: "say", text: "That is sam's session, running on their machine." }]);
		expect(press(w, { ...state, selected: "teo-scratch" }, "enter").actions).toEqual([{ do: "say", text: "That is teo's session, running on their machine." }]);
		expect(press(w, { ...state, selected: "#5" }, "enter").actions).toEqual([{ do: "say", text: "#5 is finished, and nobody is on it." }]);
		// What needs someone is found the same way as before.
		expect(press(w, state, "tab").state.selected).toBe("#3");
	});

	it("says what a person wants about an issue to whatever tends it, typed at the foot of the screen", () => {
		// Nothing tends the work yet: the line says a session is started for it.
		const w = build();
		const state = { ...initial(w, undefined), selected: "#2" };
		const typing = press(w, state, " ", "t", "h", "i", "s", "x", "backspace", " ", "f", "i", "r", "s", "t");
		expect(typing.state.typing).toEqual({ what: "say", label: "to a session that is started to tend it, about Pay by card", text: "this first", number: 2 });
		expect(typing.actions).toEqual([]);
		const drawn = renderPlain(w, typing.state, 150, 40);
		expect(drawn.join("\n")).toContain("to a session that is started to tend it, about Pay by card");
		expect(drawn.join("\n")).toContain("› this first▏");
		expect(drawn.at(-1)).toMatch(/⏎ {2}send +esc {2}cancel/);
		// Keys that mean something elsewhere are text here; escape leaves without saying anything.
		expect(press(w, typing.state, "escape").state.typing).toBeUndefined();
		expect(press(w, typing.state, "escape").actions).toEqual([]);
		const said = press(w, typing.state, "enter");
		expect(said.actions).toEqual([{ do: "steer", number: 2, text: "this first" }]);
		expect(said.state.typing).toBeUndefined();
		// Nothing typed says nothing.
		expect(press(w, state, " ", "enter").actions).toEqual([]);
		// With a coordinator on the epic, the line names it: that is who it goes to.
		const tended = build({ ...team(), sessions: [...team().sessions, session("sam", "checkout", 1, "idle", { role: "coordinator" })] });
		expect(press(tended, { ...initial(tended, undefined), selected: "#4" }, " ").state.typing?.label).toBe("to sam's coordinator on Checkout, about Card form");
		expect(press(tended, { ...initial(tended, undefined), selected: "#1" }, " ").state.typing?.label).toBe("to sam's coordinator, about Checkout");
		// A teammate's session on no issue is theirs.
		expect(press(w, { ...state, selected: "teo-scratch" }, " ").actions).toEqual([{ do: "say", text: '"teo-scratch" is teo\'s. It is theirs to steer.' }]);
		// The keys that changed issues by hand are gone.
		for (const key of ["n", "N", "e", "m", "t"]) expect(press(w, { ...state, selected: "#6" }, key).actions).toEqual([]);
		expect(renderPlain(w, { ...state, selected: "#6" }, 190, 40).at(-1)).toMatch(/space {2}say what you want +tab {2}next that needs someone +s {2}put this session on it/);
	});

	it("marks what agents changed since the person looked, and walks through it with who and why", () => {
		const base = team();
		const event = (rev: number, issue: number, what: string, more: Partial<IssueEvent> = {}): IssueEvent => ({ rev, issue, who: "yan", at: 1_000 * rev, what, ...more });
		const w = build({
			...base,
			seen: 10,
			recent: [
				event(9, 6, "title", { as: "planner", why: "before the person looked" }),
				event(11, 6, "order", { to: "first", as: "planner", why: "the card form blocks the demo" }),
				event(12, 3, "state", { from: "todo", to: "doing" }),
				event(13, 2, "created", { as: "coordinator" }),
			],
		});
		// Only what an agent did, after the person last looked; what a person did by hand is not news.
		expect(w.changes.map((change) => [change.issue, change.what])).toEqual([[2, "created"], [6, "order"]]);
		expect(w.items.get("#6")?.fresh?.what).toBe("order");
		expect(w.items.get("#3")?.fresh).toBeUndefined();
		const state = { ...initial(w, undefined), selected: "#1" };
		const first = press(w, state, "u");
		expect(first.state).toMatchObject({ selected: "#2", viewing: "13:2" });
		const drawn = renderPlain(w, first.state, 150, 40).join("\n");
		expect(drawn).toContain("+ coordinator filed it");
		expect(drawn).toContain("It did not say why.");
		expect(drawn).toMatch(/x {2}put it back +u {2}next, 1 more/);
		const second = press(w, first.state, "u");
		expect(second.state).toMatchObject({ selected: "#6", viewing: "11:6" });
		expect(renderPlain(w, second.state, 150, 40).join("\n")).toContain("why  the card form blocks the demo");
		// Putting it back is a line to whatever tends it, with what was done and why.
		expect(press(w, second.state, "x").actions).toEqual([{ do: "steer", number: 6, text: 'Put this back: planner put it first, because "the card form blocks the demo". I do not want that.' }]);
		// Past the last one, the person has looked.
		const done = press(w, second.state, "u");
		expect(done.actions).toEqual([{ do: "seen" }, { do: "say", text: "That is everything agents changed since you looked." }]);
		expect(done.state.viewing).toBeUndefined();
		// Moving away leaves the change; the header counts what there is.
		expect(press(w, first.state, "left").state.viewing).toBeUndefined();
		expect(renderPlain(w, state, 190, 40)[1]).toContain("+2 changed by agents");
		expect(press(build(), state, "u").actions).toEqual([{ do: "say", text: "No agent has changed anything since you looked." }]);
	});

	it("draws what a person said and what was answered at the foot, and the directions that reach an item", () => {
		const base = team();
		const issues = base.issues.map((entry) => (entry.number === 1 ? { ...entry, directions: [{ id: 7, who: "yan", text: "ask me before anything here lands", at: 5 }] } : entry));
		const steer = (answer?: string): Steer => ({ id: "s1", at: 1_000, text: "this first", about: "#2 Pay by card (feature)", number: 2, to: { nodeId: "n1", name: "checkout", role: "coordinator" }, ...(answer ? { answer, answeredAt: 2_000 } : {}) });
		const withSteers = (steers: Steer[]) => {
			const source = mine({ ...base, issues });
			source.state.steers = steers;
			return buildWorld([source], LEVELS);
		};
		const reading = withSteers([steer()]);
		const waiting = renderPlain(reading, { ...initial(reading, undefined), selected: "#4" }, 150, 40).join("\n");
		expect(waiting).toContain("you  this first   about #2 Pay by card (feature)");
		expect(waiting).toContain("coordinator on checkout is reading it…");
		const answered = withSteers([steer("Pay by card is first under Checkout now.")]);
		const drawn = renderPlain(answered, { ...initial(answered, undefined), selected: "#4" }, 150, 40).join("\n");
		expect(drawn).toContain("coordinator on checkout  Pay by card is first under Checkout now.");
		// A direction on the epic reaches the task under it, and is marked where it stands.
		expect(answered.items.get("#4")?.directions).toMatchObject([{ text: "ask me before anything here lands", on: "#1" }]);
		expect(drawn).toContain("DIRECTIONS");
		expect(drawn).toContain("⚑ ask me before anything here lands");
		expect(drawn).toContain("@yan, on Checkout");
		expect(drawn).toMatch(/Checkout ⚑/);
	});

	it("draws the issues under each item in the order the agents keep, and an agent that holds one from a shell", () => {
		const base = team();
		// The second feature is put first; the task nobody is on is held by an agent with no host.
		const issues = base.issues.map((entry) => (entry.number === 7 ? { ...entry, rank: 0 } : entry.number === 6 ? { ...entry, agent: "claude", state: "doing", assignee: "yan" } : entry));
		const w = build({ ...base, issues });
		expect(w.items.get("#1")?.children.map((child) => child.id).slice(0, 2)).toEqual(["#7", "#2"]);
		expect(w.items.get("#6")).toMatchObject({ outside: true, planned: false, agent: { role: "claude", state: "working" } });
		expect(press(w, { ...initial(w, undefined), selected: "#6" }, "enter").actions).toEqual([{ do: "say", text: "claude holds #6 from a shell: it is not a session, and there is nothing here to open." }]);
	});

	it("says nothing while the server cannot be reached, and says why", () => {
		const w = build({ ...team(), connected: false, problem: "The server at https://lattice.example.com cannot be reached." });
		expect(press(w, { ...initial(w, undefined), selected: "#6" }, " ").actions).toEqual([{ do: "say", text: "Nothing can be said: The server at https://lattice.example.com cannot be reached." }]);
	});
});
