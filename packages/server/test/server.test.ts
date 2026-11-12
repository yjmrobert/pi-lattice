/** The server as a client meets it: a real one on a local port, with nothing kept after the test. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SCHEME, type Issue, issueLine, type Scheme } from "@pi-lattice/protocol";
import { joinServer, parseAddress, WorkClient, WorkServer } from "../src/index.ts";

let server: WorkServer;
let address: string;
const clients: WorkClient[] = [];
let clock = 1_000;

beforeEach(async () => {
	clock = 1_000;
	server = new WorkServer({ file: ":memory:", host: "127.0.0.1", sessionTtlMs: 400, now: () => clock++ });
	address = `http://127.0.0.1:${await server.start()}/#${server.tracker.code}`;
});
afterEach(async () => {
	for (const client of clients.splice(0)) client.stop();
	await server.stop();
});

const member = async (name: string): Promise<WorkClient> => {
	const client = new WorkClient(await joinServer(address, name), { waitSeconds: 5, retryMs: 50 });
	clients.push(client);
	await client.refresh();
	return client;
};
const until = async (probe: () => boolean, what: string): Promise<void> => {
	for (let tries = 0; tries < 200; tries++) {
		if (probe()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${what}`);
};
const refused = async (work: Promise<unknown>): Promise<string> => work.then(() => "it was allowed", (error: Error) => error.message);

describe("joining", () => {
	it("takes the address with the team's code, and gives each name to one person", async () => {
		expect(parseAddress(" https://lattice.example.com/#abc ")).toEqual({ url: "https://lattice.example.com", code: "abc" });
		expect(() => parseAddress("lattice.example.com")).toThrow("A server's address looks like");
		const yan = await member("yan");
		expect(yan.state()).toMatchObject({ me: "yan", connected: true, issues: [], scheme: DEFAULT_SCHEME, people: [{ name: "yan", online: true }] });
		expect(await refused(joinServer(address, "Yan"))).toContain('Someone is already "Yan" on this server.');
		expect(await refused(joinServer(address.replace(/#.*/, "#wrong"), "sam"))).toBe("That is not this team's code.");
		expect(await refused(joinServer(address, "two words"))).toBe("A name is 1 to 32 letters, digits, dots, - and _.");
		expect(await refused(new WorkClient({ url: yan.account.url, name: "yan", token: "made-up" }).refresh())).toBe("This server does not know you. Join it with its address and code.");
		expect(await refused(joinServer("http://127.0.0.1:1/#x", "sam"))).toBe("The server at http://127.0.0.1:1 cannot be reached.");
	});
});

