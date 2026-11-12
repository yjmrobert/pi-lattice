import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childrenOf, formatTree, type NodeMeta } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LatticeHost } from "../../packages/host/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

let sandbox: Sandbox;
let host: LatticeHost | undefined;

beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(async () => {
	await host?.stop();
	host = undefined;
	sandbox.cleanup();
});

const startHost = async (overrides: Record<string, unknown> = {}) => {
	host = await LatticeHost.start(hostOptionsFor(sandbox, overrides));
	return host;
};
const spawnTool = (args: Record<string, unknown>) => `!tool spawn_session ${JSON.stringify(args)}`;
const sendTool = (to: string, text: string) => `!tool send_message ${JSON.stringify({ to, text })}`;
/** Text of every assistant message a node's session has produced. */
const assistantTexts = async (h: LatticeHost, id: string): Promise<string> => {
	const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(id, { type: "get_messages" });
	return messages
		.filter((m) => m.role === "assistant")
		.map((m) => (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join(""))
		.join("\n");
};
const settled = (h: LatticeHost, id: string) => eventually(() => h.node(id)?.status === "idle", `${id} to be idle`);
const child = (h: LatticeHost, parent: string, name: string) => eventually(() => childrenOf(h.nodes(), parent).find((n) => n.name === name), `child ${name}`);

describe("host tree", () => {
	it("lets a coordinator spawn a child; both appear in the tree and the child reports back", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "checkout", cwd: sandbox.work, fragments: ["coordinator"] });
		expect(h.node(root.id)).toMatchObject({ status: "idle", parentId: null, owner: "tester" });

		await h.prompt(root.id, spawnTool({ name: "payments", kind: "task", fragments: ["worker"], brief: sendTool("parent", "payments done") }));
		const kid = await child(h, root.id, "payments");
		expect(kid).toMatchObject({ kind: "task", fragments: ["protocol", "reporting", "worker"], rootId: root.id, workspace: "shared", cwd: root.cwd });

		// The child ran its brief and reported to "parent"; the coordinator's model saw it.
		await eventually(async () => (await assistantTexts(h, root.id)).includes("payments done"), "report to reach the coordinator");
		const seen = await assistantTexts(h, root.id);
		expect(seen).toContain(`from="${kid.id}"`);
		expect(seen).toContain(`Spawned "payments" as ${kid.id}`);

		await settled(h, kid.id);
		expect(formatTree(h.nodes())).toBe(
			[`checkout  [feature]  ${root.id}  idle  roles=protocol+coordinator`, `└─ payments  [task]  ${kid.id}  idle  roles=protocol+reporting+worker`].join("\n"),
		);
		// Both sessions carry the roles they were given.
		expect(await assistantTexts(h, kid.id)).toContain("tool-result: Sent");
	});

	it("journals routed envelopes with the resolved recipient", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "kid", brief: sendTool("parent", "hello up") }));
		const kid = await child(h, root.id, "kid");
		const record = await eventually(() => h.traffic().find((r) => r.envelope.payload.text === "hello up" && r.mailState === "delivered" && r.acked), "delivered and acknowledged journal record");
		expect(record).toMatchObject({ recipient: root.id, acked: true });
		expect(record.envelope).toMatchObject({ from: kid.id, to: "parent", fromOwner: "tester" });
	});

	it("shows the tree to the model and resolves children and root addresses", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "one", brief: "wait for instructions" }));
		const one = await child(h, root.id, "one");
		await settled(h, root.id);
		await h.prompt(root.id, spawnTool({ name: "two", brief: "wait for instructions" }));
		const two = await child(h, root.id, "two");
		await settled(h, root.id);

		await h.prompt(root.id, sendTool("children", "status please"));
		for (const kid of [one, two]) {
			await eventually(async () => (await assistantTexts(h, kid.id)).includes("status please"), `broadcast to reach ${kid.name}`);
		}
		await settled(h, root.id);
		await h.prompt(root.id, "!tool list_sessions {}");
		await eventually(async () => (await assistantTexts(h, root.id)).includes("(you)"), "tree listing");
		const listing = await assistantTexts(h, root.id);
		expect(listing).toContain(`├─ one  [task]  ${one.id}`);
		expect(listing).toContain(`└─ two  [task]  ${two.id}`);
	});

	it("tells a root session it has no parent", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, sendTool("parent", "anyone?"));
		await eventually(async () => (await assistantTexts(h, root.id)).includes("has no parent"), "no-parent error");
	});
});

