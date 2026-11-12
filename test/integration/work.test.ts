/**
 * The team's work, end to end: a real server on a local port, a real host joined to it, and
 * real Pi sessions whose scripted agents use the work tools.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinAndSave, Work } from "../../packages/app/src/work.ts";
import { LatticeHost } from "../../packages/host/src/index.ts";
import { childrenOf } from "../../packages/protocol/src/index.ts";
import { joinServer, WorkClient, WorkServer } from "../../packages/server/src/index.ts";
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

	it("shows the team which session is on which issue, starts the issue when a session is put on it, and finishes it when the result lands", async () => {
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

		// A child is put on the feature. When its result lands, the feature is done; the epic, with nothing unfinished under it, is not touched by that.
		await ask(h, root.id, tool("spawn_session", { name: "card form", kind: "task", issue: 2, brief: `!tool send_message ${JSON.stringify({ to: "parent", text: "card form done", intent: "result" })}` }));
		const kid = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "card form"), "the child");
		expect(kid.issue).toBe(2);
		expect(await said(h, root.id)).toContain(`Spawned "card form" as ${kid.id} (kind task, roles protocol + reporting + worker, on issue #2).`);
		await eventually(() => sam.issue(2)?.state === "done", "the feature to be finished by the result");
		expect((await sam.read(2)).history.map((event) => [event.who, event.what, event.to])).toEqual([["sam", "created", undefined], ["tester", "state", "doing"], ["tester", "state", "done"]]);
		expect(sam.issue(1)?.state).toBe("doing");

		// A helper with no issue of its own is on its parent's.
		await ask(h, root.id, tool("spawn_session", { name: "review", kind: "review", brief: "say ok" }));
		const helper = await eventually(() => childrenOf(h.nodes(), root.id).find((node) => node.name === "review"), "the helper");
		expect(helper.issue).toBe(1);
		await ask(h, root.id, tool("spawn_session", { name: "nowhere", issue: 99, brief: "say ok" }));
		expect(await said(h, root.id)).toContain("There is no issue #99.");
	}, 60_000);

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
		expect(await work.server("status", [])).toBe("You have not joined a server. Join one with /lattice server <address>.");
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
});