describe("issues", () => {
	it("are numbered by the server, structured by the scheme, and refused with the reason when they do not fit", async () => {
		const yan = await member("yan");
		const epic = await yan.create({ title: "  Checkout  ", type: "epic" });
		expect(epic).toMatchObject({ number: 1, title: "Checkout", type: "epic", state: "todo", author: "yan", labels: [], fields: {} });
		// With no type, it is what goes under its parent.
		const feature = await yan.create({ title: "Pay by card", parent: 1 });
		expect(feature).toMatchObject({ number: 2, type: "feature", parent: 1 });
		const story = await yan.create({ title: "Enter a card", parent: 2, assignee: "yan", labels: ["ui", "ui", " web "] });
		expect(story).toMatchObject({ number: 3, type: "story", assignee: "yan", labels: ["ui", "web"] });
		const bug = await yan.create({ title: "Total is wrong", type: "bug" });
		expect(bug.parent).toBeUndefined();

		expect(await refused(yan.create({ title: "Loose task", type: "task" }))).toBe("A task goes under a story, not at the top.");
		expect(await refused(yan.create({ title: "Deep epic", type: "epic", parent: 2 }))).toBe("An epic goes at the top, not under a feature.");
		expect(await refused(yan.create({ title: "", type: "epic" }))).toBe("A title cannot be empty.");
		expect(await refused(yan.create({ title: "x", type: "epic", parent: 99 }))).toBe("There is no issue #99 to put it under.");
		expect(await refused(yan.create({ title: "x", type: "epic", assignee: "kim" }))).toBe('"kim" is not in the team. The people are: yan.');
		expect(await refused(yan.create({ title: "x", type: "epic", state: "started" }))).toBe('"started" is not a state. The states are: todo, doing, review, done, dropped.');
		expect(yan.state().issues.map((issue) => issue.number)).toEqual([1, 2, 3, 4]);
	});

	it("change one field at a time, keep a history, and refuse what would break the tree", async () => {
		const yan = await member("yan");
		const sam = await member("sam");
		await yan.create({ title: "Checkout", type: "epic" });
		await yan.create({ title: "Pay by card", parent: 1 });
		await yan.create({ title: "Enter a card", parent: 2 });

		// Two people, two fields: both land.
		await yan.update(3, { assignee: "sam" });
		await sam.update(3, { title: "Enter a card number" });
		expect((await yan.read(3)).issue).toMatchObject({ assignee: "sam", title: "Enter a card number" });

		expect(await refused(yan.update(1, { parent: 3 }))).toBe("#3 is under #1, so #1 cannot go under it.");
		expect(await refused(yan.update(2, { parent: 2 }))).toBe("An issue cannot be under itself.");
		expect(await refused(yan.update(2, { type: "story" }))).toBe("A story goes under a feature, not under an epic.");
		expect(await refused(yan.update(1, { state: "done" }))).toBe("#1 has an unfinished issue under it: #2. Finish or drop it first.");
		expect(await refused(yan.update(9, { title: "x" }))).toBe("There is no issue #9.");

		// A change based on an old look is refused; nothing is merged.
		const seen = (await yan.read(3)).issue.rev;
		await sam.update(3, { state: "doing" });
		expect(await refused(yan.update(3, { state: "dropped" }, seen))).toBe("#3 has changed since you last saw it. Look at it again, then make the change.");

		await sam.comment(3, "Stripe's field does this for us.");
		const { comments, history } = await yan.read(3);
		expect(comments.map((comment) => [comment.author, comment.body])).toEqual([["sam", "Stripe's field does this for us."]]);
		expect(history.map((event) => [event.who, event.what, event.from, event.to])).toEqual([
			["yan", "created", undefined, undefined],
			["yan", "assignee", undefined, "sam"],
			["sam", "title", "Enter a card", "Enter a card number"],
			["sam", "state", "todo", "doing"],
			["sam", "commented", undefined, undefined],
		]);
		// Saying what is already so changes nothing and records nothing.
		const before = (await yan.read(3)).issue.rev;
		expect((await yan.update(3, { state: "doing" })).rev).toBe(before);
	});

	it("reach everyone who is listening as soon as they change", async () => {
		const yan = await member("yan");
		const sam = await member("sam");
		sam.start();
		let heard = 0;
		sam.onChanged(() => heard++);
		await yan.create({ title: "Checkout", type: "epic" });
		await until(() => sam.issue(1)?.title === "Checkout", "sam to hear of #1");
		await yan.update(1, { title: "Checkout, redone" });
		await until(() => sam.issue(1)?.title === "Checkout, redone", "sam to hear of the change");
		expect(heard).toBeGreaterThan(0);
	});
});

