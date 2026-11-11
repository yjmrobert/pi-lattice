import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
		expect(kid).toMatchObject({ kind: "task", fragments: ["worker"], rootId: root.id, workspace: "shared", cwd: root.cwd });

		// The child ran its brief and reported to "parent"; the coordinator's model saw it.
		await eventually(async () => (await assistantTexts(h, root.id)).includes("payments done"), "report to reach the coordinator");
		const seen = await assistantTexts(h, root.id);
		expect(seen).toContain(`from="${kid.id}"`);
		expect(seen).toContain(`Spawned "payments" as ${kid.id}`);

		await settled(h, kid.id);
		expect(formatTree(h.nodes())).toBe(
			[`checkout  [feature]  ${root.id}  idle  roles=coordinator`, `└─ payments  [task]  ${kid.id}  idle  roles=worker`].join("\n"),
		);
		// Both sessions carry the roles they were given.
		expect(await assistantTexts(h, kid.id)).toContain("tool-result: Sent");
	});

	it("journals routed envelopes with the resolved recipient", async () => {
		const h = await startHost();
		const root = await h.createRoot({ name: "root", cwd: sandbox.work });
		await h.prompt(root.id, spawnTool({ name: "kid", brief: sendTool("parent", "hello up") }));
		const kid = await child(h, root.id, "kid");
		const record = await eventually(() => h.traffic().find((r) => r.envelope.payload.text === "hello up" && r.mailState === "delivered"), "delivered journal record");
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
		expect(text).toContain("roles=[lattice-role-worker]");
		expect(h.node(kid.id)?.sessionFile).toBe(restored[1]?.sessionFile);
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
		writeFileSync(join(sandbox.home, "config.json"), JSON.stringify({ limits: { maxChildren: 1, maxDepth: 1 } }));
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
