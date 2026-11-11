/**
 * The pane in the real Pi terminal interface. Everything else tests the pane's parts as pure
 * functions or through RPC mode, where there is no terminal; these run Pi in a pseudo-terminal
 * and read the screen, so the layout hook, the keyboard and the fallbacks are covered too.
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
		extensions: [extensionPaths.launcher, extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
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
/** The pane's part of a row and Pi's, split at the divider. */
const split = (row: string): [pane: string, rest: string] => {
	const at = row.indexOf("│");
	return at < 0 ? [row, ""] : [row.slice(0, at), row.slice(at + 1)];
};

describe.skipIf(!canRunTui)("the pane in Pi's terminal interface", () => {
	it("sits to the left of Pi from the start, and leaves Pi's own screen working beside it", async () => {
		const pi = open();
		const rows = await pi.see("alt+l sessions");
		// The pane takes its own column on every row; Pi draws to the right of the divider.
		expect(rows.every((row) => row.trim() === "" || row.indexOf("│") === 33 || row.startsWith("─"))).toBe(true);
		expect(split(rows[0] as string)[0]).toContain("No sessions in this");
		expect(rows.some((row) => split(row)[1].includes("[Extensions]"))).toBe(true);

		await pi.submit("hello");
		const answered = await pi.see("echo[user] roles=[] hello");
		// What the agent says lands in Pi's part, never under the pane.
		expect(answered.find((row) => row.includes("echo[user]"))?.indexOf("echo[user]")).toBeGreaterThan(33);
	}, 60_000);

	it("lists the tree, takes the keyboard on alt+l, and gives it back on escape", async () => {
		const pi = await withTree();
		const rows = await pi.see(/▸ ● work\s+session/);
		expect(split(rows[0] as string)[0]).toMatch(/◆ work\s+1 session/);

		pi.press(KEY.altL);
		// With the keyboard, the chat steps aside for the session under the cursor, in full.
		const inspecting = await pi.see(/owner\s+you/);
		expect(inspecting.join("\n")).toMatch(/roles\s+protocol/);
		expect(inspecting.join("\n")).not.toContain("echo[user] roles=[] hello\n");
		expect(inspecting.at(-1)).toContain("↑↓ move  esc close");
		expect(inspecting.at(-1)).toContain(", settings");

		pi.press("?");
		await pi.see("while the pane has the keyboard");
		pi.press(KEY.escape);
		await pi.see(/owner\s+you/);

		pi.press(KEY.escape);
		const back = await pi.see("alt+l sessions");
		expect(back.join("\n")).toContain("This session is now part of a lattice tree");
		// Keys go to Pi again: this is typed into its editor, not taken by the pane.
		await pi.submit("still here?");
		await pi.see("echo[user] roles=[lattice-role-protocol] still here?");
	}, 60_000);

	it("edits settings in place and writes the file the screen names", async () => {
		const pi = await withTree();
		pi.press(KEY.altL);
		await pi.see(/owner\s+you/);
		pi.press(",");
		const settings = await pi.see("changes go to");
		expect(settings.join("\n")).toContain(join(stateDir, "config.json"));
		expect(settings.join("\n")).toMatch(/▸ Model\s+not set\s+default/);
		expect(settings.join("\n")).toMatch(/Remind a child\s+○ off\s+yours/);

		// Thinking is the second row; → steps to its first choice and writes this repository's file.
		pi.press(KEY.down, KEY.right);
		await pi.see(/▸ Thinking\s+off\s+this repository/);
		expect(JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"))).toEqual({ thinking: "off" });

		// A value is typed in place; what is wrong with it is said, and it is not written.
		for (let step = 0; step < 4; step++) pi.press(KEY.down);
		await pi.see(/▸ Child with no roles\s+worker/);
		pi.press(KEY.enter);
		await pi.see("worker▏");
		pi.press(" implementation", KEY.enter);
		await pi.see(/▸ Child with no roles\s+worker implementation\s+this repository/);
		expect(JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"))).toEqual({ thinking: "off", roles: { child: ["worker", "implementation"] } });

		// Tab switches to the person's own file; x clears a value there.
		pi.press(KEY.tab);
		await pi.see(join(sandbox.home, "config.json"));
		pi.press("x");
		await eventually(() => JSON.stringify(JSON.parse(readFileSync(join(sandbox.home, "config.json"), "utf8"))) === JSON.stringify({ reports: { remind: false } }), "nothing to clear in the person's file");

		pi.press(KEY.escape);
		await pi.see(/owner\s+you/);
	}, 60_000);

	it("opens settings from the command, and returns to the chat when they close", async () => {
		const pi = await withTree();
		await pi.submit("/lattice config");
		// Pi completes the command's argument on the first enter; the second one sends it.
		await pi.see("/lattice config");
		pi.press(KEY.enter);
		await pi.see("changes go to");
		pi.press(KEY.escape);
		const back = await pi.see("alt+l sessions");
		expect(back.join("\n")).toContain("This session is now part of a lattice tree");
	}, 60_000);

	it("creates a child from the form, and shows it working in the tree", async () => {
		const pi = await withTree();
		pi.press(KEY.altL);
		await pi.see(/owner\s+you/);
		pi.press("n");
		const form = await pi.see("New session under work");
		expect(form.join("\n")).toMatch(/Roles\s+coordinator/);
		pi.press("payments", KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab);
		await pi.see("what it should do; it sees only this");
		pi.press("say the word heliotrope");
		await pi.see("say the word heliotrope▏");
		pi.press("\x13"); // ctrl+s
		await pi.see(/└ . payments/);
		// The roles it was not given are the ones the settings say every child gets.
		await pi.see(/roles\s+protocol · reporting · worker/);
	}, 60_000);

	it("in a narrow terminal, puts the sessions in two rows above the editor and opens the pane on alt+l", async () => {
		const pi = await withTree({ cols: 80, rows: 30 });
		const rows = await pi.see(/◆ work/);
		// No column is taken from Pi; the sessions are one row of their own.
		expect(rows.find((row) => row.includes("◆ work"))).toMatch(/◆ work\s+▸. work/);
		expect(rows.some((row) => row.indexOf("│") === 33)).toBe(false);

		pi.press(KEY.altL);
		await pi.see(/owner\s+you/);
		pi.press(KEY.escape);
		await pi.see("This session is now part of a lattice tree");
	}, 60_000);
});