describe("the scheme", () => {
	const kanban: Scheme = {
		types: [{ name: "goal", level: 0, under: [], top: true }, { name: "chore", level: 1, under: ["goal"], top: true }],
		states: [{ name: "next", kind: "open" }, { name: "now", kind: "active" }, { name: "shipped", kind: "done" }],
		fields: [{ name: "estimate", type: "number", on: ["chore"] }, { name: "risk", type: "choice", choices: ["low", "high"] }],
		rules: { onStart: "now", onReport: "shipped" },
	};

	it("is replaced whole, applies to what is made after, and leaves what exists alone", async () => {
		const yan = await member("yan");
		const sam = await member("sam");
		sam.start();
		await yan.create({ title: "Checkout", type: "epic" });
		expect(await refused(yan.setScheme({ ...kanban, types: [] }))).toBe('A scheme needs at least one type.\nAt least one type must be allowed at the top.\nField "estimate" is on "chore", which is not a type.');
		await yan.setScheme(kanban);
		await until(() => sam.state().scheme.types[0]?.name === "goal", "sam to get the new scheme");

		// The epic is still there, as it was; new work follows the new rules.
		expect(sam.issue(1)).toMatchObject({ type: "epic", state: "todo" });
		const goal = await yan.create({ title: "Sell things", type: "goal" });
		expect(goal.state).toBe("next");
		const chore = await yan.create({ title: "Renew the certificate", parent: goal.number, fields: { estimate: 2, risk: "low" } });
		expect(chore).toMatchObject({ type: "chore", fields: { estimate: 2, risk: "low" } });
		expect(await refused(yan.update(chore.number, { fields: { risk: "medium" } }))).toBe('Field "risk" is one of: low, high.');
		expect(await refused(yan.update(goal.number, { fields: { estimate: 5 } }))).toBe('Field "estimate" is for chore, not for a goal.');
		expect((await yan.update(chore.number, { fields: { risk: null } })).fields).toEqual({ estimate: 2 });
		expect(await refused(yan.create({ title: "Old habits", type: "epic" }))).toBe('"epic" is not a type. The types are: goal, chore.');
	});

	it("says what a session does to the issue it is on", async () => {
		const yan = await member("yan");
		await yan.create({ title: "Checkout", type: "epic" });
		await yan.create({ title: "Pay by card", parent: 1 });
		expect((await yan.session(2, "start")).state).toBe("doing");
		// A result is for a person to look at: it does not close the issue.
		expect((await yan.session(2, "report")).state).toBe("review");
		expect((await yan.session(2, "start")).state).toBe("review");
		await yan.update(2, { state: "done" });
		// Neither starting on finished work nor a late result reopens it.
		expect((await yan.session(2, "start")).state).toBe("done");
		expect((await yan.session(2, "report")).state).toBe("done");
		// A team that wants results to close issues says so. A parent with unfinished work under it is still not closed.
		await yan.setScheme({ ...DEFAULT_SCHEME, rules: { onStart: "doing", onReport: "done" } });
		await yan.create({ title: "Pay by transfer", parent: 1 });
		expect((await yan.session(1, "start")).state).toBe("doing");
		expect((await yan.session(1, "report")).state).toBe("doing");
		expect((await yan.session(3, "report")).state).toBe("done");
		expect((await yan.session(1, "report")).state).toBe("done");
	});

	it("gives a session the next issue that is ready, and never the same one twice", async () => {
		const yan = await member("yan");
		const sam = await member("sam");
		await yan.create({ title: "Checkout", type: "epic" }); // 1
		await yan.create({ title: "Pay by card", parent: 1 }); // 2, a feature
		await yan.create({ title: "Card form", parent: 2 }); // 3, a story
		await yan.create({ title: "Charge the card", parent: 2, waitsOn: [3] }); // 4
		await yan.create({ title: "Choose a payment provider", parent: 2, human: true }); // 5
		await yan.create({ title: "Receipt email", parent: 2, assignee: "sam" }); // 6
		await yan.create({ title: "Ledger entry", parent: 2, repo: "ledger" }); // 7
		// Not the epic or the feature, which have work under them; not what waits, is for a person, is sam's, or is for another repository.
		const both = await Promise.all([yan.next({ repo: "shop" }), yan.next({ repo: "shop" })]);
		expect(both.map((taken) => taken.issue?.number).sort()).toEqual([3, undefined]);
		expect(both.find((taken) => !taken.issue)?.waiting).toBe(1);
		expect(yan.issue(3)).toMatchObject({ state: "doing", assignee: "yan" });
		expect((await sam.next({ repo: "shop" })).issue?.number).toBe(6);
		expect((await sam.next({ repo: "ledger" })).issue?.number).toBe(7);
		// Review is not finished: what waits on #3 keeps waiting until a person closes it.
		await yan.session(3, "report");
		expect(await yan.next({ repo: "shop" })).toEqual({ waiting: 1 });
		await yan.update(3, { state: "done" });
		expect((await yan.next({ repo: "shop" })).issue).toMatchObject({ number: 4, state: "doing", assignee: "yan" });
		expect(await yan.next({ repo: "shop" })).toEqual({ waiting: 0 });
		expect((await yan.read(3)).history.map((event) => [event.what, event.to])).toEqual([["created", undefined], ["state", "doing"], ["assignee", "yan"], ["state", "review"], ["state", "done"]]);
		// Narrowed: only under an issue, only a type, only a label.
		await yan.create({ title: "Refunds", type: "epic" }); // 8
		await yan.create({ title: "Wrong total", type: "bug", parent: 8, labels: ["urgent"] }); // 9
		await yan.create({ title: "Typo", type: "bug", labels: ["later"] }); // 10
		expect(await yan.next({ under: 1 })).toEqual({ waiting: 0 });
		expect((await yan.next({ label: "later" })).issue?.number).toBe(10);
		expect((await yan.next({ type: "bug", under: 8 })).issue?.number).toBe(9);
		expect(await refused(yan.next({ under: 99 }))).toBe("There is no issue #99.");
	});

	it("keeps a backlog for people to release, when the scheme names the state sessions take from", async () => {
		const yan = await member("yan");
		await yan.setScheme({ ...DEFAULT_SCHEME, states: [{ name: "backlog", kind: "open" }, ...DEFAULT_SCHEME.states], rules: { ...DEFAULT_SCHEME.rules, take: "todo" } });
		await yan.create({ title: "Some day", type: "bug" });
		expect(yan.issue(1)?.state).toBe("backlog");
		expect(await yan.next({})).toEqual({ waiting: 0 });
		await yan.update(1, { state: "todo" });
		expect((await yan.next({})).issue?.number).toBe(1);
	});

	it("refuses waiting that could never end, and says what holds an issue", async () => {
		const yan = await member("yan");
		await yan.create({ title: "A", type: "bug" });
		await yan.create({ title: "B", type: "bug", waitsOn: [1] });
		await yan.create({ title: "C", type: "bug", waitsOn: [2, 2, 1] });
		expect(yan.issue(3)?.waitsOn).toEqual([1, 2]);
		expect(await refused(yan.update(1, { waitsOn: [1] }))).toBe("An issue cannot wait on itself.");
		expect(await refused(yan.update(1, { waitsOn: [3] }))).toBe("#3 waits on #1, so #1 cannot wait on it: neither would ever be ready.");
		expect(await refused(yan.update(1, { waitsOn: [9] }))).toBe("There is no issue #9 to wait on.");
		expect(issueLine(yan.issue(3) as Issue, yan.state())).toBe("#3  bug  C  [todo]  (waits on #1, #2)");
		await yan.update(1, { state: "dropped" });
		// What was dropped holds nothing.
		expect(issueLine(yan.issue(3) as Issue, yan.state())).toBe("#3  bug  C  [todo]  (waits on #2)");
		await yan.update(3, { waitsOn: [], human: true, repo: "shop" });
		expect(issueLine(yan.issue(3) as Issue, yan.state())).toBe("#3  bug  C  [todo]  in shop  (for a person)");
		expect((await yan.update(3, { human: false, repo: null })).repo).toBeUndefined();
		expect(yan.issue(3)?.human).toBeUndefined();
	});
});

