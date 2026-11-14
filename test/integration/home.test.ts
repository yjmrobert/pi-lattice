/**
 * The canopy as what Pi opens on (ADR 0031), in the real Pi terminal interface: the tree where
 * the chat was, the chat sliding in beside it, and the keyboard moving between the two.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, eventually, extensionPaths, piCli, type Sandbox } from "../support/harness.ts";
import { canRunTui, KEY, PiTui } from "../support/tui.ts";

let sandbox: Sandbox;
let stateDir: string;
let tui: PiTui | undefined;

beforeEach(() => {
	sandbox = createSandbox();
	stateDir = join(sandbox.root, "state");
});
afterEach(async () => {
	await tui?.stop();
	tui = undefined;
	try {
		const { pid } = JSON.parse(readFileSync(join(stateDir, "host.json"), "utf8")) as { pid: number };
		process.kill(pid, "SIGTERM");
		await eventually(() => !existsSync(join(stateDir, "host.json")), "the host to stop", 10_000);
	} catch {
		// No host was started, or it has stopped.
	}
	sandbox.cleanup();
});

const fauxArgs = ["-e", extensionPaths.faux, "--provider", "lattice-faux", "--model", "scripted", "--no-skills", "--no-context-files"];
const open = (options: { cols?: number; rows?: number } = {}): PiTui => {
	tui = PiTui.start(sandbox, {
		...options,
		extensions: [extensionPaths.launcher, extensionPaths.pane, extensionPaths.canopy, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
		env: {
			LATTICE_STATE_DIR: stateDir,
			LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
			LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
			LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
		},
	});
	return tui;
};

/** A terminal with a tree whose first session is the one open in it. */
const withTree = async (options: { cols?: number; rows?: number } = {}): Promise<PiTui> => {
	const pi = open(options);
	await pi.see("[Extensions]");
	await pi.submit("hello");
	await pi.see("echo[user] roles=[] hello");
	await pi.submit("/lattice");
	await pi.see("This session is now part of a lattice tree");
	return pi;
};
/** The tree's part of a row and the chat's, split at the divider between them. */
const split = (row: string): [string, string] => {
	const at = row.indexOf("│");
	return at < 0 ? [row, ""] : [row.slice(0, at), row.slice(at + 1)];
};
const ALT_L_RELEASED = "\x1b[108;3:3u";

describe.skipIf(!canRunTui)("the canopy as what Pi opens on", () => {
	it("draws the tree beside the chat once there is one, and moves the keyboard between them with alt+l", async () => {
		const pi = await withTree({ cols: 160, rows: 40 });
		// The chat was the whole screen; the tree takes the left of it and the chat keeps the keyboard.
		const beside = await pi.see(/alt\+l\s+tree/);
		expect(split(beside[0] as string)[0]).toMatch(/^ ◆ work\s+1 @tester/);
		expect(beside.some((row) => split(row)[0].includes("◉ work"))).toBe(true);
		expect(beside.some((row) => split(row)[1].includes("alt+l moves to the tree"))).toBe(true);
		expect(split(beside.at(-1) as string)[0]).not.toContain("move");

		pi.press(KEY.altL);
		// A terminal that reports releases says the key was let go; that is not a second press.
		pi.press(ALT_L_RELEASED);
		const tree = await pi.see("close chat");
		expect(split(tree.at(-1) as string)[0]).toContain("move");
		// The keys are the tree's now: nothing is typed into Pi's editor.
		pi.press("zzz");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await pi.screen()).join("\n")).not.toContain("zzz");

		pi.press(KEY.escape);
		// The chat slides away and the tree has the whole width.
		const alone = await pi.waitFor((screen) => screen.includes("sessions") && !screen.includes("echo[user]"), "the tree alone");
		expect(alone.at(-1)).toMatch(/alt\+l\s+chat/);

		pi.press(KEY.enter);
		// Enter on the session open here brings its chat back, with the keyboard.
		await pi.see("echo[user] roles=[] hello");
		await pi.submit("again");
		const answered = await pi.see(/echo\[user\] roles=\[.*\] again/);
		expect(answered.some((row) => split(row)[0].includes("◉ work"))).toBe(true);
	}, 90_000);

	it("opens a background session's chat beside the tree, and lists the sessions with p", async () => {
		const pi = await withTree({ cols: 160, rows: 40 });
		await pi.see(/alt\+l\s+tree/);
		pi.press(KEY.altL);
		await pi.see("close chat");
		pi.press("p");
		// The pane and what its cursor is on, as before: this is where a session is made, stopped or archived.
		await pi.see(/owner\s+you/);
		pi.press("n");
		await pi.see("New session under work");
		pi.press("payments", KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab);
		await pi.see("what it should do; it sees only this");
		pi.press("say the word heliotrope");
		await pi.see("say the word heliotrope▏");
		pi.press("\x13"); // ctrl+s
		await pi.see(/roles\s+protocol · reporting · worker/);
		pi.press(KEY.escape);

		const tree = await pi.see("close chat");
		expect(tree.some((row) => split(row)[0].includes("payments"))).toBe(true);
		pi.press(KEY.up);
		await pi.see(/work ▸ payments/);
		pi.press(KEY.enter);
		// The terminal moves to that session, in the chat beside the tree.
		const opened = await pi.see("heliotrope");
		expect(opened.some((row) => split(row)[1].includes("heliotrope"))).toBe(true);
		expect(split(opened[0] as string)[0]).toMatch(/^ ◆ work/);
	}, 120_000);

	it("opens on the tree when there already is one, and in a narrow terminal gives an open chat the whole width", async () => {
		const first = await withTree({ cols: 160, rows: 40 });
		await first.see(/alt\+l\s+tree/);
		await first.stop();

		const pi = open({ cols: 100, rows: 30 });
		const tree = await pi.see("next that needs someone");
		expect(tree[0]).toMatch(/^ ◆ work/);
		expect(tree.join("\n")).not.toContain("[Extensions]");
		// Nothing of the chat is drawn: the canopy has every column, with its own panel on the right.
		expect(tree.join("\n")).toContain("SITTING HERE");
		expect(tree.at(-1)).toMatch(/alt\+l\s+chat/);

		pi.press(KEY.altL);
		const chat = await pi.see("[Extensions]");
		expect(chat.join("\n")).not.toContain("next that needs someone");
		await pi.submit("hello");
		await pi.see(/echo\[user\] roles=\[.*\] hello/);
		pi.press(KEY.altL);
		await pi.see("next that needs someone");
	}, 90_000);
});
