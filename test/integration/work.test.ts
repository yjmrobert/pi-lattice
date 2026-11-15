/**
 * The team's work, end to end: a real server on a local port, a real host joined to it, and
 * real Pi sessions whose scripted agents use the work tools.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardAddress, liveBoard, readBoard } from "../../packages/app/src/board.ts";
import { joinAndSave, readAccount, Work } from "../../packages/app/src/work.ts";
import { LatticeHost } from "../../packages/host/src/index.ts";
import { childrenOf } from "../../packages/protocol/src/index.ts";
import { createCertificate, formatAddress, joinServer, WorkClient, WorkServer } from "../../packages/server/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

let sandbox: Sandbox;
let host: LatticeHost | undefined;
let server: WorkServer | undefined;
let work: Work | undefined;
let address = "";
const others: WorkClient[] = [];

beforeEach(async () => {
	sandbox = createSandbox();
	server = new WorkServer({ file: ":memory:", host: "127.0.0.1" });
	address = `http://127.0.0.1:${await server.start()}/#${server.tracker.code}`;
});
afterEach(async () => {
	for (const client of others.splice(0)) client.stop();
	work?.stop();
	work = undefined;
	await host?.stop();
	host = undefined;
	await server?.stop();
	server = undefined;
	sandbox.cleanup();
});

/** A host whose person has joined the server. */
const joined = async (): Promise<LatticeHost> => {
	const h = await LatticeHost.start(hostOptionsFor(sandbox));
	host = h;
	await joinAndSave(sandbox.home, address, "tester");
	work = new Work({ home: sandbox.home, hostId: "laptop:shop", repo: "shop", name: () => "tester", beatMs: 200 });
	h.setWork(work);
	work.sync();
	await eventually(() => h.uiState().work?.connected, "the host to reach the server");
	return h;
};
const teammate = async (name: string): Promise<WorkClient> => {
	const client = new WorkClient(await joinServer(address, name), { waitSeconds: 5 });
	others.push(client);
	client.start();
	await eventually(() => client.state().connected, `${name} to connect`);
	return client;
};
const tool = (name: string, args: Record<string, unknown>) => `!tool ${name} ${JSON.stringify(args)}`;
const said = async (h: LatticeHost, id: string): Promise<string> => {
	const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(id, { type: "get_messages" });
	return messages
		.filter((m) => m.role === "assistant")
		.map((m) => (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join(""))
		.join("\n");
};
/** Give a session a turn and wait until it has finished it. */
const ask = async (h: LatticeHost, id: string, text: string): Promise<void> => {
	const before = (await said(h, id)).length;
	await h.prompt(id, text);
	await eventually(async () => (await said(h, id)).length > before && h.node(id)?.status === "idle", "the turn to finish");
};
const issues = (h: LatticeHost) => h.uiState().work?.issues ?? [];

describe("the team's work", () => {
	it("is added to and read by an agent, in the team's structure, and seen by a teammate at once", async () => {
		const h = await joined();
		const sam = await teammate("sam");
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work, fragments: ["coordinator"] });

		await ask(h, root.id, tool("work_add", { title: "Checkout", type: "epic", body: "People can pay." }));
		await eventually(() => issues(h).length === 1, "the epic");
		await ask(h, root.id, tool("work_add", { title: "Pay by card", parent: 1, assignee: "sam", labels: ["web"] }));
		await ask(h, root.id, tool("work_add", { title: "Loose task", type: "task" }));
		await ask(h, root.id, tool("work_update", { number: 2, comment: "Stripe's field does most of this." }));
		await ask(h, root.id, tool("work_list", {}));

		const seen = await said(h, root.id);
		expect(seen).toContain("tool-result: Added #1  epic  Checkout  [todo]. Nobody is on it and nothing has started.");
		expect(seen).toContain("tool-result: Added #2  feature  Pay by card  [todo]  @sam  +web, under #1. Nobody is on it and nothing has started.");
		// What does not fit the team's structure is refused, and the agent is told where it goes.
		expect(seen).toContain("A task goes under a story, not at the top.");
		expect(seen).toContain("tool-result: Commented. It is now: #2  feature  Pay by card  [todo]  @sam  +web");
		expect(seen).toContain("Types: epic (at the top); feature (under epic); story (under feature); task (under story); bug (under epic or feature or story or task, or at the top).");
		expect(seen).toContain("#1  epic  Checkout  [todo]\n  #2  feature  Pay by card  [todo]  @sam  +web");
		expect(seen).toContain("This session is on no issue.");

		await eventually(() => sam.state().issues.length === 2, "sam to see both issues");
		expect((await sam.read(2)).comments.map((comment) => [comment.author, comment.body])).toEqual([["tester", "Stripe's field does most of this."]]);
	}, 60_000);

	it("shows the team which session is on which issue, starts the issue when a session is put on it, and puts it up for review when the result lands", async () => {
		const h = await joined();
		const sam = await teammate("sam");
		await sam.create({ title: "Checkout", type: "epic" });
		await sam.create({ title: "Pay by card", parent: 1 });
		await eventually(() => issues(h).length === 2, "the host to hear of sam's issues");
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work, fragments: ["coordinator"] });

		// The coordinator says it is on the epic; the team sees it there, and the epic as started.
		await ask(h, root.id, tool("work_on", { number: 1 }));
		await eventually(() => sam.issue(1)?.state === "doing", "the epic to be started");
		expect(h.node(root.id)?.issue).toBe(1);
		await eventually(() => sam.state().sessions.some((session) => session.id === root.id && session.issue === 1), "sam to see the coordinator on #1");
		expect(sam.state().sessions.find((session) => session.id === root.id)).toMatchObject({ owner: "tester", repo: "shop", host: "laptop:shop", name: "checkout", role: "coordinator" });

		// A child is put on the feature. When its result lands, the feature is up to be checked; the epic is not touched by that.
		await ask(h, root.id, tool("spawn_session", { name: "card form", kind: "task", issue: 2, brief: `!tool send_message ${JSON.stringify({ to: "parent", text: "card form done", intent: "result" })}` }));
		const kid = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "card form"), "the child");
		expect(kid.issue).toBe(2);
		expect(await said(h, root.id)).toContain(`Spawned "card form" as ${kid.id} (kind task, roles protocol + reporting + worker, on issue #2).`);
		await eventually(() => sam.issue(2)?.state === "review", "the feature to be put up for review by the result");
		expect((await sam.read(2)).history.map((event) => [event.who, event.what, event.to])).toEqual([["sam", "created", undefined], ["tester", "state", "doing"], ["tester", "state", "review"]]);
		expect(sam.issue(1)?.state).toBe("doing");

		// A helper with no issue of its own is on its parent's.
		await ask(h, root.id, tool("spawn_session", { name: "review", kind: "review", brief: "say ok" }));
		const helper = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "review"), "the helper");
		expect(helper.issue).toBe(1);
		await ask(h, root.id, tool("spawn_session", { name: "nowhere", issue: 99, brief: "say ok" }));
		expect(await said(h, root.id)).toContain("There is no issue #99.");
	}, 60_000);

	it("gives an agent the next issue that is ready, puts its session on it, and leaves what waits and what is for people", async () => {
		const h = await joined();
		const sam = await teammate("sam");
		await sam.create({ title: "Checkout", type: "epic" });
		await sam.create({ title: "Card form", type: "bug", parent: 1, body: "The form loses the card number on error." });
		await sam.comment(2, "Seen on Safari only.");
		await sam.create({ title: "Charge the card", type: "bug", parent: 1, waitsOn: [2] });
		await sam.create({ title: "Choose a provider", type: "bug", parent: 1, human: true });
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work });
		await eventually(() => issues(h).length === 4, "the host to hear of the issues");
		await ask(h, root.id, tool("work_next", {}));
		const seen = await said(h, root.id);
		expect(seen).toContain("This session is on #2  bug  Card form  [doing]  @tester.");
		expect(seen).toContain("The form loses the card number on error.");
		expect(seen).toContain("sam: Seen on Safari only.");
		expect(h.node(root.id)?.issue).toBe(2);
		await eventually(() => sam.state().sessions.find((session) => session.id === root.id)?.issue === 2, "sam to see the session on the issue");
		// What is left waits on #2 or is for a person.
		await ask(h, root.id, tool("work_next", {}));
		expect(await said(h, root.id)).toContain("Nothing is ready: 1 issue waits on others that are not finished.");
		// An agent writes work down with what it waits on, and marks what is a person's.
		await ask(h, root.id, tool("work_add", { title: "Send the receipt", type: "bug", parent: 1, waits_on: [3], human: true, repo: "mail" }));
		expect(await said(h, root.id)).toContain("Added #5  bug  Send the receipt  [todo]  in mail  (for a person)  (waits on #3), under #1.");
		await ask(h, root.id, tool("work_update", { number: 5, waits_on: [], human: false }));
		await eventually(() => sam.issue(5)?.waitsOn === undefined && sam.issue(5)?.human === undefined, "the change to reach sam");
		// It is for another repository, so it is not this session's to take.
		await ask(h, root.id, tool("work_next", {}));
		expect(h.node(root.id)?.issue).toBe(2);
	});

	it("says there is no server when there is none, and does nothing", async () => {
		const h = await LatticeHost.start(hostOptionsFor(sandbox));
		host = h;
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work, fragments: ["coordinator"] });
		await ask(h, root.id, tool("work_list", {}));
		await ask(h, root.id, tool("spawn_session", { name: "nowhere", issue: 1, brief: "say ok" }));
		const seen = await said(h, root.id);
		expect(seen).toContain("There is no server: you have not joined one.");
		expect(seen).toContain("There is no server, so there is no issue to put it on. Leave the issue out.");
		expect(h.uiState().work).toBeUndefined();
	}, 60_000);

	it("is joined, looked at and left by name, and every host of the person follows", async () => {
		const h = await LatticeHost.start(hostOptionsFor(sandbox));
		host = h;
		work = new Work({ home: sandbox.home, hostId: "laptop:shop", repo: "shop", name: () => "tester" });
		h.setWork(work);
		work.sync();
		expect(await work.server("status", [])).toBe("You are on no server. Start a board on this machine with /lattice server start, or join your team's with /lattice server <address>.");
		await (await teammate("sam")).create({ title: "Checkout", type: "epic" });
		expect(await work.server("join", [address])).toBe(`Joined ${address.replace(/\/#.*/, "")} as tester. It has 1 issue. Press c in the pane for the canopy.`);
		expect(h.uiState().work).toMatchObject({ me: "tester", connected: true });
		expect(await work.server("status", [])).toMatch(/as tester\. 1 issue, 2 people \(2 online\), 0 sessions running\.$/);

		// The same person's host for another repository reads the same file.
		const elsewhere = new Work({ home: sandbox.home, hostId: "laptop:docs", repo: "docs", name: () => "tester" });
		elsewhere.sync();
		await eventually(() => elsewhere.state()?.issues.length === 1, "the other host to follow");
		expect(await work.server("leave", [])).toContain("Left ");
		elsewhere.sync();
		expect(elsewhere.state()).toBeNull();
		expect(h.uiState().work).toBeUndefined();
		elsewhere.stop();
	}, 60_000);

	it("lets someone already on a server take its address again when it starts encrypting, and stay who they are", async () => {
		// A server that encrypts, joined the old way: in the clear, as a member from before would be.
		const secure = new WorkServer({ file: ":memory:", host: "127.0.0.1", tls: createCertificate() });
		const port = await secure.start();
		try {
			const h = await LatticeHost.start(hostOptionsFor(sandbox));
			host = h;
			work = new Work({ home: sandbox.home, hostId: "laptop:shop", repo: "shop", name: () => "tester" });
			h.setWork(work);
			expect(await work.server("join", [`http://127.0.0.1:${port}/#${secure.tracker.code}`])).toContain("Joined http://127.0.0.1");
			const before = readAccount(sandbox.home);
			expect(before?.pin).toBeUndefined();

			// A wrong address changes nothing.
			const wrong = formatAddress(`https://127.0.0.1:${port}`, secure.tracker.code, "A".repeat(43));
			expect(await work.server("join", [wrong]).catch((error: Error) => error.message)).toContain("not the server this address was given for");
			expect(readAccount(sandbox.home)).toEqual(before);

			const address = formatAddress(`https://127.0.0.1:${port}`, secure.tracker.code, secure.pin);
			expect(await work.server("join", [address])).toBe(`You are still tester on https://127.0.0.1:${port}. Everything said to it is encrypted from here on, and only that server is spoken to.`);
			expect(readAccount(sandbox.home)).toEqual({ ...before, url: `https://127.0.0.1:${port}`, pin: secure.pin });
			expect(secure.tracker.people().map((person) => person.name)).toEqual(["tester"]);
			await eventually(() => h.uiState().work?.connected === true, "the host to be on the server again, encrypted");
		} finally {
			work?.stop();
			work = undefined;
			await secure.stop();
		}
	}, 60_000);

	it("is kept on the person's own machine with nothing to deploy, shared with teammates, and started again by whoever finds it gone", async () => {
		const boards: ChildProcess[] = [];
		// As a host starts it: `pi-lattice server --board`, a process of its own.
		const spawnBoard = (args: string[]): void => void boards.push(spawn(process.execPath, [resolve("packages/app/src/cli.ts"), ...args], { env: { ...process.env, LATTICE_HOME: sandbox.home }, stdio: "ignore" }));
		const h = await LatticeHost.start(hostOptionsFor(sandbox));
		host = h;
		work = new Work({ home: sandbox.home, hostId: "laptop:shop", repo: "shop", name: () => "tester", spawnBoard });
		h.setWork(work);
		work.sync();
		try {
			expect(await work.server("share", []).catch((error: Error) => error.message)).toBe("Only the board on this machine can be shared from here. Start one with /lattice server start.");
			expect(await work.server("start", [])).toBe(
				"A board is running on this machine, and you are on it as tester. There is no work on it yet: tell a session what you want done, and it writes the work down. Press c in the pane for the canopy. Only this machine can reach it. To let teammates join, /lattice server share.",
			);
			await h.runWork({ do: "add", change: { title: "Checkout", type: "epic" } });
			expect(await work.server("status", [])).toBe("The board on this machine, not shared, as tester. 1 issue, 1 person (1 online), 0 sessions running.");
			const first = readBoard(sandbox.home);
			expect(first).toMatchObject({ shared: false });

			// Shared: the same work, at an address with the code teammates need.
			const shared = await work.server("share", []);
			expect(shared).toContain("The board is shared.");
			const board = await liveBoard(sandbox.home);
			expect(board).toMatchObject({ shared: true, port: first?.port, code: first?.code });
			expect(board?.pid).not.toBe(first?.pid);
			// What teammates are given is encrypted, and says which machine it is.
			expect(board?.pin).toMatch(/^[\w-]{43}$/);
			expect(shared).toContain("Connections to it are encrypted");
			const line = boardAddress(board as NonNullable<typeof board>, "127.0.0.1");
			expect(line).toBe(`https://127.0.0.1:${board?.port}/#${board?.code}.${board?.pin}`);
			expect([...shared.matchAll(/\/lattice server (http\S+)/g)].every((match) => (match[1] as string).startsWith("https://") && (match[1] as string).endsWith(`.${board?.pin}`))).toBe(true);
			const sam = new WorkClient(await joinServer(line, "sam"), { waitSeconds: 5 });
			others.push(sam);
			await sam.refresh();
			expect(sam.state().issues.map((issue) => issue.title)).toEqual(["Checkout"]);
			expect(await work.server("join", [address]).catch((error: Error) => error.message)).toContain("This machine shares its own board.");
			expect(await work.server("unshare", [])).toContain("The board is no longer shared");
			expect(await liveBoard(sandbox.home)).toMatchObject({ shared: false });

			// The board is gone, as after a restart of the machine: the host that notices starts it, and nothing is lost.
			process.kill((await liveBoard(sandbox.home))?.pid as number, "SIGTERM");
			await eventually(() => h.uiState().work?.connected === false, "the host to notice the board is gone", 20_000);
			work.sync();
			await eventually(() => h.uiState().work?.connected === true, "the board to be started again", 30_000);
			expect(issues(h).map((issue) => issue.title)).toEqual(["Checkout"]);

			// Leaving and coming back is the same person.
			expect(await work.server("leave", [])).toBe("Left the board on this machine. Its work is kept: /lattice server start brings it back.");
			expect(h.uiState().work).toBeUndefined();
			expect(await work.server("start", [])).toContain("you are on it as tester. It has 1 issue.");
		} finally {
			for (const child of boards) child.kill("SIGTERM");
		}
	}, 90_000);
});
describe("steering the work", () => {
	const answered = async (h: LatticeHost, text: string): Promise<string> =>
		eventually(() => h.uiState().steers?.find((steer) => steer.text === text)?.answer, "the session that tends it to answer");

	it("takes what a person says about an issue to the session tending it, which changes the work, says why, and answers in a sentence", async () => {
		const h = await joined();
		const sam = await teammate("sam");
		await sam.create({ title: "Checkout", type: "epic" });
		await sam.create({ title: "Pay by card", parent: 1 });
		await sam.create({ title: "Cart", parent: 1 });
		await eventually(() => issues(h).length === 3, "the host to hear of the issues");
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work, fragments: ["coordinator"] });
		await ask(h, root.id, tool("work_on", { number: 1 }));

		// Said about the second feature: it goes to the coordinator on the epic above it.
		const first = tool("work_update", { number: 3, place: "first", why: "the person said so" });
		const steer = await h.steer({ number: 3, text: first });
		expect(steer).toMatchObject({ about: "#3 Cart (feature)", number: 3, to: { nodeId: root.id, name: "checkout", role: "coordinator" }, line: 1 });
		expect(await answered(h, first)).toContain("tool-result: Changed place.");
		// The session was told who said it, about what, and how to answer.
		const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(root.id, { type: "get_messages" });
		const told = messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join(""))).join("\n");
		expect(told).toContain("[pi-lattice] tester says, about #3 Cart (feature):");
		expect(told).toContain("End your turn with one sentence that says what you did");
		// The change is the agent's, with why; the order is the server's, for everyone.
		await eventually(() => (sam.issue(3)?.rank ?? 99) < (sam.issue(2)?.rank ?? 0), "the cart to come first");
		expect((await sam.read(3)).history.at(-1)).toMatchObject({ who: "tester", as: "coordinator", what: "order", to: "first", why: "the person said so" });
		// What was said is kept on the issue in the person's words, and stands only once the session keeps it.
		expect((await sam.read(3)).said).toMatchObject([{ id: 1, who: "tester", text: first, stands: false }]);

		const rule = `ask me before this lands ${tool("work_direction", { line: 2 })}`;
		await h.steer({ number: 1, text: rule });
		expect(await answered(h, rule)).toContain("tool-result: Kept. Standing on #1:");
		await eventually(() => sam.issue(1)?.directions?.length === 1, "the direction to stand on the epic");
		expect(sam.issue(1)?.directions?.[0]).toMatchObject({ who: "tester", text: rule });
		// An agent cannot say a line of its own, or mark what a person has seen.
		await ask(h, root.id, tool("work_update", { number: 1, comment: "noted" }));
		expect(await h.runWork({ do: "say", number: 1, text: "mine" }, root.id).then(() => "allowed", (error: Error) => error.message)).toContain("Only a person does that");
		// Everything the agent did is new to a teammate who has not looked since.
		await sam.refresh();
		expect(sam.state().recent.filter((event) => event.rev > sam.state().seen && event.as === "coordinator").map((event) => event.what)).toEqual(expect.arrayContaining(["order", "direction", "commented"]));
	}, 60_000);

	it("starts a session to tend a branch that nothing tends, and takes a line about a session where there is no server issue", async () => {
		const h = await joined();
		const sam = await teammate("sam");
		await sam.create({ title: "Search", type: "epic" });
		await sam.create({ title: "Reindex", parent: 1 });
		await eventually(() => issues(h).length === 2, "the host to hear of the issues");
		// The session here does not coordinate: nothing tends the epic.
		const root = await h.createRoot({ name: "scratch", cwd: sandbox.work });
		const text = tool("work_update", { number: 2, comment: "start here" });
		const steer = await h.steer({ number: 2, text });
		const tender = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "search"), "a session to be started on the epic");
		expect(tender).toMatchObject({ kind: "epic", issue: 1 });
		expect(tender.fragments).toContain("coordinator");
		expect(steer.to).toMatchObject({ nodeId: tender.id, role: "coordinator" });
		expect(await answered(h, text)).toContain("tool-result: Commented.");
		await eventually(async () => (await sam.read(2)).comments.some((comment) => comment.body === "start here"), "the comment");
		// A second line goes to the same session: it tends the branch now.
		const again = tool("work_update", { number: 2, comment: "and then this" });
		expect((await h.steer({ number: 1, text: again })).to.nodeId).toBe(tender.id);
		await answered(h, again);
		// About a session, with no issue: to the nearest one above that coordinates, here the tender itself.
		expect((await h.steer({ nodeId: tender.id, text: "carry on" })).about).toBe('"search" (epic)');
		expect(await h.steer({ number: 99, text: "x" }).then(() => "allowed", (error: Error) => error.message)).toBe("There is no issue #99.");
	}, 60_000);

	it("hands a result to whatever checks it: the session tending the branch for a task, a reviewer of its own for anything larger", async () => {
		const h = await joined();
		const sam = await teammate("sam");
		await sam.create({ title: "Checkout", type: "epic" });
		await sam.create({ title: "Pay by card", parent: 1 });
		await sam.create({ title: "Total is wrong", type: "bug", parent: 1 });
		await eventually(() => issues(h).length === 3, "the host to hear of the issues");
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work, fragments: ["coordinator"] });
		await ask(h, root.id, tool("work_on", { number: 1 }));

		// An agent with no host, from a shell, takes the bug and finishes it.
		const taken = await sam.next({ type: "bug", lease: true }, { as: "claude" });
		expect(taken.issue).toMatchObject({ number: 3, agent: "claude" });
		await eventually(() => issues(h).find((issue) => issue.number === 3)?.agent === "claude", "the host to see who holds it");
		await sam.done(3, { summary: "The total adds tax once.", checks: "9 tests pass" }, { as: "claude" });
		// A bug is checked by the session tending the branch: it is told, with what was reported.
		await eventually(async () => (await said(h, root.id)).includes('A result is in on #3 "Total is wrong" (bug), from claude.'), "the coordinator to be told of the result");
		const told = await said(h, root.id);
		expect(told).toContain("The total adds tax once.");
		expect(told).toContain("Checked: 9 tests pass");
		expect(childrenOf(h.nodes(), root.id).some((node) => node.name === "review-3")).toBe(false);

		// A feature is checked by a session of its own, with the reviewer role, under the one that tends it.
		await sam.done(2, { summary: "Cards can be paid with." }, { as: "claude" });
		const reviewer = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "review-2"), "a reviewer to be started");
		expect(reviewer).toMatchObject({ kind: "review", issue: 2 });
		expect(reviewer.fragments).toContain("reviewer");
		await eventually(async () => (await said(h, reviewer.id)).includes('Check the result that came in on #2 "Pay by card" (feature), from claude'), "the reviewer to have its brief");
	}, 60_000);

	it("gives the root of a tree the coordinator role once its sessions are on a board's issues, so their results are checked, and says so when nothing can check one", async () => {
		const h = await joined();
		const logs: string[] = [];
		h.on("log", (_level: string, message: string) => logs.push(message));
		const sam = await teammate("sam");
		await sam.create({ title: "Checkout", type: "epic" });
		await sam.create({ title: "Pay by card", parent: 1 });
		await sam.create({ title: "Refunds", parent: 1 });
		await eventually(() => issues(h).length === 3, "the host to hear of the issues");

		// A plain first session, as a person's is: no roles were chosen for it. It delegates a feature, as a brief told it to.
		const root = await h.createRoot({ name: "build", cwd: sandbox.work });
		expect(root.fragments).toEqual(["protocol"]);
		await ask(h, root.id, tool("spawn_session", { name: "card form", kind: "task", issue: 2, brief: `!tool send_message ${JSON.stringify({ to: "parent", text: "card form done", intent: "result" })}` }));
		// Nothing here tended the board, and now work is on it: the root does (ADR 0036).
		await eventually(() => h.node(root.id)?.fragments.includes("coordinator"), "the root to be given the coordinator role");
		expect(logs.some((line) => line.includes('"build" now has the coordinator role'))).toBe(true);
		// So the result on the feature gets its reviewer, instead of staying in review for good.
		const reviewer = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "review-2"), "a reviewer to be started");
		expect(reviewer.fragments).toContain("reviewer");
	}, 60_000);

	it("leaves the root as the person chose it, and says that a result has nobody to check it", async () => {
		const h = await joined();
		const logs: string[] = [];
		h.on("log", (_level: string, message: string) => logs.push(message));
		// The person chose the first session's roles, and coordinator is not among them.
		mkdirSync(join(sandbox.root, "state"), { recursive: true });
		writeFileSync(join(sandbox.root, "state", "config.json"), JSON.stringify({ roles: { root: ["lifecycle"] } }));
		const sam = await teammate("sam");
		await sam.create({ title: "Checkout", type: "epic" });
		await sam.create({ title: "Pay by card", parent: 1 });
		await eventually(() => issues(h).length === 2, "the host to hear of the issues");
		const root = await h.createRoot({ name: "build", cwd: sandbox.work });
		await ask(h, root.id, tool("spawn_session", { name: "card form", kind: "task", issue: 2, brief: `!tool send_message ${JSON.stringify({ to: "parent", text: "card form done", intent: "result" })}` }));
		await eventually(() => sam.issue(2)?.state === "review", "the result to land");
		await eventually(() => logs.some((line) => line.includes("The result on #2 has nobody to check it")), "the host to say that nothing checks it");
		expect(h.node(root.id)?.fragments).not.toContain("coordinator");
		expect(childrenOf(h.nodes(), root.id).some((node) => node.name === "review-2")).toBe(false);
	}, 60_000);
});