describe("what people have running", () => {
	it("is told to everyone, and forgotten when its host goes quiet", async () => {
		const yan = await member("yan");
		const sam = await member("sam");
		sam.start();
		await yan.publish("laptop:shop", "shop", [{ id: "n1", name: "card form", role: "implementation", state: "working", issue: 3, activity: "editing form.tsx", asks: 0 }]);
		await until(() => sam.state().sessions.length === 1, "sam to see yan's session");
		expect(sam.state().sessions[0]).toEqual({ host: "laptop:shop", owner: "yan", repo: "shop", id: "n1", name: "card form", role: "implementation", state: "working", issue: 3, activity: "editing form.tsx", asks: 0 });
		expect(sam.state().people).toEqual([{ name: "yan", online: true }, { name: "sam", online: true }]);
		// yan's laptop closes: nothing more is heard from it. The clock here moves one tick per call, so move it on.
		clock += 1_000;
		await until(() => sam.state().sessions.length === 0, "yan's session to be forgotten");
		await until(() => sam.state().people.find((person) => person.name === "yan")?.online === false, "yan to be shown as away");
	});

	it("survives the server going away: the copy stays and is marked as stale, then catches up", async () => {
		const yan = await member("yan");
		await yan.create({ title: "Checkout", type: "epic" });
		const sam = await member("sam");
		sam.start();
		await until(() => sam.state().connected, "sam to connect");
		const { url } = sam.account;
		const port = Number(new URL(url).port);
		await server.stop();
		await until(() => !sam.state().connected, "sam to notice");
		expect(sam.state()).toMatchObject({ connected: false, problem: `The server at ${url} cannot be reached.` });
		expect(sam.state().issues.map((issue) => issue.title)).toEqual(["Checkout"]);
		expect(await refused(sam.update(1, { title: "x" }))).toBe(`The server at ${url} cannot be reached.`);
		// A new, empty server on the same port does not know sam: that is said, not hidden.
		server = new WorkServer({ file: ":memory:", host: "127.0.0.1", port });
		await server.start();
		await until(() => sam.state().problem === "This server does not know you. Join it with its address and code.", "sam to be told");
	});
});

describe("what is kept", () => {
	it("is one file: a server started on it again has everything", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-lattice-server-"));
		try {
			const first = new WorkServer({ file: join(dir, "work.db"), host: "127.0.0.1" });
			const where = `http://127.0.0.1:${await first.start()}/#${first.tracker.code}`;
			const account = await joinServer(where, "yan");
			const yan = new WorkClient(account);
			await yan.create({ title: "Checkout", type: "epic" });
			await yan.comment(1, "First.");
			await first.stop();

			const second = new WorkServer({ file: join(dir, "work.db"), host: "127.0.0.1" });
			const again = new WorkClient({ ...account, url: `http://127.0.0.1:${await second.start()}` });
			await again.refresh();
			expect(again.state().issues.map((issue) => issue.title)).toEqual(["Checkout"]);
			expect((await again.read(1)).comments.map((comment) => comment.body)).toEqual(["First."]);
			expect((await again.create({ title: "Search", type: "epic" })).number).toBe(2);
			await second.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
