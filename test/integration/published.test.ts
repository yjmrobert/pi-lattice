/**
 * The package as people get it: built by `scripts/pack.mjs`, packed by npm, installed into an
 * empty directory outside this repository, and loaded by a real Pi. Nothing there can lean on
 * the workspace: no TypeScript for Node to run, no `node_modules` to borrow from.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, eventually, extensionPaths, piCli, repoRoot, type Sandbox } from "../support/harness.ts";
import { canRunTui, KEY, PiTui } from "../support/tui.ts";

let work: string;
let installed: string;
let sandbox: Sandbox;
let stateDir: string;
let tui: PiTui | undefined;

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "pi-lattice-published-"));
	const built = join(work, "built");
	execFileSync(process.execPath, [join(repoRoot, "scripts/pack.mjs"), built], { stdio: "pipe" });
	execFileSync("npm", ["pack", "--pack-destination", work], { cwd: built, stdio: "pipe" });
	const tarball = join(work, readdirSync(work).find((name) => name.endsWith(".tgz")) as string);
	// What Pi does with an npm source: install it, and not look at what Pi provides at all. Leaving
	// the peers out is not enough: npm would still ask the registry about them, and there is no network here.
	execFileSync("npm", ["install", "--prefix", join(work, "site"), "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund", tarball], { stdio: "pipe" });
	installed = join(work, "site", "node_modules", "pi-lattice");
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

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

describe("the published package", () => {
	it("holds only built JavaScript, the role fragments, the licence and a manifest, and depends on nothing", () => {
		const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { name: string; license: string; repository: { url: string }; dependencies?: object; pi: { extensions: string[] }; bin: Record<string, string> };
		expect(manifest.name).toBe("pi-lattice");
		expect(manifest.license).toBe("MIT");
		expect(manifest.repository.url).toContain("pi-lattice");
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.pi.extensions.map((path) => existsSync(join(installed, path)))).toEqual([true, true, true, true, true, true]);
		expect(existsSync(join(installed, "node_modules"))).toBe(false);
		expect(readdirSync(installed).sort()).toEqual(["LICENSE", "README.md", "extensions", "fragments", "host", "package.json"].sort());
	});

	it("runs its host as a plain Node program from where it is installed", () => {
		const usage = execFileSync(process.execPath, [join(installed, "host/cli.js"), "--help"], { cwd: work, encoding: "utf8" });
		expect(usage).toContain("pi-lattice");
	});

	it.skipIf(!canRunTui)("loads in Pi, starts its host, and runs a child session that loads it too", async () => {
		tui = PiTui.start(sandbox, {
			cols: 150,
			rows: 40,
			extensions: [installed],
			env: {
				LATTICE_STATE_DIR: stateDir,
				LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
				LATTICE_PI_ARGS: JSON.stringify(["-e", extensionPaths.faux, "--provider", "lattice-faux", "--model", "scripted", "--no-skills", "--no-context-files"]),
			},
		});
		const pi = tui;
		await pi.see("[Extensions]");
		await pi.submit("hello");
		await pi.see("echo[user] roles=[] hello");
		await pi.submit("/lattice");
		await pi.see("This session is now part of a lattice tree");
		pi.press(KEY.altL);
		await pi.see(/owner\s+you/);
		pi.press("n");
		await pi.see("New session under work");
		pi.press("payments", KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab);
		await pi.see("what it should do; it sees only this");
		pi.press("say the word heliotrope");
		await pi.see("say the word heliotrope▏");
		pi.press("\x13"); // ctrl+s
		// The child's roles come from the fragments in the package, read by the session the host started.
		await pi.see(/roles\s+protocol · reporting · worker/);
		pi.press("c");
		const canopy = await pi.see("next that needs someone");
		expect(canopy.join("\n")).toMatch(/payments/);
		expect(readFileSync(join(stateDir, "daemon.err"), "utf8")).toBe("");
	}, 90_000);
});
