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
/** A person's own Pi, with the lattice bundle loaded the way the package manifest orders it: pane first. */
const terminal = async (args: string[] = []) => {
	const pi = await startPi(sandbox, {
		name: "terminal",
		extensions: [extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
		args,
		env: {
			LATTICE_STATE_DIR: stateDir,
			// The host this terminal starts must run its headless sessions against the scripted model too.
			LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
			LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
			LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
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
