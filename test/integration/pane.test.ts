import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { childrenOf, type HostClient, type UiState } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectHost } from "../../packages/pane/src/index.ts";
import { createSandbox, directorScript, eventually, extensionPaths, type PiChild, piCli, type Sandbox, startPi } from "../support/harness.ts";

let sandbox: Sandbox;
let stateDir: string;
let terminals: PiChild[];
let observer: HostClient | undefined;

beforeEach(() => {
	sandbox = createSandbox();
	stateDir = join(sandbox.root, "state");
	terminals = [];
});
afterEach(async () => {
	await Promise.all(terminals.map((terminal) => terminal.stop().catch(() => {})));
	observer?.close();
	observer = undefined;
	// Make sure the background host is gone even if a test failed half way.
	try {
		const { pid } = JSON.parse(readFileSync(join(stateDir, "host.json"), "utf8")) as { pid: number };
		process.kill(pid, "SIGTERM");
		await eventually(() => !existsSync(join(stateDir, "host.json")), "the host to stop", 10_000);
	} catch {
		// Already stopped.
	}
	sandbox.cleanup();
});

const fauxArgs = ["-e", extensionPaths.faux, "--provider", "lattice-faux", "--model", "scripted", "--no-skills", "--no-context-files"];
const BUNDLE = [extensionPaths.launcher, extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph];
/** A person's own Pi with the lattice extensions loaded, in whatever order is given. */
const terminal = async (args: string[] = [], extensions: string[] = BUNDLE) => {
	const pi = await startPi(sandbox, {
		name: "terminal",
		extensions,
		args,
		env: {
			LATTICE_STATE_DIR: stateDir,
			// The host this terminal starts must run its headless sessions against the scripted model too.
			LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
			LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
			LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
			LATTICE_FAUX_SCRIPT: directorScript,
		},
	});
	terminals.push(pi);
	return pi;
};
const state = async (): Promise<UiState> => {
	observer ??= await eventually(() => connectHost(stateDir), "the background host", 20_000);
	return observer.ui("state", {});
};
const until = <T>(probe: (s: UiState) => T | undefined | false, what: string) => eventually(async () => probe(await state()), what, 20_000);
const sessionFile = async (pi: PiChild) => (await pi.client.getState()).sessionFile as string;
const messages = async (pi: PiChild) => JSON.stringify(await pi.client.getMessages());
const sendTool = (to: string, text: string) => `!tool send_message ${JSON.stringify({ to, text })}`;
const spawnTool = (args: Record<string, unknown>) => `!tool spawn_session ${JSON.stringify(args)}`;