describe("host limits", () => {
	it("refuses to exceed the child limit and tells the model why", async () => {
		const h = await startHost({ limits: { maxChildren: 1 } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "first", brief: "wait" }));
		await child(h, root.id, "first");
		await settled(h, root.id);
		await h.prompt(root.id, spawnTool({ name: "second", brief: "wait" }));
		await eventually(async () => (await assistantTexts(h, root.id)).includes("already has 1 children"), "child limit error");
		expect(childrenOf(h.nodes(), root.id)).toHaveLength(1);
	});

	it("refuses to exceed the depth limit", async () => {
		const h = await startHost({ limits: { maxDepth: 1 } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const kid = await h.spawnChild(root.id, { name: "kid", brief: "wait" });
		await expect(h.spawnChild(kid.id, { name: "grandkid", brief: "wait" })).rejects.toThrow(/limited to 1 levels/);
	});

	it("refuses to exceed the tree size limit", async () => {
		const h = await startHost({ limits: { maxNodes: 2 } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.spawnChild(root.id, { name: "kid", brief: "wait" });
		await expect(h.spawnChild(root.id, { name: "another", brief: "wait" })).rejects.toThrow(/already has 2 sessions/);
	});

	it("puts an idle session to sleep to stay under the running cap, and wakes it for mail", async () => {
		const h = await startHost({ limits: { maxRunning: 2 } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const one = await h.spawnChild(root.id, { name: "one", brief: "wait" });
		await settled(h, one.id);
		h.pin(root.id);
		const two = await h.spawnChild(root.id, { name: "two", brief: "wait" });
		await settled(h, two.id);
		expect(h.node(one.id)?.status).toBe("dormant");
		expect(h.isRunning(one.id)).toBe(false);

		// Mail for the sleeping node wakes it (and puts the other idle child to sleep to make room).
		await h.prompt(root.id, sendTool(one.id, "wake up"));
		await eventually(async () => h.isRunning(one.id) && (await assistantTexts(h, one.id)).includes("wake up"), "sleeping node to wake and read its mail");
		expect(h.node(one.id)?.sessionFile).toBeTruthy();
	});
});

describe("host supervision", () => {
	it("marks a node blocked while a dialog is open, and never answers it on its own", async () => {
		const h = await startHost({ env: { ...hostOptionsFor(sandbox).env, LATTICE_APPROVAL: "always" } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const kid = await h.spawnChild(root.id, { name: "kid", brief: sendTool("parent", "needs approval") });
		const pending = await eventually(() => h.pendingMail()[0], "pending mail on the root");
		expect(pending).toMatchObject({ recipient: root.id, mailState: "pending" });
		expect(pending.envelope.from).toBe(kid.id);

		// Opening the inbox raises a dialog: the node is blocked until a human answers.
		void h.prompt(root.id, "/inbox").catch(() => {});
		await eventually(() => h.node(root.id)?.status === "blocked", "root to be blocked");
		const dialog = h.dialogs(root.id)[0];
		expect(dialog).toMatchObject({ method: "select", options: ["Approve", "Reject", "Decide later"] });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(h.node(root.id)?.status).toBe("blocked");

		h.answerDialog(root.id, dialog?.id ?? "", { value: "Approve" });
		await eventually(async () => (await assistantTexts(h, root.id)).includes("needs approval"), "approved mail to reach the model");
		await settled(h, root.id);
		expect(h.pendingMail()).toHaveLength(0);
	});

	it("approves pending mail from the host without opening a dialog", async () => {
		const h = await startHost({ env: { ...hostOptionsFor(sandbox).env, LATTICE_APPROVAL: "always" } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.spawnChild(root.id, { name: "kid", brief: sendTool("parent", "approve from host") });
		const pending = await eventually(() => h.pendingMail()[0], "pending mail");
		await h.decideMail(root.id, pending.envelope.id, "approve");
		await eventually(async () => (await assistantTexts(h, root.id)).includes("approve from host"), "approved mail to reach the model");
	});

	it("rejects pending mail from the host, and the model never sees it", async () => {
		const h = await startHost({ env: { ...hostOptionsFor(sandbox).env, LATTICE_APPROVAL: "always" } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.spawnChild(root.id, { name: "kid", brief: sendTool("parent", "reject me") });
		const pending = await eventually(() => h.pendingMail()[0], "pending mail");
		await h.decideMail(root.id, pending.envelope.id, "reject");
		await eventually(() => h.traffic().find((r) => r.envelope.id === pending.envelope.id)?.mailState === "rejected", "rejected state");
		expect(await assistantTexts(h, root.id)).not.toContain("reject me");
	});

	it("reports a session that cannot start as failed, with the reason", async () => {
		const broken = join(sandbox.root, "broken-pi.mjs");
		writeFileSync(broken, "process.stderr.write('boom from pi'); process.exit(3);");
		const h = await startHost({ piCommand: [process.execPath, broken], startTimeoutMs: 5000 });
		await expect(h.createRoot({ name: "root", cwd: sandbox.work })).rejects.toThrow(/boom from pi/);
		expect(h.nodes()[0]?.status).toBe("failed");
	});

	it("refuses a second host on the same state directory", async () => {
		await startHost();
		writeFileSync(join(sandbox.root, "state", "host.lock"), String(process.ppid));
		await expect(LatticeHost.start(hostOptionsFor(sandbox))).rejects.toThrow(/already running/);
		writeFileSync(join(sandbox.root, "state", "host.lock"), String(process.pid));
	});
});

describe("host persistence", () => {
	it("keeps the tree across a host restart and resumes sessions with their history and roles", async () => {
		let h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work, fragments: ["coordinator"] });
		const kid = await h.spawnChild(root.id, { name: "kid", fragments: ["worker"], brief: "remember the word heliotrope" });
		await settled(h, kid.id);
		await h.stop();

		h = await startHost();
		const restored = h.nodes();
		expect(restored.map((n: NodeMeta) => [n.name, n.status])).toEqual([["root", "dormant"], ["kid", "dormant"]]);
		expect(h.isRunning(kid.id)).toBe(false);

		await h.prompt(kid.id, "which roles?");
		await eventually(async () => (await assistantTexts(h as LatticeHost, kid.id)).includes("which roles?"), "resumed child to answer");
		const text = await assistantTexts(h, kid.id);
		expect(text).toContain("heliotrope");
		expect(text).toContain("roles=[lattice-role-protocol,lattice-role-reporting,lattice-role-worker]");
		expect(h.node(kid.id)?.sessionFile).toBe(restored[1]?.sessionFile);
	});
});

describe("sessions that know how to talk to each other", () => {
	const userMessages = async (h: LatticeHost, id: string): Promise<string> => {
		const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(id, { type: "get_messages" });
		return messages.filter((m) => m.role !== "assistant").map((m) => (typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join(""))).join("\n");
	};
	const result = (text: string) => `!tool send_message ${JSON.stringify({ to: "parent", text, intent: "result" })}`;

	it("gives every session the protocol, every child how to report, and a child with no roles the default ones", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		expect(root.fragments).toEqual(["protocol"]);
		expect((await h.spawnChild(root.id, { name: "plain", brief: "x" })).fragments).toEqual(["protocol", "reporting", "worker"]);
		expect((await h.spawnChild(root.id, { name: "chosen", brief: "x", fragments: ["planning"] })).fragments).toEqual(["protocol", "reporting", "planning"]);
		// The child's model is told all of it, in that order.
		await eventually(async () => (await assistantTexts(h, childrenOf(h.nodes(), root.id)[0]?.id ?? "")).includes("roles=[lattice-role-protocol,lattice-role-reporting,lattice-role-worker]"), "the child to see its roles");

		// The settings say which; a repository can change or empty them.
		writeFileSync(join(h.stateDir, "config.json"), JSON.stringify({ roles: { tree: [], children: [], child: ["implementation"], root: ["coordinator"] } }));
		expect((await h.spawnChild(root.id, { name: "later", brief: "x" })).fragments).toEqual(["implementation"]);
		expect((await h.createRoot({ name: "second", cwd: sandbox.work })).fragments).toEqual(["coordinator"]);
	});

	it("writes a brief from the person's own template when there is one, this repository's first", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		mkdirSync(join(sandbox.home, "templates"), { recursive: true });
		writeFileSync(join(sandbox.home, "templates", "brief.md"), "MINE for {{name}} from {{parent.name}}:\n{{brief}}\n");
		const first = await h.spawnChild(root.id, { name: "one", brief: "count {{name}} sheep" });
		await settled(h, first.id);
		// What the brief itself says is never read as template text.
		expect(await userMessages(h, first.id)).toContain("MINE for one from root:\ncount {{name}} sheep");

		mkdirSync(join(h.stateDir, "templates"), { recursive: true });
		writeFileSync(join(h.stateDir, "templates", "brief.md"), "OURS: {{brief}}");
		const second = await h.spawnChild(root.id, { name: "two", brief: "again" });
		await settled(h, second.id);
		expect(await userMessages(h, second.id)).toContain("OURS: again");
		expect(h.template("handover")).toContain("moved between the background and a terminal");
	});

	it("reminds a child that ends its turn without reporting, then tells its parent", async () => {
		const h = await startHost();
		writeFileSync(join(h.stateDir, "config.json"), JSON.stringify({ reports: { remind: true } }));
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const quiet = await h.spawnChild(root.id, { name: "quiet", brief: "think about it" });
		await eventually(async () => (await assistantTexts(h, root.id)).includes("stopped without reporting"), "the parent to be told");
		expect(await userMessages(h, quiet.id)).toContain('[pi-lattice] You ended your turn without reporting to your parent, "root"');
		const told = await userMessages(h, root.id);
		expect(told).toContain(`from="${quiet.id}"`);
		expect(told).toContain('intent="stopped"');
		expect(told).toContain(`Your child session "quiet" (${quiet.id}) stopped without reporting: it ended its turn twice without sending a report.`);
		// It is told once, not at every turn the child ends after that.
		await settled(h, quiet.id);
		expect(h.traffic({ node: root.id }).filter((record) => record.envelope.intent === "stopped")).toHaveLength(1);
	});

	it("leaves a child alone that has reported, and marks it done until it is given more", async () => {
		const h = await startHost();
		writeFileSync(join(h.stateDir, "config.json"), JSON.stringify({ reports: { remind: true } }));
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const kid = await h.spawnChild(root.id, { name: "kid", brief: result("all done") });
		await eventually(() => h.node(kid.id)?.done === true, "the child to be done");
		await settled(h, kid.id);
		await eventually(async () => (await assistantTexts(h, root.id)).includes("all done"), "the result to arrive");
		expect(await userMessages(h, kid.id)).not.toContain("You ended your turn without reporting");
		expect(h.traffic({ node: root.id }).some((record) => record.envelope.intent === "stopped")).toBe(false);

		// More work from its parent: it is not done any more, until it sends another result.
		await h.prompt(root.id, sendTool(kid.id, "!reply noted"));
		await eventually(async () => (await assistantTexts(h, root.id)).includes("noted"), "the answer to the extra work");
		expect(h.node(kid.id)?.done).toBeUndefined();
	});

	it("tells a parent when its child's process dies before it reported", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const kid = await h.spawnChild(root.id, { name: "doomed", brief: '!tool bash {"command":"kill -9 $PPID"}' });
		await eventually(() => h.node(kid.id)?.status === "failed", "the child to fail");
		await eventually(async () => (await assistantTexts(h, root.id)).includes("stopped without reporting: its process failed"), "the parent to be told");
	});
});

describe("sessions that wait on others", () => {
	const userMessages = async (h: LatticeHost, id: string): Promise<string> => {
		const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(id, { type: "get_messages" });
		return messages.filter((m) => m.role !== "assistant").map((m) => (typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join(""))).join("\n");
	};
	const result = (text: string) => `!tool send_message ${JSON.stringify({ to: "parent", text, intent: "result" })}`;

	it("creates a child without starting it, and starts it when what it waits on has sent its result", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const schema = await h.spawnChild(root.id, { name: "schema", brief: "wait for instructions" });
		// By name, whatever its case; by id works the same.
		const api = await h.spawnChild(root.id, { name: "api", brief: result("api done"), waitsOn: ["Schema"] });
		expect(api).toMatchObject({ status: "dormant", waitsOn: [schema.id], sessionFile: null });
		expect(formatTree(h.nodes())).toContain(`api  [task]  ${api.id}  dormant  roles=protocol+reporting+worker  waits-on=schema`);
		await settled(h, schema.id);
		expect(h.isRunning(api.id)).toBe(false);

		await h.prompt(schema.id, result("schema done"));
		await eventually(() => h.node(api.id)?.done === true, "the waiting child to run and report");
		expect(h.node(api.id)?.waitsOn).toBeUndefined();
		expect(await userMessages(h, api.id)).toContain('You were kept from starting until these sessions had sent their results, which they now have: "schema".');
		await eventually(async () => (await assistantTexts(h, root.id)).includes("api done"), "its result to reach the parent");
	});

	it("tells the model what it waits on, and starts at once a child whose wait is already over", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "schema", brief: "wait for instructions" }));
		const schema = await child(h, root.id, "schema");
		await settled(h, root.id);
		await h.prompt(root.id, spawnTool({ name: "api", brief: "wait for instructions", waits_on: ["schema"] }));
		const api = await child(h, root.id, "api");
		await eventually(async () => (await assistantTexts(h, root.id)).includes(`It has not started: it waits on "schema" (${schema.id}).`), "the tool to say it is waiting");
		expect(h.isRunning(api.id)).toBe(false);

		await settled(h, schema.id);
		await h.prompt(schema.id, result("schema done"));
		await eventually(() => h.node(schema.id)?.done === true, "schema to be done");
		const later = await h.spawnChild(root.id, { name: "docs", brief: "wait for instructions", waitsOn: [schema.id] });
		expect(later.waitsOn).toBeUndefined();
		expect(h.isRunning(later.id)).toBe(true);
	});

	it("refuses to wait on a session that is not there, or on one above the new session", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const kid = await h.spawnChild(root.id, { name: "kid", brief: "wait" });
		await expect(h.spawnChild(root.id, { name: "x", brief: "wait", waitsOn: ["nobody"] })).rejects.toThrow(/no session "nobody" in this tree to wait on/);
		await expect(h.spawnChild(kid.id, { name: "x", brief: "wait", waitsOn: [root.id] })).rejects.toThrow(/"root" is above the new session/);
		await expect(h.spawnChild(kid.id, { name: "x", brief: "wait", waitsOn: ["kid"] })).rejects.toThrow(/"kid" is above the new session/);
		expect(h.nodes()).toHaveLength(2);
	});

	it("is not started by a message to every child, and is started by one sent to it", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const schema = await h.spawnChild(root.id, { name: "schema", brief: "wait for instructions" });
		const api = await h.spawnChild(root.id, { name: "api", brief: "wait for instructions", waitsOn: [schema.id] });
		await settled(h, schema.id);
		await h.prompt(root.id, sendTool("children", "status please"));
		await eventually(async () => (await assistantTexts(h, schema.id)).includes("status please"), "the broadcast to reach the child that has started");
		expect(h.isRunning(api.id)).toBe(false);
		expect(h.traffic({ node: api.id })).toHaveLength(0);

		await settled(h, root.id);
		await h.prompt(root.id, sendTool(api.id, "go ahead without it"));
		await eventually(() => h.node(api.id)?.waitsOn === undefined && h.isRunning(api.id), "the message to start it");
		await eventually(async () => (await userMessages(h, api.id)).includes("go ahead without it"), "the message to arrive");
		const told = await userMessages(h, api.id);
		// The brief comes first, then the message that started it.
		expect(told).toContain("Brief:\nwait for instructions");
		expect(told.indexOf("Brief:")).toBeLessThan(told.indexOf("go ahead without it"));
		// What it waited on has not finished, so it is not told that it has.
		expect(told).not.toContain("kept from starting");
	});

	it("cannot be opened before it starts, and a person can start it without waiting", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const schema = await h.spawnChild(root.id, { name: "schema", brief: "wait for instructions" });
		const api = await h.spawnChild(root.id, { name: "api", brief: "wait for instructions", waitsOn: [schema.id] });
		await expect(h.attachForeground(api.id, "terminal")).rejects.toThrow(/"api" has not started: it waits on "schema"/);
		await h.startHeld(api.id);
		expect(h.node(api.id)?.waitsOn).toBeUndefined();
		expect(h.isRunning(api.id)).toBe(true);
		await expect(h.startHeld(api.id)).rejects.toThrow(/not waiting on anything/);
	});

	it("tells the parent what is still waiting on a child that stopped without a result", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const doomed = await h.spawnChild(root.id, { name: "doomed", brief: "wait for instructions" });
		const api = await h.spawnChild(root.id, { name: "api", brief: "wait for instructions", waitsOn: [doomed.id] });
		await settled(h, doomed.id);
		await h.prompt(doomed.id, '!tool bash {"command":"kill -9 $PPID"}').catch(() => {});
		await eventually(async () => (await userMessages(h, root.id)).includes(`Still waiting on it before they start: "api" (${api.id}).`), "the parent to be told what is held up");
		expect(h.node(api.id)?.waitsOn).toEqual([doomed.id]);
	});

	it("makes a waiting child's worktree when it starts, from what is checked out by then", async () => {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: sandbox.work, encoding: "utf8" });
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(sandbox.work, "README.md"), "hello\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const schema = await h.spawnChild(root.id, { name: "schema", brief: "wait for instructions" });
		const api = await h.spawnChild(root.id, { name: "api", brief: "wait for instructions", workspace: "worktree", waitsOn: [schema.id] });
		expect(api).toMatchObject({ workspace: "worktree", branch: null, cwd: root.cwd });

		// The work it waits on lands in the meantime.
		writeFileSync(join(sandbox.work, "schema.sql"), "create table t (id integer);\n");
		git("add", ".");
		git("commit", "-q", "-m", "schema");
		await settled(h, schema.id);
		await h.prompt(schema.id, result("schema done"));
		const started = await eventually(() => {
			const node = h.node(api.id);
			return node?.branch && !node.waitsOn ? node : undefined;
		}, "the waiting child to get its worktree and start");
		expect(started.branch).toMatch(/^lattice\/api-/);
		expect(existsSync(join(started.cwd, "schema.sql"))).toBe(true);
	});
});

