/**
 * The canopy as what Pi opens on (ADR 0031), in the real Pi terminal interface: the tree where
 * the chat was, the chat sliding in beside it, and the keyboard moving between the two.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
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
const open = (options: { cols?: number; rows?: number; env?: Record<string, string> } = {}): PiTui => {
	const { env, ...size } = options;
	tui = PiTui.start(sandbox, {
		...size,
		extensions: [extensionPaths.launcher, extensionPaths.pane, extensionPaths.canopy, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
		env: {
			LATTICE_STATE_DIR: stateDir,
			LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
			LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
			LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
			...env,
		},
	});
	return tui;
};

/** A terminal with a tree whose first session is the one open in it. */
const withTree = async (options: { cols?: number; rows?: number; env?: Record<string, string> } = {}): Promise<PiTui> => {
	const pi = open(options);
	await pi.see("[Extensions]");
	await pi.submit("hello");
	await pi.see("echo[user] roles=[] hello");
	await pi.submit("/lattice");
	await pi.see("This session is now part of a lattice tree");
	return pi;
};
/** The tree's part of a row and the chat's, split at the divider between them. */
/** A session's chat is open over the tree: its box, with the key that closes it on its top edge. */
const OPEN = /╭─.*alt\+l\s+tree/;
/** The tree with nothing over it, and the keyboard. */
const alone = (pi: PiTui): Promise<string[]> => pi.waitFor((screen) => /p\s+sessions/.test(screen) && !screen.includes("╭"), "the tree alone");
const ALT_L_RELEASED = "\x1b[108;3:3u";