describe("the tree inside Pi", () => {
	it("does nothing until asked: a plain session stays a plain session", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		await pi.waitForAssistant("echo[user] roles=[] hello");
		expect(existsSync(join(stateDir, "host.json"))).toBe(false);
		await pi.command("/lattice status");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("No session tree here yet")), "the hint");
	});

	it("turns the open session into a tree, runs children in the background, and opens any of them here", async () => {
		const pi = await terminal();
		await pi.prompt("remember the word saffron");
		const rootFile = await sessionFile(pi);

		// /lattice starts the host in the background and makes this session the root.
		await pi.command("/lattice");
		const root = await until((s) => s.nodes.length === 1 && s.nodes[0]?.status === "idle" && s.nodes[0], "this session to become the root");
		expect(root).toMatchObject({ owner: "tester", sessionFile: rootFile, parentId: null });
		expect(root.repo).toBeTruthy();
		expect((await state()).foreground).toEqual([root.id]);

		// The agent here spawns a child. It runs headless and reports back to this terminal's session.
		await pi.prompt(spawnTool({ name: "payments", fragments: ["worker"], brief: sendTool("parent", "payments done") }));
		await pi.waitForAssistant("payments done");
		const child = await until((s) => childrenOf(s.nodes, root.id)[0], "the child");
		await until((s) => s.nodes.find((n) => n.id === child.id)?.status === "idle", "the child to settle");
		expect((await state()).foreground).toEqual([root.id]);

		// Open the child here. The host stops its headless copy and this Pi takes over its session.
		await pi.command(`/lattice open ${child.id}`);
		await eventually(async () => (await sessionFile(pi)) !== rootFile, "this terminal to switch sessions");
		const opened = await until((s) => s.foreground.includes(child.id) && s.nodes.find((n) => n.id === child.id), "the child to be open here");
		expect(await sessionFile(pi)).toBe(opened.sessionFile);
		expect(await messages(pi)).toContain("payments done"); // its own history: the brief it ran
		await until((s) => s.nodes.find((n) => n.id === root.id)?.status === "dormant", "the root to be handed back");

		// Type into the child. It answers with its own roles, and can still reach its parent.
		await pi.prompt("who are you?");
		await pi.waitForAssistant("echo[user] roles=[lattice-role-worker] who are you?");
		await pi.prompt(sendTool("parent", "sent while open in the terminal"));

		// The root is not open anywhere, so the host wakes it headless to receive the message.
		await until((s) => s.nodes.find((n) => n.id === root.id)?.status === "idle", "the root to wake for its mail");

		// Open the root again: taken back from the host, with everything that happened meanwhile.
		await pi.command(`/lattice open ${root.id}`);
		await eventually(async () => (await sessionFile(pi)) === rootFile, "this terminal to return to the root");
		const history = await messages(pi);
		expect(history).toContain("saffron");
		expect(history).toContain("sent while open in the terminal");
		await until((s) => s.foreground.length === 1 && s.foreground[0] === root.id, "only the root to be open here");

		// Quitting Pi hands the session back and leaves the tree running.
		await pi.stop();
		await until((s) => s.foreground.length === 0, "the terminal's session to be handed back");
		expect((await state()).nodes).toHaveLength(2);
	}, 120_000);

	it("switches away from a session in the middle of a turn, and the work carries on in the background", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		const rootFile = await sessionFile(pi);
		await pi.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");
		await pi.prompt(spawnTool({ name: "kid", brief: "wait" }));
		const kid = await until((s) => childrenOf(s.nodes, root.id)[0], "the child");
		await until((s) => s.nodes.find((n) => n.id === kid.id)?.status === "idle", "the child to settle");

		// Start a long step here, and switch away while it is running.
		await pi.client.prompt('!tool bash {"command":"sleep 30"}');
		await pi.waitFor(() => pi.events.some((e) => e.type === "tool_execution_start" && e.toolName === "bash"), "the long step to start");
		const started = Date.now();
		await pi.client.prompt(`/lattice open ${kid.id}`, undefined, "steer");
		await eventually(async () => (await sessionFile(pi)) !== rootFile, "this terminal to switch without waiting for the turn");
		expect(Date.now() - started).toBeLessThan(15_000); // far less than the 30 second step

		// The session left behind is running in the background, told to carry on.
		await until((s) => !s.foreground.includes(root.id) && s.foreground.includes(kid.id), "the child to be open here");
		await until((s) => s.nodes.find((n) => n.id === root.id)?.status === "idle", "the root to carry on and settle in the background");

		// And this terminal is immediately usable in the session it switched to.
		await pi.prompt("are you there?");
		await pi.waitForAssistant("are you there?");

		await pi.command(`/lattice open ${root.id}`);
		await eventually(async () => (await sessionFile(pi)) === rootFile, "this terminal to return to the root");
		expect(await messages(pi)).toContain("moved between the background and a terminal");
	}, 120_000);

	it("opens a session that is working in the background, and it carries on here", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		await pi.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");
		await pi.prompt(spawnTool({ name: "kid", brief: "wait" }));
		const kid = await until((s) => childrenOf(s.nodes, root.id)[0], "the child");
		await until((s) => s.nodes.find((n) => n.id === kid.id)?.status === "idle", "the child to settle");

		// Give the child a long step, in the background.
		await pi.prompt(sendTool(kid.id, "!sleep 30"));
		await until((s) => s.nodes.find((n) => n.id === kid.id)?.status === "running", "the child to be working");

		await pi.command(`/lattice open ${kid.id}`);
		await until((s) => s.foreground.includes(kid.id), "the child to be open here");
		// It was stopped in the background and told to carry on in this terminal.
		await pi.waitForAssistant("moved between the background and a terminal", 20_000);
	}, 120_000);

	it("shows the project's sessions as soon as Pi opens, and a new session joins with its first message", async () => {
		const first = await terminal();
		await first.prompt("hello");
		await first.command("/lattice");
		await until((s) => s.nodes[0]?.status === "idle", "the first session to be in the tree");
		await first.stop();
		// Nothing is running any more: stop the background host too.
		await observer?.ui("shutdown", {});
		observer?.close();
		observer = undefined;
		await eventually(() => !existsSync(join(stateDir, "host.json")), "the host to stop");

		// Open Pi again, on a brand-new session, and type nothing.
		const second = await terminal();
		const seen = await until((s) => s.nodes.length === 1 && s, "the host to be started and the tree fetched, with nothing typed");
		expect(seen.foreground).toEqual([]); // the new session is not in the tree yet

		// Its first message makes it a session of the tree, named after what was asked.
		await second.prompt("plan the cart redesign");
		const joined = await until((s) => s.nodes.length === 2 && s.nodes.find((n) => n.name === "plan the cart redesign"), "the new session to join the tree");
		expect(joined).toMatchObject({ parentId: null, owner: "tester", sessionFile: await sessionFile(second) });
		await until((s) => s.foreground.includes(joined.id), "the new session to be open here");
		// And it is a full member: it can create children.
		await second.prompt(spawnTool({ name: "kid", brief: "wait" }));
		await until((s) => childrenOf(s.nodes, joined.id).length === 1, "the joined session to spawn a child");
	}, 120_000);

	it("does not depend on the order the extensions load in", async () => {
		// The reverse of the bundle's order: messaging and tree tools start before the pane knows the node.
		const pi = await terminal([], [...BUNDLE].reverse());
		await pi.prompt("hello");
		await pi.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");
		await pi.prompt(spawnTool({ name: "kid", fragments: ["worker"], brief: sendTool("parent", "reported in any order") }));
		await pi.waitForAssistant("reported in any order");
		const kid = await until((s) => childrenOf(s.nodes, root.id)[0], "the child");
		await until((s) => s.nodes.find((n) => n.id === kid.id)?.status === "idle", "the child to settle");

		await pi.command(`/lattice open ${kid.id}`);
		await until((s) => s.foreground.includes(kid.id), "the child to be open here");
		await pi.prompt("which roles?");
		await pi.waitForAssistant("echo[user] roles=[lattice-role-worker] which roles?");
		await pi.prompt(sendTool("parent", "still connected"));
		await until((s) => s.nodes.find((n) => n.id === root.id)?.status === "idle", "the root to wake for its mail");
	}, 120_000);

	it("says what is missing when nothing can start a host", async () => {
		const pi = await terminal([], [extensionPaths.pane, extensionPaths.a2a]); // no launcher
		await pi.prompt("hello");
		await pi.command("/lattice");
		const note = await pi.waitFor(() => pi.notifications().find((text) => text.includes("Nothing here can start a lattice host")), "the explanation");
		expect(note).toContain("pi-lattice daemon");
		expect(existsSync(join(stateDir, "host.json"))).toBe(false);
		// The session is untouched and still works on its own.
		await pi.prompt("still fine");
		await pi.waitForAssistant("echo[user] roles=[] still fine");
	});

	it("works with a host someone started by hand, with no launcher installed", async () => {
		const { runDaemon } = await import("../../packages/app/src/index.ts");
		const daemon = await runDaemon({
			stateDir, cwd: sandbox.work, owner: "tester", idleExitMs: 0,
			hostOptions: {
				piCommand: [process.execPath, piCli], piArgs: fauxArgs, extensionPaths: [extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
				socketDir: join(sandbox.root, "sock"),
				env: { PI_CODING_AGENT_DIR: sandbox.agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", LATTICE_FAUX_SCRIPT: directorScript },
			},
		});
		try {
			const pi = await terminal([], [extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]);
			await pi.prompt("hello");
			await pi.command("/lattice");
			const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root, on the hand-started host").catch(async (error: Error) => {
				throw new Error(`${error.message}\nstate: ${JSON.stringify(await state())}\nnotes: ${JSON.stringify(pi.notifications())}`);
			});
			expect(daemon.host.node(root.id)?.owner).toBe("tester");
			await pi.stop();
		} finally {
			observer?.close();
			observer = undefined;
			await daemon.stop();
		}
	}, 120_000);

	it("rejoins the tree when Pi is started again on a session that belongs to it", async () => {
		const first = await terminal();
		await first.prompt("hello");
		const file = await sessionFile(first);
		await first.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");
		await first.stop();
		await until((s) => s.foreground.length === 0, "the session to be handed back");

		const again = await terminal(["--session", file]);
		await until((s) => s.foreground.includes(root.id) && s.nodes[0]?.status === "idle", "the resumed session to be open here again");
		await again.prompt(spawnTool({ name: "kid", brief: "wait" }));
		await until((s) => s.nodes.length === 2, "the resumed root to be able to spawn");
	}, 120_000);

	it("renames, archives and restores sessions from /lattice", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		await pi.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");
		await pi.prompt(spawnTool({ name: "payments", brief: spawnTool({ name: "refunds", brief: "wait" }) }));
		const child = await until((s) => childrenOf(s.nodes, root.id)[0], "the child");
		await until((s) => s.nodes.length === 3 && s.nodes.every((n) => n.status === "idle"), "the tree to settle");

		await pi.command(`/lattice rename ${child.id} card payments`);
		await until((s) => s.nodes.find((n) => n.id === child.id)?.name === "card payments", "the new name");

		// Archiving takes what is under it too, and stops their processes; nothing is deleted.
		await pi.command(`/lattice archive ${child.id}`);
		await until((s) => s.nodes.length === 1, "the branch to leave the tree");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes('Archived "card payments" and 1 under it')), "the archive notice");
		expect((await observer?.ui("archived", {}))?.nodes.map((n) => n.name).sort()).toEqual(["card payments", "refunds"]);

		// The session open here cannot be archived from under the person.
		await pi.command(`/lattice archive ${root.id}`);
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("is open in this terminal")), "the refusal");

		await pi.command("/lattice restore card payments");
		await until((s) => s.nodes.length === 3, "the branch to come back");
	}, 120_000);

	it("keeps the tree's settings in a file, applies them at restart, and says what is wrong with a bad one", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		await pi.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");

		await pi.command("/lattice config thinking loud");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("thinking takes off | minimal")), "the complaint");
		expect(existsSync(join(stateDir, "config.json"))).toBe(false);

		await pi.command("/lattice config approval always");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("approval set to always")), "the confirmation");
		expect(JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"))).toEqual({ approval: "always" });
		// A setting of the person's own goes in their file, which every repository uses; this repository's still wins.
		await pi.command("/lattice config user approval never");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("This repository sets its own")), "the note that the repository wins");
		await pi.command("/lattice config user limits.maxDepth 6");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("limits.maxDepth set to 6")), "the limit set");
		expect(JSON.parse(readFileSync(join(sandbox.home, "config.json"), "utf8"))).toEqual({ approval: "never", limits: { maxDepth: 6 } });
		await pi.command("/lattice config");
		await pi.waitFor(() => pi.notifications().find((text) => /approval\s+always\s+\(this repository\)/.test(text) && /model\s+not set/.test(text) && /limits\.maxDepth\s+6\s+\(yours\)/.test(text)), "the settings listed with where each is from");

		// With approval always, a child's report waits for the person instead of reaching the agent.
		await pi.prompt(spawnTool({ name: "kid", brief: sendTool("parent", "report from the kid") }));
		await until((s) => (s.attention[root.id]?.pending ?? 0) === 1, "the report to wait for approval");

		// A restart gives a new host; this terminal still has its session, and the tree is as it was.
		const before = JSON.parse(readFileSync(join(stateDir, "host.json"), "utf8")).pid as number;
		observer?.close();
		observer = undefined;
		await pi.command("/lattice restart");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("The host was restarted")), "the restart notice", 40_000);
		expect(JSON.parse(readFileSync(join(stateDir, "host.json"), "utf8")).pid).not.toBe(before);
		await until((s) => s.foreground.includes(root.id) && s.nodes.length === 2, "the session to be open here again");
	}, 120_000);

	it("checks itself, lists its commands, and answers for the other lattice commands", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		await pi.command("/lattice");
		await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");

		await pi.command("/lattice doctor");
		const report = await pi.waitFor(() => pi.notifications().find((text) => text.includes("Host running as tester")), "the report");
		expect(report).toContain("✓ Tree: ");
		expect(report).toContain("✓ Settings: defaults");
		expect(report).toContain("in the tree");
		expect(report).toMatch(/✓ Roles: \d+ available/);

		await pi.command("/lattice help");
		const help = await pi.waitFor(() => pi.notifications().find((text) => text.includes("rename <session> [name]")), "the command list");
		expect(help).toContain("doctor");

		const seen = pi.notifications().length;
		await pi.command("/lattice peers");
		await pi.waitFor(() => pi.notifications().length > seen, "the forwarded command to answer");
	}, 120_000);

	it("creates a child through Pi's own dialogs", async () => {
		const pi = await terminal();
		await pi.prompt("hello");
		await pi.command("/lattice");
		const root = await until((s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");

		const flow = pi.command("/lattice new");
		const answers: Array<[RegExp, Record<string, unknown>]> = [
			[/New session under/, { value: "grilling" }],
			[/Kind/, { value: "grilling" }],
			[/Roles/, { value: "worker grilling" }],
			[/Where should it work/, { value: "shared: this directory" }],
			[/Model/, { value: "" }],
			[/Brief/, { value: "find the gaps in the checkout story" }],
		];
		let seen = 0;
		for (const [title, answer] of answers) {
			const dialog = await pi.waitFor(() => pi.events.filter((e) => e.type === "extension_ui_request" && typeof e.title === "string" && e.method !== "notify")[seen], `the "${title.source}" dialog`);
			expect(String(dialog.title)).toMatch(title);
			pi.answer(dialog.id, answer);
			seen++;
		}
		await flow;
		const child = await until((s) => childrenOf(s.nodes, root.id)[0], "the child created from the dialogs");
		expect(child).toMatchObject({ name: "grilling", kind: "grilling", fragments: ["worker", "grilling"], workspace: "shared", brief: "find the gaps in the checkout story" });
	}, 120_000);
});