describe("planned work", () => {
	const userMessages = async (h: LatticeHost, id: string): Promise<string> => {
		const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(id, { type: "get_messages" });
		return messages.filter((m) => m.role !== "assistant").map((m) => (typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join(""))).join("\n");
	};
	const result = (text: string) => `!tool send_message ${JSON.stringify({ to: "parent", text, intent: "result" })}`;
	const planTool = (args: Record<string, unknown>) => `!tool plan_item ${JSON.stringify(args)}`;

	it("puts an item in the tree with nobody on it, and starts it only when someone does", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const story = await h.spawnChild(root.id, { name: "cards", kind: "story", brief: result("cards done"), planned: true });
		expect(story).toMatchObject({ status: "dormant", planned: true, sessionFile: null, kind: "story" });
		expect(formatTree(h.nodes())).toContain(`cards  [story]  ${story.id}  dormant  roles=protocol+reporting+worker  planned`);
		await settled(h, root.id);
		expect(h.isRunning(story.id)).toBe(false);
		// It cannot be opened: there is nothing in it yet.
		await expect(h.attachForeground(story.id, "t1")).rejects.toThrow("is planned and nobody is on it yet");

		await h.startHeld(story.id);
		await eventually(() => h.node(story.id)?.done === true, "the item to run and report once started");
		expect(h.node(story.id)?.planned).toBeUndefined();
		await eventually(async () => (await assistantTexts(h, root.id)).includes("cards done"), "its result to reach the root");
	});

	it("lays out items under items, and sends a report past the ones nobody is on", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const feature = await h.spawnChild(root.id, { name: "payments", kind: "feature", brief: "take payments", planned: true });
		const story = await h.spawnChild(root.id, { name: "cards", kind: "story", brief: "save cards", planned: true, under: "payments" });
		expect(story.parentId).toBe(feature.id);
		// A task that starts at once, two planned items down from the session that made it.
		const task = await h.spawnChild(root.id, { name: "vault", kind: "task", brief: result("vault done"), under: story.id });
		expect(task.parentId).toBe(story.id);
		await eventually(() => h.node(task.id)?.done === true, "the task to report");
		await eventually(async () => (await assistantTexts(h, root.id)).includes("vault done"), "the report to reach the session above the planned items");
		expect(await userMessages(h, task.id)).toContain('"root"');
		// Nobody was put on the items in between by the report passing them.
		expect(h.node(story.id)).toMatchObject({ planned: true, status: "dormant" });
		expect(h.node(feature.id)).toMatchObject({ planned: true, status: "dormant" });
		expect(h.isRunning(story.id)).toBe(false);
	});

	it("says what a session last worked on, and who just wrote to whom", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		expect(h.uiState().focus).toBeUndefined();
		const story = await h.spawnChild(root.id, { name: "cards", kind: "story", brief: "save cards", planned: true });
		// Placing an item is working on it.
		expect(h.uiState().focus?.[root.id]?.nodeId).toBe(story.id);
		const task = await h.spawnChild(root.id, { name: "vault", kind: "task", brief: result("vault done"), under: story.id });
		await eventually(() => h.node(task.id)?.done === true, "the task to report");
		const state = h.uiState();
		// Hearing from an item below moves the focus there. The task, writing upward, is still on itself.
		expect(state.focus?.[root.id]?.nodeId).toBe(task.id);
		expect(state.focus?.[task.id]).toBeUndefined();
		expect(state.traffic).toContainEqual(expect.objectContaining({ from: task.id, to: root.id, intent: "result" }));
		expect(JSON.stringify(state.traffic)).not.toContain("vault done");
	});

	it("only puts an item under something below the session asking", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		const kid = await h.spawnChild(root.id, { name: "kid", brief: "wait for instructions" });
		await h.spawnChild(root.id, { name: "other", brief: "x", planned: true });
		await expect(h.spawnChild(kid.id, { name: "task", brief: "x", planned: true, under: "other" })).rejects.toThrow('there is no item "other" below this session');
		await expect(h.spawnChild(kid.id, { name: "task", brief: "x", planned: true, under: root.id })).rejects.toThrow("below this session");
	});

	it("does not count planned items as sessions, and still bounds them", async () => {
		const h = await startHost({ limits: { maxNodes: 2, maxChildren: 50 } });
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		for (let i = 0; i < 5; i++) await h.spawnChild(root.id, { name: `item-${i}`, brief: "x", planned: true });
		expect(h.nodes().filter((node) => node.planned)).toHaveLength(5);
		await h.spawnChild(root.id, { name: "real", brief: "wait for instructions" });
		// The tree now runs as many sessions as it may: a planned item cannot be started.
		await expect(h.startHeld(h.nodes().find((node) => node.name === "item-0")?.id ?? "")).rejects.toThrow("the tree already has 2 sessions, the limit");
		for (let i = 5; i < 20; i++) await h.spawnChild(root.id, { name: `item-${i}`, brief: "x", planned: true });
		await expect(h.spawnChild(root.id, { name: "one-too-many", brief: "x", planned: true })).rejects.toThrow("already has 20 planned items");
	});

	it("lets a model plan work and then start an item by writing to it", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, planTool({ name: "cards", kind: "story", brief: result("cards done") }));
		const story = await child(h, root.id, "cards");
		await eventually(async () => (await assistantTexts(h, root.id)).includes(`Planned "cards" as ${story.id} (kind story) under "root". Nobody is on it and nothing has started.`), "the tool to say it is planned");
		await settled(h, root.id);
		await h.prompt(root.id, planTool({ name: "vault", kind: "task", brief: "store the card", under: "cards" }));
		expect((await child(h, story.id, "vault")).planned).toBe(true);
		expect(h.isRunning(story.id)).toBe(false);

		await settled(h, root.id);
		await h.prompt(root.id, sendTool(story.id, "go ahead"));
		await eventually(() => h.node(story.id)?.done === true, "the item to start on a message and report");
		await eventually(async () => (await userMessages(h, story.id)).includes("go ahead"), "the message that started it to follow its brief");
	});
});