describe.skipIf(!canRunTui)("the canopy as what Pi opens on", () => {
	it("opens the session's chat over the tree once there is one, and closes it with alt+l", async () => {
		const pi = await withTree({ cols: 160, rows: 40 });
		// The chat was the whole screen; now it is a box over the tree, titled with whose session it is and what it is doing.
		const over = await pi.see(OPEN);
		expect(over.find((row) => row.includes("╭"))).toMatch(/work\s+@tester \(you\) · \S+.*alt\+l\s+tree/);
		expect(over[0]).toMatch(/^ ◆ work\s+1 @tester/);
		expect(over.some((row) => /│.*alt\+l moves to the tree/.test(row))).toBe(true);

		pi.press(KEY.altL);
		// A terminal that reports releases says the key was let go; that is not a second press.
		pi.press(ALT_L_RELEASED);
		const tree = await alone(pi);
		expect(tree.at(-1)).toMatch(/alt\+l\s+chat.*move/);
		expect(tree.some((row) => row.includes("◉ work"))).toBe(true);
		expect(tree.join("\n")).not.toContain("echo[user]");
		// The keys are the tree's now: nothing is typed into Pi's editor.
		pi.press("zzz");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await pi.screen()).join("\n")).not.toContain("zzz");
		// Escape has nothing to close.
		pi.press(KEY.escape);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await pi.screen()).join("\n")).not.toContain("╭");

		pi.press(KEY.enter);
		// Enter on the session open here opens its chat again, with the keyboard.
		await pi.see("echo[user] roles=[] hello");
		await pi.submit("again");
		const answered = await pi.see(/echo\[user\] roles=\[.*\] again/);
		expect(answered.some((row) => row.includes("╭"))).toBe(true);
		expect(answered[0]).toMatch(/^ ◆ work/);
	}, 90_000);

	it("opens a background session over the tree, and lists the sessions with p", async () => {
		const pi = await withTree({ cols: 160, rows: 40 });
		await pi.see(OPEN);
		pi.press(KEY.altL);
		await alone(pi);
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

		const tree = await alone(pi);
		expect(tree.some((row) => row.includes("payments"))).toBe(true);
		// Folding the session hides what is under it and says how much that is; unfolding brings it back.
		pi.press("f");
		await pi.waitFor((screen) => /◉ work \+1/.test(screen) && screen.includes("UNDER IT (folded)"), "the session folded");
		pi.press("f");
		await pi.waitFor((screen) => !/◉ work \+1/.test(screen) && !screen.includes("UNDER IT (folded)"), "the session unfolded");
		pi.press(KEY.up);
		await pi.see(/work ▸ payments/);
		pi.press(KEY.enter);
		// The terminal moves to that session, in a box over the tree that names it.
		const opened = await pi.see(/│.*heliotrope/);
		expect(opened.find((row) => row.includes("╭"))).toMatch(/payments\s+@tester/);
		expect(opened[0]).toMatch(/^ ◆ work/);
	}, 120_000);

	it("shows a message waiting for approval under the tree, and approves it there with a", async () => {
		const pi = await withTree({ cols: 160, rows: 40, env: { LATTICE_APPROVAL: "always" } });
		await pi.see(OPEN);
		pi.press(KEY.altL);
		await alone(pi);
		pi.press("p");
		await pi.see(/owner\s+you/);
		pi.press("n");
		await pi.see("New session under work");
		pi.press("kid", KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab);
		await pi.see("what it should do; it sees only this");
		pi.press(`!tool send_message ${JSON.stringify({ to: "parent", text: "needs approval" })}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		pi.press("\x13"); // ctrl+s
		await pi.see(/roles\s+protocol · reporting · worker/);
		pi.press(KEY.escape);

		// The session open here is the one selected, and the message is for it: it is drawn in full, with its keys.
		const asked = await pi.waitFor((_screen, rows) => rows.some((row) => row.includes("? kid → work")), "what waits, under the tree", 30_000);
		const tree = asked;
		expect(tree.join("\n")).toContain("needs approval");
		expect(tree.join("\n")).toMatch(/ a {2}approve {4}x {2}reject/);

		pi.press("a");
		// Approved: nothing waits, and the message reaches the session.
		await pi.waitFor((_screen, rows) => !rows.some((row) => row.includes("? kid → work")), "nothing waiting under the tree", 30_000);
		pi.press(KEY.enter);
		await pi.see("delivered to the agent", 30_000);
	}, 120_000);

	it("rejects a waiting message with a typed line instead, which the session reads", async () => {
		const pi = await withTree({ cols: 160, rows: 40, env: { LATTICE_APPROVAL: "always" } });
		await pi.see(OPEN);
		pi.press(KEY.altL);
		await alone(pi);
		pi.press("p");
		await pi.see(/owner\s+you/);
		pi.press("n");
		await pi.see("New session under work");
		pi.press("kid", KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab);
		await pi.see("what it should do; it sees only this");
		pi.press(`!tool send_message ${JSON.stringify({ to: "parent", text: "needs approval" })}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
		pi.press("\x13"); // ctrl+s
		await pi.see(/roles\s+protocol · reporting · worker/);
		pi.press(KEY.escape);

		const asked = await pi.waitFor((_screen, rows) => rows.some((row) => row.includes("? kid → work")), "what waits, under the tree", 30_000);
		expect(asked.join("\n")).toMatch(/ o {2}reject, say why/);
		pi.press("o");
		await pi.see("Reject, and tell work ›");
		// Every key is text while the line is typed: `a` does not approve.
		pi.press("say mangosteen");
		await pi.see("say mangosteen▏");
		pi.press(KEY.enter);
		await pi.waitFor((_screen, rows) => !rows.some((row) => row.includes("? kid → work")), "nothing waiting under the tree", 30_000);
		// The session open here reads the line as its own prompt; the message never reaches it. Its chat stays closed until it is opened.
		pi.press(KEY.enter);
		const told = await pi.see(/echo\[user\].*say mangosteen/, 30_000);
		expect(told.join("\n")).not.toContain("delivered to the agent");
	}, 120_000);

	it("opens on the tree when there already is one, and in a narrow terminal gives an open chat the whole width", async () => {
		const first = await withTree({ cols: 160, rows: 40 });
		await first.see(/alt\+l\s+tree/);
		await first.stop();

		const pi = open({ cols: 100, rows: 30 });
		const tree = await pi.see("say what you want");
		expect(tree[0]).toMatch(/^ ◆ work/);
		expect(tree.join("\n")).not.toContain("[Extensions]");
		// Nothing of the chat is drawn: the canopy has every column, with its own panel on the right.
		expect(tree.join("\n")).toContain("SITTING HERE");
		expect(tree.at(-1)).toMatch(/alt\+l\s+chat/);

		pi.press(KEY.altL);
		const chat = await pi.see("[Extensions]");
		expect(chat.join("\n")).not.toContain("say what you want");
		await pi.submit("hello");
		await pi.see(/echo\[user\] roles=\[.*\] hello/);
		pi.press(KEY.altL);
		await pi.see("say what you want");
	}, 90_000);

	it("opens on an empty canopy in a repository with no tree, and starts the tree with a first message pasted there", async () => {
		// A git repository of its own, with no tree yet: the first message starts one, so Pi opens on the canopy and takes that message (ADR 0035).
		const shop = join(sandbox.root, "shop");
		mkdirSync(shop);
		execFileSync("git", ["init", "-q"], { cwd: shop });
		stateDir = join(realpathSync(shop), ".lattice");
		// No LATTICE_STATE_DIR: the tree is kept in the repository, as it is outside tests.
		const env = { LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]), LATTICE_PI_ARGS: JSON.stringify(fauxArgs), LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]) };
		tui = PiTui.start(sandbox, { cols: 120, rows: 36, cwd: shop, extensions: [extensionPaths.launcher, extensionPaths.pane, extensionPaths.canopy, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph], env });
		const pi = tui;

		const empty = await pi.see("Your first message starts the tree.");
		expect(empty[0]).toMatch(/^ ◆ shop/);
		expect(empty.join("\n")).not.toContain("[Extensions]");
		expect(empty.at(-1)).toMatch(/⏎\s+start the tree.*alt\+l\s+chat/);

		// Letters are the message's, not keys: p does not open the sessions. A paste keeps its lines.
		pi.press("plan ");
		pi.press("\x1b[200~the refunds\nand the invoices\x1b[201~");
		const written = await pi.see("and the invoices▏");
		expect(written.join("\n")).toContain("plan the refunds");
		expect(written.join("\n")).toContain("2 lines");

		pi.press(KEY.enter);
		// The session takes it as its own message, the tree starts with it, and the canopy draws that tree.
		const tree = await pi.see(/p\s+sessions/, 30_000);
		expect(tree.join("\n")).not.toContain("Your first message starts the tree.");
		expect(tree.join("\n")).toContain("plan the refunds and the invoices");
		await eventually(() => existsSync(join(stateDir, "host.db")), "the tree to be kept in the repository", 10_000);
		pi.press(KEY.altL);
		await pi.see(/echo\[user\].*plan the refunds/, 30_000);
	}, 120_000);
});
