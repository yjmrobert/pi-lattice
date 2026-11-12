import type { NodeMeta, UiState } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import { ago, ALL_KEYS, type ChildForm, cursorKeys, waitChoices, stopKey, usageText, formKey, newChildForm, renderForm, renderInspector, renderStrip, repoKey, inboxItems, interpretKey, itemKey, networkLine, nodeKey, type Paint, type PaneRepo, type PaneView, paneOrder, PLAIN, remoteRepos, renderCompact, renderPane } from "../src/index.ts";

const node = (id: string, parentId: string | null, over: Partial<NodeMeta> = {}): NodeMeta => ({
	id, parentId, rootId: "r", kind: "task", name: id, brief: "", fragments: [], owner: "yan", version: 1, status: "idle",
	sessionId: null, sessionFile: null, cwd: "/w", workspace: "shared", branch: null, createdAt: `2026-01-01T00:00:0${id.length}.000Z`, updatedAt: "", repo: "shop", ...over,
});
const state = (over: Partial<UiState> = {}): UiState => ({
	owner: "yan",
	nodes: [node("r", null, { name: "checkout", kind: "feature" }), node("a", "r", { name: "grilling", status: "running" }), node("b", "r", { name: "impl", owner: "sam", status: "idle" })],
	attention: {}, foreground: ["r"],
	sharing: { network: "team", scope: "git:shop", people: [{ name: "yan", fingerprint: "f", trust: "trusted", online: true, here: true, self: true }, { name: "sam", fingerprint: "g", trust: "trusted", online: true, here: true, self: false }], handoffs: [], requests: [], pendingTransfers: [], elsewhere: [] },
	...over,
});
const repo = (s: UiState = state(), over: Partial<PaneRepo> = {}): PaneRepo => ({ key: "/shop/.lattice", name: "shop", state: s, here: true, inbox: inboxItems(s), ...over });
const view = (over: Partial<PaneView> = {}, s: UiState = state()): PaneView => ({ repos: [repo(s)], current: "r", cursor: undefined, focused: false, ...over });
/** Marks what would be styled, so tests can see it. */
const MARKED: Paint = { ...PLAIN, select: (text) => `[${text}]`, warn: (text) => `!${text}!` };