describe("host workspaces", () => {
	it("gives a worktree child its own branch and directory", async () => {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: sandbox.work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(sandbox.work, "README.md"), "hi\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");

		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "impl", workspace: "worktree", brief: "wait" }));
		const kid = await child(h, root.id, "impl");
		expect(kid.workspace).toBe("worktree");
		expect(kid.branch).toMatch(/^lattice\/impl-[0-9a-z]{6}$/);
		expect(kid.cwd).toContain(join(".lattice", "worktrees", kid.id));
		expect(existsSync(join(kid.cwd, "README.md"))).toBe(true);
		await eventually(async () => (await assistantTexts(h, root.id)).includes(`branch ${kid.branch}`), "spawn result naming the branch");
	});

	it("tells the model when a worktree is impossible, and creates nothing", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "impl", workspace: "worktree", brief: "wait" }));
		await eventually(async () => (await assistantTexts(h, root.id)).includes("needs a git repository"), "worktree error");
		expect(h.nodes()).toHaveLength(1);
	});
});

describe("keeping the tree tidy", () => {
	it("renames a session", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		expect(h.rename(root.id, "  checkout   flow ").name).toBe("checkout flow");
		expect(() => h.rename(root.id, " ")).toThrow("needs a name");
	});

	it("archives a session with everything under it, stops them, and brings them back", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "a", brief: spawnTool({ name: "b", brief: "wait" }) }));
		const a = await child(h, root.id, "a");
		const b = await child(h, a.id, "b");
		await settled(h, b.id);

		expect(await h.archive(a.id, true)).toBe(2);
		expect(h.uiState().nodes.map((node) => node.name)).toEqual(["root"]);
		await eventually(() => !h.isRunning(a.id) && !h.isRunning(b.id), "the archived sessions to stop");
		expect(h.node(b.id)).toMatchObject({ archived: true, status: "dormant" });

		expect(await h.archive(a.id, false)).toBe(2);
		expect(h.uiState().nodes.map((node) => node.name)).toEqual(["root", "a", "b"]);
	});

	it("reports what a background session last did, and keeps its conversation's end readable when it sleeps", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, "hello there");
		await settled(h, root.id);
		await eventually(() => h.uiState().activity?.[root.id]?.text.includes("hello there"), "the activity line");
		expect(await h.tail(root.id)).toEqual([expect.stringContaining("hello there")]);
		await h.sleep(root.id);
		await eventually(() => !h.isRunning(root.id), "the session to stop");
		expect(await h.tail(root.id)).toEqual(["> hello there", expect.stringContaining("hello there")]);
		expect(h.isRunning(root.id)).toBe(false);
	});

	it("refuses to interrupt a session that is not working", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await expect(h.interrupt(root.id)).rejects.toThrow("is not working");
	});

	it("starts sessions with the tree's settings, read at each start", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		writeFileSync(join(h.stateDir, "config.json"), JSON.stringify({ approval: "always" }));
		expect(h.settings().values.approval).toBe("always");
		expect(h.settings().sources.approval).toBe("repo");
		await h.prompt(root.id, spawnTool({ name: "kid", brief: sendTool("parent", "hi") }));
		// The parent was started before the setting; a restart picks it up, and the child's report then waits.
		await child(h, root.id, "kid");
		writeFileSync(join(h.stateDir, "config.json"), "{ not json");
		expect(h.settings().sources.approval).toBe("default");
	});

	it("takes the person's own settings for every repository, and the repository's over them", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		writeFileSync(join(sandbox.home, "config.json"), JSON.stringify({ reports: { remind: false }, limits: { maxChildren: 1, maxDepth: 1 } }));
		expect(h.limits.maxChildren).toBe(1);
		await h.spawnChild(root.id, { name: "one", brief: "x" });
		await expect(h.spawnChild(root.id, { name: "two", brief: "x" })).rejects.toThrow("already has 1 children");
		// The repository's file wins, and a raised limit holds from the next request on.
		writeFileSync(join(h.stateDir, "config.json"), JSON.stringify({ limits: { maxChildren: 2 } }));
		expect(h.settings().sources["limits.maxChildren"]).toBe("repo");
		expect(h.settings().sources["limits.maxDepth"]).toBe("user");
		await h.spawnChild(root.id, { name: "two", brief: "x" });
	});

	it("is not kept awake by a terminal that only watches from another repository", async () => {
		const h = await startHost();
		const { connectHost } = await import("../../packages/pane/src/index.ts");
		const client = await eventually(() => connectHost(h.stateDir), "a terminal connection");
		try {
			await client.ui("state", {});
			expect(h.activity().terminals).toBe(1);
			await client.ui("presence", { here: false });
			expect(h.activity().terminals).toBe(0);
			await client.ui("presence", { here: true });
			expect(h.activity().terminals).toBe(1);
		} finally {
			client.close();
		}
	});
});

describe("graph without a host", () => {
	it("says clearly that nothing was spawned", async () => {
		const { startPi, extensionPaths } = await import("../support/harness.ts");
		const pi = await startPi(sandbox, { name: "solo", extensions: [extensionPaths.graph] });
		try {
			await pi.prompt(spawnTool({ name: "kid", brief: "x" }));
			expect(await pi.waitForAssistant("tool-result-error")).toContain("No lattice host is reachable, so nothing was done");
		} finally {
			await pi.stop();
		}
	});
});