describe("renderPane", () => {
	it("lists a repository's sessions one line each: tree, status, name, and the kind on the right", () => {
		expect(renderPane(view(), 34)).toEqual([
			" ◆ shop               3 sessions ",
			"▸ ● checkout             feature ",
			"  ├ ⠋ grilling              task ",
			"  └ ● impl                  @sam ",
			"─────────────────────────────────",
			" alt+l sessions  nothing waiting ",
		]);
	});

	it("names the owner only when the session is someone else's, and says when they are away", () => {
		const s = state();
		if (s.sharing) Object.assign(s.sharing.people[1] as object, { online: false, here: false });
		expect(renderPane(view({}, s), 34)[3]).toBe("  └ ○ impl          @sam offline ");
		expect(renderPane(view({}, state({ sharing: null })), 34)[3]).toContain("offline");
	});

	it("puts what is waiting on the person above the tree, and marks the rows it comes from", () => {
		const lines = renderPane(view({}, state({ attention: { a: { dialogs: 1, pending: 2 } } })), 34);
		expect(lines.slice(0, 6)).toEqual([
			" NEEDS YOU                     2 ",
			" ? grilling",
			"   asks a question",
			" ✉ grilling",
			"   2 messages to approve",
			"─────────────────────────────────",
		]);
		expect(lines[8]).toBe("  ├ ● grilling        ?1 ✉2 task ");
		expect(lines.at(-1)).toBe(" alt+l to answer       2 waiting ");
	});

	it("uses the attention colour only for what is waiting on the person", () => {
		const calm = renderPane(view(), 34, MARKED).join("\n");
		expect(calm).not.toContain("!");
		const waiting = renderPane(view({}, state({ attention: { a: { dialogs: 1, pending: 0 } } })), 34, MARKED);
		const row = waiting.find((line) => line.includes("task")) ?? "";
		expect(row).toContain("!●! grilling");
		expect(row).toContain("!?1!");
	});

	it("keeps the open-here mark while the cursor is on another row", () => {
		const lines = renderPane(view({ focused: true, cursor: nodeKey("a") }), 34, MARKED);
		expect(lines[1]).toBe("▸ ● checkout             feature ");
		expect(lines[2]).toBe("[  ├ ⠋ grilling              task ]");
	});

	it("moves the cursor through waiting items first, then sessions", () => {
		const v = view({ focused: true }, state({ attention: { a: { dialogs: 1, pending: 0 } } }));
		expect(paneOrder(v)).toEqual([itemKey("q:a"), nodeKey("r"), nodeKey("a"), nodeKey("b")]);
		const lines = renderPane({ ...v, cursor: itemKey("q:a") }, 34, MARKED);
		expect(lines[1]).toBe("[ 1 !?! grilling                    ]");
		expect(lines[2]).toBe("[     asks a question             ]");
	});

	it("shows the keys only while it has the keyboard", () => {
		expect(renderPane(view(), 34).join("\n")).not.toContain("⏎ open");
		expect(renderPane(view({ focused: true }), 34).join("\n")).toContain("⏎ open");
	});

	it("drops the kind before it cuts the name, and never drops what is waiting", () => {
		const s = state({ attention: { r: { dialogs: 1, pending: 0 } } });
		(s.nodes[0] as { name: string }).name = "a-very-long-session-name";
		const lines = renderPane(view({}, s), 30);
		expect(lines.findLast((line) => line.includes("a-very"))).toBe("▸ ● a-very-long-session-… ?1 ");
		for (const line of renderPane(view({ focused: true }, s), 24)) expect([...line].length).toBeLessThanOrEqual(23);
	});

	it("shows planned work as planned, with its level, and offers to put a session on it", () => {
		const nodes = [node("r", null, { name: "checkout", kind: "epic" }), node("f", "r", { name: "payments", kind: "feature", status: "dormant", planned: true }), node("s", "f", { name: "cards", kind: "story", status: "dormant", planned: true })];
		expect(renderPane(view({}, state({ nodes })), 34).slice(1, 4)).toEqual([
			"▸ ● checkout                epic ",
			"  └ ○ payments   planned feature ",
			"    └ ○ cards      planned story ",
		]);
		const on: PaneView = { repos: [repo(state({ nodes }))], current: "r", cursor: nodeKey("s"), focused: true };
		expect(renderInspector(on, 70).join("\n")).toContain("planned: nobody is on it yet");
		expect(cursorKeys(on)).toContainEqual(["s", "put a session on it"]);
		expect(interpretKey(on, "s")).toEqual([{ do: "start", repo: "/shop/.lattice", nodeId: "s" }]);
		expect(interpretKey(on, "enter")).toEqual([]);
	});

	it("says what a session that has not started waits on, in place of its kind", () => {
		const nodes = [node("r", null, { name: "checkout", kind: "feature" }), node("a", "r", { name: "schema", status: "running" }), node("b", "r", { name: "seed", done: true }), node("c", "r", { name: "api", status: "dormant", waitsOn: ["a", "b"] }), node("d", "r", { name: "docs", status: "dormant", waitsOn: ["a", "c"] })];
		expect(renderPane(view({}, state({ nodes })), 34).slice(1, 6)).toEqual([
			"▸ ● checkout             feature ",
			"  ├ ⠋ schema                task ",
			"  ├ ✓ seed                  task ",
			"  ├ ○ api        waits on schema ",
			"  └ ○ docs            waits on 2 ",
		]);
		// With little room it says only that it waits.
		expect(renderPane(view({}, state({ nodes })), 24)[4]).toBe("  ├ ○ api        waits ");
		const inspector = renderInspector({ repos: [repo(state({ nodes }))], current: "r", cursor: nodeKey("c"), focused: true }, 70).join("\n");
		expect(inspector).toContain("not started: waiting on others");
		expect(inspector).toContain("waits on   schema · seed ✓");
	});

	it("animates a working session with the frame it is given", () => {
		expect(renderPane(view({ frame: 2 }), 34)[2]).toContain("⠹ grilling");
	});

	it("pins the footer to the bottom and scrolls a long list with the cursor", () => {
		const tall = renderPane(view({ height: 10 }), 34);
		expect(tall).toHaveLength(10);
		expect(tall.at(-1)).toContain("alt+l");
		expect(tall[5]).toBe("");
		const many = state({ nodes: [node("r", null), ...Array.from({ length: 12 }, (_, index) => node(`n${String(index).padStart(2, "0")}`, "r"))] });
		const short = renderPane(view({ height: 8, focused: true, cursor: nodeKey("n11") }, many), 34, MARKED);
		expect(short).toHaveLength(8);
		expect(short[0]).toMatch(/↑ \d+ more/);
		expect(short.join("\n")).toContain("[  └ ● n11");
	});

	it("explains itself when there is no tree", () => {
		expect(renderPane({ repos: [], current: undefined, cursor: undefined, focused: false, hint: "Run /lattice to start." }, 34).slice(0, 1)).toEqual([" Run /lattice to start."]);
	});
});

describe("finished work", () => {
	const done = state({
		nodes: [
			node("r", null, { name: "checkout", kind: "feature" }),
			node("p", "r", { name: "payments", done: true }),
			node("p1", "p", { name: "stripe", done: true, status: "dormant" }),
			node("p2", "p", { name: "refunds", status: "dormant" }),
			node("q", "r", { name: "emails", status: "running" }),
		],
	});

	it("marks a session that sent its result, and folds what is under it into one line", () => {
		const lines = renderPane(view({}, done), 34);
		expect(lines.find((line) => line.includes("payments"))).toBe("  ├ ✓ payments           +2 done ");
		expect(lines.join("\n")).not.toContain("stripe");
		expect(lines.join("\n")).not.toContain("refunds");
		expect(lines.find((line) => line.includes("emails"))).toContain("emails");
	});

	it("unfolds it while the pane has the keyboard, so the cursor can reach every session", () => {
		const lines = renderPane(view({ focused: true }, done), 34);
		expect(lines.find((line) => line.includes("payments"))).toBe("  ├ ✓ payments              task ");
		expect(lines.join("\n")).toContain("stripe");
		expect(paneOrder(view({ focused: true }, done))).toContain(nodeKey("p1"));
	});

	it("keeps it open while anything under it is working or waiting on the person", () => {
		const busy = { ...done, nodes: done.nodes.map((each) => (each.id === "p2" ? { ...each, status: "running" as const } : each)) };
		expect(renderPane(view({}, busy), 34).join("\n")).toContain("refunds");
		const asking = { ...done, attention: { p1: { dialogs: 1, pending: 0 } } };
		expect(renderPane(view({}, asking), 34).join("\n")).toContain("stripe");
	});

	it("says in the inspector that it sent its result", () => {
		expect(renderInspector(view({ focused: true, cursor: nodeKey("p"), now: Date.parse("2026-01-01T00:10:00Z") }, done), 60)[0]).toContain("✓ done: it sent its result");
	});
});

describe("several repositories", () => {
	const other = (over: Partial<UiState> = {}): UiState => state({ nodes: [node("x", null, { name: "invoices", kind: "feature" }), node("y", "x", { name: "pdf" })], foreground: [], ...over });

	it("groups sessions by repository, this terminal's first, and folds one where nothing is happening", () => {
		const lines = renderPane({ repos: [repo(), repo(other(), { key: "/billing/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: false }, 34);
		expect(lines.slice(0, 5)).toEqual([
			" ◆ shop                       ⠋1 ",
			"▸ ● checkout             feature ",
			"  ├ ⠋ grilling              task ",
			"  └ ● impl                  @sam ",
			" ◇ billing-api            2 idle ",
		]);
	});

	it("opens a repository up while something in it is waiting, and says where each item is from", () => {
		const waiting = other({ attention: { y: { dialogs: 1, pending: 0 } } });
		const lines = renderPane({ repos: [repo(), repo(waiting, { key: "/billing/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: false }, 34);
		expect(lines.slice(0, 3)).toEqual([" NEEDS YOU                     1 ", " ? pdf               billing-api ", "   asks a question"]);
		expect(lines.slice(8, 11)).toEqual([" ◇ billing-api                ●1 ", "  ● invoices             feature ", "  └ ● pdf                ?1 task "]);
	});

	it("opens every repository while the pane has the keyboard, so the cursor can reach all of them", () => {
		const v: PaneView = { repos: [repo(), repo(other(), { key: "/billing/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: true };
		expect(renderPane(v, 34).join("\n")).toContain("invoices");
		expect(paneOrder(v)).toContain(nodeKey("y"));
	});
});

describe("a network", () => {
	const person = (name: string, online: boolean, here = online, self = false) => ({ name, fingerprint: "", trust: "trusted" as const, online, here, self });
	/** Yan in shop, with sam here, kim away, and both of them working in repositories yan does not have. */
	const team = (): UiState => {
		const s = state({ nodes: [...state().nodes, node("c", "r", { name: "billing", owner: "kim" })] });
		if (s.sharing) {
			s.sharing.people = [person("yan", true, true, true), person("sam", true), person("kim", false)];
			s.sharing.elsewhere = [
				{ scope: "git:api", repo: "api", url: "git@example.com:team/api.git", owner: "sam", online: true, nodes: [node("x1", null, { name: "auth-rework", owner: "sam", status: "running", repo: "api" })] },
				{ scope: "git:infra", repo: "infra", owner: "kim", online: false, nodes: [node("y1", null, { name: "terraform", owner: "kim", repo: "infra" })] },
			];
		}
		return s;
	};
	const whole = (over: Partial<PaneView> = {}): PaneView => {
		const repos = [repo(team())];
		return { repos: [...repos, ...remoteRepos(repos)], network: networkLine(repos), current: "r", cursor: undefined, focused: false, ...over };
	};

	it("says who is around on the first line, and lists the repositories teammates work in that are not here", () => {
		expect(renderPane(whole(), 34).slice(0, 8)).toEqual([
			" team · sam · 1 away",
			" ◆ shop                       ⠋1 ",
			"▸ ● checkout             feature ",
			"  ├ ⠋ grilling              task ",
			"  ├ ● impl                  @sam ",
			"  └ ○ billing       @kim offline ",
			" ◌ api                  not here ",
			" ◌ infra                not here ",
		]);
	});

	it("opens those repositories when the person comes to look, with keys to read a session and to ask for it", () => {
		const v = whole({ focused: true, cursor: nodeKey("x1") });
		expect(renderPane(v, 34).slice(6, 10)).toEqual([" ◌ api                  not here ", "  ⠋ auth-rework             @sam ", " ◌ infra                not here ", "  ○ terraform       @kim offline "]);
		expect(paneOrder(v)).toEqual(["n:r", "n:a", "n:b", "n:c", "n:x1", "n:y1"].map((key) => key));
		expect(cursorKeys(v)).toEqual([["⏎", "read"], ["t", "take"], [",", "settings"], ["?", "keys"]]);
		expect(interpretKey(v, "enter")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice open x1" }]);
		expect(interpretKey(v, "t")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice take x1" }]);
		expect(interpretKey(v, "n")).toEqual([]); // nothing is created in a repository that is not on this machine
		// Its owner is away: it can be looked at as last seen, not asked for.
		expect(cursorKeys(whole({ focused: true, cursor: nodeKey("y1") })).map(([key]) => key)).not.toContain("t");
	});

	it("counts someone as around when any of their hosts can be reached, and says so by count when names do not fit", () => {
		const elsewhere = team();
		if (elsewhere.sharing) elsewhere.sharing.people = [person("yan", true, true, true), person("sam", true, false)];
		expect(networkLine([repo(elsewhere)])).toEqual({ name: "team", here: ["sam"], away: 0 });
		// Sam is reachable, but not in this repository: his session here cannot be opened or asked for.
		expect(renderPane(view({}, elsewhere), 34)[3]).toContain("@sam offline");
		expect(networkLine([repo(state({ sharing: null }))])).toBeUndefined();
		const crowd = { name: "platform-team", here: ["alexandra", "bartholomew", "christopher"], away: 2 };
		expect(renderPane(whole({ network: crowd }), 34)[0]).toBe(" platform-team · 3 here · 2 away");
		expect(renderPane(whole({ network: { name: "team", here: [], away: 0 } }), 34)[0]).toBe(" team · only you so far");
	});

	it("does not list a repository as elsewhere when it is here, awake or asleep", () => {
		const shop = repo(team());
		const api: PaneRepo = { ...repo(state({ nodes: [node("q", null, { repo: "api" })], sharing: { ...(state().sharing as NonNullable<UiState["sharing"]>), scope: "git:api" } })), key: "/api/.lattice", name: "api", here: false };
		expect(remoteRepos([shop, api]).map((made) => made.name)).toEqual(["infra"]);
		expect(remoteRepos([shop], ["git:infra"]).map((made) => made.name)).toEqual(["api"]);
		expect(remoteRepos([shop])[0]).toMatchObject({ key: "net:git:api", remote: { scope: "git:api", url: "git@example.com:team/api.git", via: "/shop/.lattice" } });
	});
});

describe("pane helpers", () => {
	it("lists what is waiting on this person, one item per thing once the details are known", () => {
		const s = state({
			attention: { a: { dialogs: 2, pending: 1 } },
			sharing: {
				network: "team", scope: "git:shop", elsewhere: [],
				people: [{ name: "kim", fingerprint: "k", trust: "changed", online: false, here: false, self: false }],
				handoffs: [
					{ nodeId: "b", nodeName: "impl", from: "sam", to: "yan", state: "offered", role: "recipient" },
					{ nodeId: "a", nodeName: "grilling", from: "yan", to: "sam", state: "accepted", role: "owner" },
				],
				requests: [{ nodeId: "r", nodeName: "checkout", from: "sam", to: "yan", role: "owner" }],
				pendingTransfers: [],
			},
		});
		expect(inboxItems(s).map((item) => `${item.title}: ${item.text}`)).toEqual([
			"grilling: asks 2 questions", "grilling: 1 message to approve", "kim: key changed", "sam: asks for checkout", "sam: offers impl", "grilling: sam accepted: sending",
		]);
		// A session open in a terminal is not sent from under its owner, and the item says what will send it.
		expect(inboxItems({ ...s, foreground: ["a"] }).at(-1)?.text).toBe("sam accepted: leave it to send");
		// An offer of something this person asked for needs nothing from them: it is on its way.
		if (s.sharing) s.sharing.requests = [{ nodeId: "b", nodeName: "impl", from: "yan", to: "sam", role: "asker" }];
		expect(inboxItems(s).map((item) => item.kind)).not.toContain("offer");
		const detailed = inboxItems(s, { dialogs: { a: [{ id: "d1", method: "confirm", title: "Run  it?" }, { id: "d2", method: "input", title: "Which port?" }] } });
		expect(detailed.slice(0, 2).map((item) => `${item.id} ${item.text}`)).toEqual(["q:a:d1 Run it?", "q:a:d2 Which port?"]);
	});

	it("shows a session being sent to someone", () => {
		const s = state();
		if (s.sharing) s.sharing.pendingTransfers = [{ nodeId: "a", to: "sam" }];
		expect(renderPane(view({}, s), 34)[2]).toBe("  ├ ⠋ grilling            → sam… ");
	});

	it("shows what is offered and what has been asked for, on the session itself", () => {
		const s = state();
		if (s.sharing) {
			s.sharing.handoffs = [{ nodeId: "a", nodeName: "grilling", from: "yan", to: "sam", state: "offered", role: "owner" }];
			s.sharing.requests = [{ nodeId: "b", nodeName: "impl", from: "yan", to: "sam", role: "asker" }];
		}
		const lines = renderPane(view({}, s), 34);
		expect(lines[2]).toBe("  ├ ⠋ grilling            → sam? ");
		expect(lines[3]).toContain("@sam asked");
	});

	it("falls back to one line per session, marking the one open here", () => {
		expect(renderCompact(view())).toEqual(["▸ ● checkout  you · shop", "  ├─ ⠋ grilling  you · shop", "  └─ ● impl  @sam · shop"]);
		expect(renderCompact(view(), 2)).toEqual(["▸ ● checkout  you · shop", "  … 2 more (/lattice)"]);
	});
});

describe("keys while the pane has the keyboard", () => {
	const envelope = { id: "e1", from: "b", fromOwner: "sam", payload: { text: "Totals endpoint is live at /cart/totals, with the schema attached." } } as never;
	const waiting = state({ attention: { a: { dialogs: 2, pending: 1 } } });
	const details = { dialogs: { a: [{ id: "d1", method: "confirm" as const, title: "Run stripe listen in this shell?" }, { id: "d2", method: "input" as const, title: "Which port?" }] }, mail: [{ nodeId: "a", envelope }] };
	const at = (cursor: string | undefined): PaneView => ({ repos: [repo(waiting, { inbox: inboxItems(waiting, details) })], current: "r", cursor, focused: true });

	it("moves through items then sessions, and jumps to an item by its number", () => {
		expect(interpretKey(at(itemKey("q:a:d1")), "down")).toEqual([{ do: "move", cursor: itemKey("q:a:d2") }]);
		expect(interpretKey(at(itemKey("m:a:e1")), "down")).toEqual([{ do: "move", cursor: nodeKey("r") }]);
		expect(interpretKey(at(nodeKey("r")), "3")).toEqual([{ do: "move", cursor: itemKey("m:a:e1") }]);
		expect(interpretKey(at(nodeKey("r")), "9")).toEqual([]);
	});

	it("answers a yes/no question with one key, where it is", () => {
		expect(interpretKey(at(itemKey("q:a:d1")), "y")).toEqual([{ do: "answer", repo: "/shop/.lattice", nodeId: "a", dialogId: "d1", confirmed: true }]);
		expect(interpretKey(at(itemKey("q:a:d1")), "n")).toEqual([{ do: "answer", repo: "/shop/.lattice", nodeId: "a", dialogId: "d1", confirmed: false }]);
	});

	it("sends any other question to Pi's own prompt", () => {
		expect(interpretKey(at(itemKey("q:a:d2")), "enter")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice answer a" }]);
		expect(interpretKey(at(itemKey("q:a:d2")), "y")).toEqual([]);
	});

	it("approves or rejects a message where it is", () => {
		expect(interpretKey(at(itemKey("m:a:e1")), "a")).toEqual([{ do: "decide", repo: "/shop/.lattice", nodeId: "a", envelopeId: "e1", action: "approve" }]);
		expect(interpretKey(at(itemKey("m:a:e1")), "x")).toEqual([{ do: "decide", repo: "/shop/.lattice", nodeId: "a", envelopeId: "e1", action: "reject" }]);
	});

	it("opens, creates under and shares the session the cursor is on", () => {
		expect(interpretKey(at(nodeKey("a")), "enter")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice open a" }]);
		expect(interpretKey(at(nodeKey("r")), "enter")).toEqual([{ do: "leave" }]);
		expect(interpretKey(at(nodeKey("a")), "n")).toEqual([{ do: "new", nodeId: "a" }]);
		expect(interpretKey(at(nodeKey("a")), "escape")).toEqual([{ do: "leave" }]);
	});

	it("offers your session with o, asks for a teammate's with t, and sets a network up first when there is none", () => {
		expect(interpretKey(at(nodeKey("a")), "o")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice offer a" }]);
		expect(interpretKey(at(nodeKey("b")), "t")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice take b" }]);
		expect(interpretKey(at(nodeKey("b")), "o")).toEqual([]);
		expect(interpretKey(at(nodeKey("a")), "t")).toEqual([]);
		// Asked already: the same key takes the request back.
		const asked = state();
		if (asked.sharing) asked.sharing.requests = [{ nodeId: "b", nodeName: "impl", from: "yan", to: "sam", role: "asker" }];
		const v = { ...view({}, asked), focused: true, cursor: nodeKey("b") };
		expect(cursorKeys(v)).toContainEqual(["t", "withdraw"]);
		expect(interpretKey(v, "t")).toEqual([{ do: "sharing", repo: "/shop/.lattice", action: "withdraw", args: ["b"] }]);
		// A teammate who is away cannot be asked.
		const away = state();
		if (away.sharing) Object.assign(away.sharing.people[1] as object, { online: false, here: false });
		expect(cursorKeys({ ...view({}, away), focused: true, cursor: nodeKey("b") }).map(([key]) => key)).not.toContain("t");
		// Outside a network the key leads to making or joining one.
		const alone = { ...view({}, state({ sharing: null })), focused: true, cursor: nodeKey("a") };
		expect(cursorKeys(alone)).toContainEqual(["o", "network"]);
		expect(interpretKey(alone, "o")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice network" }]);
	});

	it("hands over or keeps a session someone asks for, and accepts or declines one that is offered", () => {
		const s = state();
		if (s.sharing) {
			s.sharing.requests = [{ nodeId: "a", nodeName: "grilling", from: "sam", to: "yan", role: "owner" }];
			s.sharing.handoffs = [{ nodeId: "b", nodeName: "impl", from: "sam", to: "yan", state: "offered", role: "recipient" }];
		}
		const on = (cursor: string) => ({ ...view({}, s), focused: true, cursor });
		expect(cursorKeys(on(itemKey("t:a:sam")))).toEqual([["a", "hand over"], ["x", "keep"]]);
		// Handing over sends the conversation away, so it goes through a prompt that says so.
		expect(interpretKey(on(itemKey("t:a:sam")), "a")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice approve a sam" }]);
		expect(interpretKey(on(itemKey("t:a:sam")), "x")).toEqual([{ do: "sharing", repo: "/shop/.lattice", action: "decline", args: ["a", "sam"] }]);
		expect(interpretKey(on(itemKey("o:b")), "a")).toEqual([{ do: "sharing", repo: "/shop/.lattice", action: "accept", args: ["b"] }]);
		expect(interpretKey(on(itemKey("o:b")), "x")).toEqual([{ do: "sharing", repo: "/shop/.lattice", action: "cancel", args: ["b"] }]);
	});

	it("renames and archives the session the cursor is on, if it is yours", () => {
		expect(interpretKey(at(nodeKey("a")), "r")).toEqual([{ do: "leave" }, { do: "command", text: "/lattice rename a" }]);
		expect(interpretKey(at(nodeKey("a")), "d")).toEqual([{ do: "archive", repo: "/shop/.lattice", nodeId: "a" }]);
		expect(interpretKey(at(nodeKey("r")), "d")).toEqual([]);
		expect(interpretKey(at(nodeKey("b")), "d")).toEqual([]);
		expect(interpretKey(at(nodeKey("b")), "r")).toEqual([]);
	});

	it("starts a session that is waiting on others with s, and has nothing to open until then", () => {
		const s = state({ nodes: [node("r", null, { name: "checkout", kind: "feature" }), node("a", "r", { name: "schema", status: "running" }), node("c", "r", { name: "api", status: "dormant", waitsOn: ["a"] })] });
		const on = (cursor: string): PaneView => ({ repos: [repo(s)], current: "r", cursor, focused: true });
		expect(cursorKeys(on(nodeKey("c")))).toEqual([["n", "new"], ["r", "rename"], ["s", "start now"], ["d", "archive"], ["o", "offer"], [",", "settings"], ["?", "keys"]]);
		expect(interpretKey(on(nodeKey("c")), "s")).toEqual([{ do: "start", repo: "/shop/.lattice", nodeId: "c" }]);
		expect(interpretKey(on(nodeKey("c")), "enter")).toEqual([]);
	});

	it("stops a working session only when s is pressed twice", () => {
		expect(interpretKey(at(nodeKey("a")), "s")).toEqual([{ do: "confirm", what: stopKey("a") }]);
		const asked = { ...at(nodeKey("a")), confirm: stopKey("a") };
		expect(cursorKeys(asked)).toContainEqual(["s", "again to stop"]);
		expect(interpretKey(asked, "s")).toEqual([{ do: "interrupt", repo: "/shop/.lattice", nodeId: "a" }]);
		// A session that is not working has nothing to stop.
		expect(interpretKey(at(nodeKey("r")), "s")).toEqual([]);
	});

	it("lists every key on ?, and takes nothing else until the list is closed", () => {
		expect(interpretKey(at(nodeKey("a")), "?")).toEqual([{ do: "help" }]);
		expect(interpretKey(at(nodeKey("a")), ",")).toEqual([{ do: "settings" }]);
		const open = { ...at(nodeKey("a")), help: true };
		expect(interpretKey(open, "d")).toEqual([]);
		expect(interpretKey(open, "escape")).toEqual([{ do: "help" }]);
		const lines = renderInspector(open, 70);
		for (const [section, keys] of ALL_KEYS) {
			expect(lines).toContain(` ${section.toUpperCase()}`);
			for (const [key] of keys) expect(lines.some((line) => line.startsWith(` ${key}`))).toBe(true);
		}
		expect(lines.at(-1)).toBe(" ? close  esc close");
	});

	it("shows in the footer exactly the keys that act on what the cursor is on", () => {
		expect(cursorKeys(at(itemKey("q:a:d1")))).toEqual([["y", "yes"], ["n", "no"]]);
		expect(cursorKeys(at(itemKey("q:a:d2")))).toEqual([["⏎", "answer"]]);
		expect(cursorKeys(at(itemKey("m:a:e1")))).toEqual([["a", "approve"], ["x", "reject"]]);
		// A working session of yours that is not the one open here can be renamed, stopped and archived.
		expect(cursorKeys(at(nodeKey("a")))).toEqual([["⏎", "open"], ["n", "new"], ["r", "rename"], ["s", "stop"], ["d", "archive"], ["o", "offer"], [",", "settings"], ["?", "keys"]]);
		// The one open here cannot be archived from under you; someone else's can be opened and asked for.
		expect(cursorKeys(at(nodeKey("r")))).toEqual([["n", "new"], ["r", "rename"], ["o", "offer"], [",", "settings"], ["?", "keys"]]);
		expect(cursorKeys(at(nodeKey("b")))).toEqual([["⏎", "open"], ["n", "new"], ["t", "take"], [",", "settings"], ["?", "keys"]]);
		const v = at(itemKey("q:a:d1"));
		expect(renderPane({ ...v, keys: cursorKeys(v) }, 34).at(-1)).toBe(" y yes  n no  ↑↓ move  esc close");
	});

	it("shows all of an item's text under the cursor, wrapped, and one line otherwise", () => {
		const lines = renderPane(at(itemKey("m:a:e1")), 34);
		const from = lines.findIndex((line) => line.includes("✉"));
		expect(lines.slice(from, from + 4)).toEqual([
			" 3 ✉ impl → grilling             ",
			"     Totals endpoint is live at  ",
			"     /cart/totals, with the      ",
			"     schema attached.            ",
		]);
		expect(renderPane(at(nodeKey("r")), 34)[from + 1]).toBe("     Totals endpoint is live at …");
	});
});

describe("the inspector", () => {
	const now = Date.parse("2026-01-01T00:14:00.000Z");
	const s = state({ attention: { a: { dialogs: 1, pending: 0 } } });
	(s.nodes[1] as NodeMeta) = { ...(s.nodes[1] as NodeMeta), brief: "Find the gaps in the checkout story.\nAsk before assuming.", fragments: ["worker", "grilling"], workspace: "worktree", branch: "lattice/grilling", cwd: "/w/.lattice/worktrees/a", updatedAt: "2026-01-01T00:08:00.000Z" };
	const details = { dialogs: { a: [{ id: "d1", method: "confirm" as const, title: "Run stripe listen in this shell?", message: "It forwards webhooks to localhost:3000." }] } };
	const at = (cursor: string): PaneView => {
		const base: PaneView = { repos: [repo(s, { inbox: inboxItems(s, details) })], current: "r", cursor, focused: true, now, inspector: true };
		return { ...base, keys: cursorKeys(base) };
	};

	it("shows a session's state, lineage, brief, roles and workspace, and what it is waiting on", () => {
		expect(renderInspector(at(nodeKey("a")), 60)).toEqual([
			" grilling                           ● waiting on you · 6m ",
			" shop · checkout › grilling",
			"",
			" BRIEF",
			" Find the gaps in the checkout story.",
			" Ask before assuming.",
			"",
			" owner      you",
			" kind       task",
			" roles      worker · grilling",
			" workspace  own worktree · branch lattice/grilling",
			" directory  /w/.lattice/worktrees/a",
			"",
			" WAITING ON YOU",
			" 1 grilling: Run stripe listen in this shell?",
			"───────────────────────────────────────────────────────────",
			" ⏎ open  n new  r rename  s stop  d archive  o offer",
			" , settings  ? keys",
		]);
	});

	it("shows a question in full, with the session asking and the keys that answer it", () => {
		const lines = renderInspector(at(itemKey("q:a:d1")), 60);
		expect(lines.slice(0, 5)).toEqual([
			" Question from grilling             ● waiting on you · 6m ",
			" shop · checkout › grilling",
			"",
			" │ Run stripe listen in this shell?",
			" │ It forwards webhooks to localhost:3000.",
		]);
		expect(lines).toContain(" THE SESSION ASKING");
		expect(lines.at(-1)).toBe(" y yes  n no");
	});

	it("shows the model, what has been used, and the last things the session said and did", () => {
		const busy = state({ activity: { a: { text: "→ bash: npm test", at: now - 5000 } } });
		(busy.nodes[1] as NodeMeta) = { ...(busy.nodes[1] as NodeMeta), model: "anthropic/claude-haiku-4-5", usage: { tokens: 12_400, cost: 0.031 } };
		const base: PaneView = { repos: [repo(busy)], current: "r", cursor: nodeKey("a"), focused: true, now, inspector: true, tail: { nodeId: "a", lines: ["Reading the cart module.", "→ read: src/cart.ts"] } };
		const lines = renderInspector(base, 60);
		expect(lines).toContain(" model      anthropic/claude-haiku-4-5");
		expect(lines).toContain(" used       12.4k tokens · $0.03");
		const from = lines.indexOf(" RECENT  5s ago");
		expect(lines.slice(from, from + 4)).toEqual([" RECENT  5s ago", " Reading the cart module.", " → read: src/cart.ts", " → bash: npm test"]);
		// What was fetched for another session is not shown for this one.
		expect(renderInspector({ ...base, tail: { nodeId: "r", lines: ["other"] } }, 60)).not.toContain(" other");
		expect(usageText({ tokens: 950, cost: 0 })).toBe("950 tokens");
		expect(usageText({ tokens: 2_300_000, cost: 0.004 })).toBe("2.3M tokens · $<0.01");
	});

	it("pins its keys to the bottom, and keeps the pane's own footer to the keys that move", () => {
		const lines = renderInspector(at(nodeKey("a")), 60, PLAIN, 30);
		expect(lines).toHaveLength(30);
		expect(lines.slice(-2)).toEqual([" ⏎ open  n new  r rename  s stop  d archive  o offer", " , settings  ? keys"]);
		expect(renderPane(at(nodeKey("a")), 34).at(-1)).toBe(" ↑↓ move  1-9 jump  esc close");
	});

	it("explains a repository whose host is asleep", () => {
		const view: PaneView = { repos: [repo()], asleep: [{ key: "/docs/.lattice", name: "docs-site" }], current: "r", cursor: repoKey("/docs/.lattice"), focused: true };
		expect(renderPane(view, 34)).toContain(" ◇ docs-site              asleep ");
		expect(interpretKey(view, "enter")).toEqual([{ do: "wake", repo: "/docs/.lattice" }]);
		expect(renderInspector({ ...view, keys: cursorKeys(view) }, 60).join("\n")).toContain("host is not running");
	});

	it("says how long ago in the largest unit that fits", () => {
		expect([ago("2026-01-01T00:13:20.000Z", now), ago("2026-01-01T00:00:00.000Z", now), ago("2025-12-31T21:00:00.000Z", now), ago("2025-12-29T00:00:00.000Z", now), ago("", now)]).toEqual(["40s", "14m", "3h", "3d", ""]);
	});
});

describe("the strip for narrow terminals", () => {
	it("puts this repository's sessions on one row, the open one first", () => {
		expect(renderStrip(view(), 72)).toEqual([" ◆ shop  ▸● checkout │ ⠋ grilling │ ● impl"]);
	});

	it("adds the first thing waiting on a second row, and brings the session it is from forward", () => {
		const s = state({ attention: { b: { dialogs: 1, pending: 0 } } });
		expect(renderStrip(view({}, s), 72)).toEqual([
			" ◆ shop  ▸● checkout │ ● impl ?1 │ ⠋ grilling",
			" ? impl  asks a question                                alt+l to answer ",
		]);
	});

	it("counts what does not fit, and the other repositories", () => {
		const many = state({ nodes: [node("r", null, { name: "checkout" }), ...Array.from({ length: 9 }, (_, index) => node(`session-${index}`, "r"))] });
		const other = state({ nodes: [node("x", null, { name: "invoices", status: "running" })], foreground: [] });
		const lines = renderStrip({ repos: [repo(many), repo(other, { key: "/b/.lattice", name: "billing-api", here: false })], current: "r", cursor: undefined, focused: false }, 72);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/│ \+\d+  ◇ billing-api ⠋1$/);
		expect([...(lines[0] as string)].length).toBeLessThanOrEqual(72);
	});

	it("shows nothing when there is no tree anywhere", () => {
		expect(renderStrip({ repos: [], current: undefined, cursor: undefined, focused: false }, 72)).toEqual([]);
	});
});

describe("the new-session form", () => {
	const blank = (): ChildForm => newChildForm({ id: "a", name: "payments" }, ["coordinator", "implementation", "worker"]);
	/** Press keys in turn; text is typed. */
	const press = (form: ChildForm, ...keys: Array<Parameters<typeof formKey>[1] | string>): ChildForm => {
		let at = form;
		for (const key of keys) {
			const named = ["tab", "back-tab", "up", "down", "left", "right", "home", "end", "enter", "space", "backspace", "delete", "escape", "submit"].includes(key as string);
			const result = formKey(at, (typeof key === "string" && !named ? { text: key } : key) as Parameters<typeof formKey>[1]);
			if (!("form" in result)) throw new Error("the form ended");
			at = result.form;
		}
		return at;
	};

	it("shows every field at once", () => {
		expect(renderForm(press(blank(), "refund-rounding"), 70)).toEqual([
			" New session under payments",
			"",
			" Name       refund-rounding▏",
			" Kind       task",
			" Model      the default",
			" Roles       coordinator   implementation   worker  ",
			" Workspace  ◉ this directory   ○ its own worktree and branch",
			"",
			" Brief      what it should do; it sees only this",
			" ╭────────────────────────────────────────────────────────────────╮",
			" │                                                                │",
			" │                                                                │",
			" │                                                                │",
			" │                                                                │",
			" ╰────────────────────────────────────────────────────────────────╯",
			"",
			"   Create    runs in the background",
			"─────────────────────────────────────────────────────────────────────",
			" ←→ move  tab next field  ctrl+s create  esc cancel",
		]);
	});

	it("offers what it could wait on, when there is something, and sends what was chosen", () => {
		const tree = [node("r", null, { name: "checkout" }), node("a", "r", { name: "payments" }), node("b", "r", { name: "schema" }), node("c", "r", { name: "seed", done: true }), node("d", "r", { name: "theirs", owner: "sam" }), node("a1", "a", { name: "refunds" })];
		// Not what is above it, not what has finished, not a teammate's.
		expect(waitChoices(tree, tree[1] as NodeMeta)).toEqual([{ id: "b", name: "schema" }, { id: "a1", name: "refunds" }]);
		const form = newChildForm({ id: "a", name: "payments" }, ["worker"], waitChoices(tree, tree[1] as NodeMeta));
		// tab: kind, model, roles, waits.
		const chosen = press(form, "api", "tab", "tab", "tab", "tab", "space", "right", "space", "left", "space", "tab", "tab", "Build it.");
		expect(chosen).toMatchObject({ waits: ["a1"], field: "brief" });
		const lines = renderForm(chosen, 70);
		expect(lines[6]).toBe(" Waits on    schema  [refunds] ");
		expect(lines.join("\n")).toContain("starts when what it waits on has finished");
		expect(formKey(chosen, "submit")).toMatchObject({ submit: { spec: { name: "api", waitsOn: ["a1"] } } });
		// With nothing to wait on there is no such field, and nothing is sent.
		expect(renderForm(blank(), 70).join("\n")).not.toContain("Waits on");
		expect(formKey(press(blank(), "x", "tab", "tab", "tab", "tab", "tab", "y"), "submit")).toEqual({ submit: { parentId: "a", spec: { name: "x", brief: "y", kind: "task", fragments: [], workspace: "shared" } } });
	});

	it("edits text where the caret is: move, insert, delete either side, jump to either end", () => {
		const typed = press(blank(), "refnd", "left", "left", "u");
		expect(typed).toMatchObject({ name: "refund", at: 4 });
		expect(renderForm(typed, 70)[2]).toBe(" Name       refu▏nd");
		expect(press(typed, "home", "delete", "R").name).toBe("Refund");
		expect(press(typed, "end", "backspace", "backspace", "left", "left", "left", "left", "left", "backspace").name).toBe("refu");
		// Moving to another field puts the caret at the end of what is there.
		expect(press(typed, "tab")).toMatchObject({ field: "kind", at: 4 });
	});

	it("keeps the caret on the right row of a brief that wraps, and takes a model", () => {
		const form = press(blank(), "x", "tab", "tab", "anthropic/claude-haiku-4-5", "tab", "tab", "tab", "first line", "enter", "second", "left", "left", "left");
		expect(form).toMatchObject({ field: "brief", model: "anthropic/claude-haiku-4-5", brief: "first line\nsecond" });
		const lines = renderForm(form, 70);
		expect(lines.find((line) => line.includes("sec"))).toContain("sec▏ond");
		expect(formKey(form, "submit")).toMatchObject({ submit: { spec: { model: "anthropic/claude-haiku-4-5" } } });
	});

	it("fills in from the keyboard: text, roles in the order chosen, workspace, a brief of several lines", () => {
		const filled = press(blank(), "refund", "tab", "backspace", "backspace", "backspace", "backspace", "fix", "tab", "tab", "right", "right", "space", "left", "space", "tab", "space", "tab", "Fix rounding.", "enter", "Keep the tests green.");
		expect(filled).toMatchObject({ name: "refund", kind: "fix", picked: ["worker", "implementation"], workspace: "worktree", brief: "Fix rounding.\nKeep the tests green.", field: "brief" });
		expect(renderForm(filled, 70).join("\n")).toContain("[implementation]");
		expect(formKey(filled, "submit")).toEqual({ submit: { parentId: "a", spec: { name: "refund", brief: "Fix rounding.\nKeep the tests green.", kind: "fix", fragments: ["worker", "implementation"], workspace: "worktree" } } });
	});

	it("creates from the button as well, and unchooses a role chosen by mistake", () => {
		const form = press(blank(), "x", "tab", "tab", "tab", "space", "space", "tab", "tab", "do it", "tab");
		expect(form.picked).toEqual([]);
		expect(form.field).toBe("create");
		expect(formKey(form, "enter")).toMatchObject({ submit: { spec: { name: "x", brief: "do it", fragments: [], workspace: "shared" } } });
	});

	it("says what is missing and goes to that field, and forgets the complaint at the next key", () => {
		const result = formKey(press(blank(), "x"), "submit");
		expect(result).toMatchObject({ form: { field: "brief", error: "Say what it should do. It sees only the brief." } });
		expect(formKey(blank(), "submit")).toMatchObject({ form: { field: "name", error: "Give it a name." } });
		if ("form" in result) expect(press(result.form, "y").error).toBeUndefined();
	});

	it("cancels with escape", () => {
		expect(formKey(blank(), "escape")).toEqual({ cancel: true });
	});
});
