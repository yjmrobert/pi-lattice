/** One terminal, several repositories: each has its own tree and host, and a session in any of them opens here. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HostClient, UiState } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectHost, knownTrees } from "../../packages/pane/src/index.ts";
import { createSandbox, directorScript, eventually, extensionPaths, type PiChild, piCli, type Sandbox, startPi } from "../support/harness.ts";

let sandbox: Sandbox;
let terminals: PiChild[];
let observers: HostClient[];
let repos: string[];

beforeEach(() => {
	sandbox = createSandbox();
	terminals = [];
	observers = [];
	repos = [];
});
afterEach(async () => {
	await Promise.all(terminals.map((terminal) => terminal.stop().catch(() => {})));
	for (const observer of observers) observer.close();
	for (const repo of repos) {
		try {
			const { pid } = JSON.parse(readFileSync(join(repo, ".lattice", "host.json"), "utf8")) as { pid: number };
			process.kill(pid, "SIGTERM");
			await eventually(() => !existsSync(join(repo, ".lattice", "host.json")), "the host to stop", 10_000);
		} catch {
			// Already stopped.
		}
	}
	sandbox.cleanup();
});

const fauxArgs = ["-e", extensionPaths.faux, "--provider", "lattice-faux", "--model", "scripted", "--no-skills", "--no-context-files"];
const BUNDLE = [extensionPaths.launcher, extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph];

/** A git repository of its own, as a developer's checkout would be. */
const repository = (name: string): string => {
	const dir = join(sandbox.root, name);
	mkdirSync(dir);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const real = realpathSync(dir);
	repos.push(real);
	return real;
};
/** A person's own Pi opened in a repository. Its tree lives in that repository, as it does outside tests. */
const terminal = async (cwd: string, args: string[] = []) => {
	const pi = await startPi(sandbox, {
		name: "terminal",
		extensions: BUNDLE,
		args,
		cwd,
		env: {
			LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
			LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
			LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
			LATTICE_FAUX_SCRIPT: directorScript,
		},
	});
	terminals.push(pi);
	return pi;
};
const stateOf = async (repo: string): Promise<UiState> => {
	const observer = await eventually(() => connectHost(join(repo, ".lattice")), `the host of ${repo}`, 20_000);
	observers.push(observer);
	try {
		return await observer.ui("state", {});
	} finally {
		observer.close();
	}
};
const until = <T>(repo: string, probe: (s: UiState) => T | undefined | false, what: string) => eventually(async () => probe(await stateOf(repo)), what, 20_000);
const where = async (pi: PiChild) => (await pi.client.bash("pwd")).output.trim();
const sessionFile = async (pi: PiChild) => (await pi.client.getState()).sessionFile as string;
/** Start a tree in a repository and leave it, as someone who worked there earlier would have. */
const treeIn = async (repo: string, word: string) => {
	const pi = await terminal(repo);
	await pi.prompt(`remember the word ${word}`);
	const file = await sessionFile(pi);
	await pi.command("/lattice");
	const root = await until(repo, (s) => s.nodes[0]?.status === "idle" && s.nodes[0], "the root");
	await pi.stop();
	await until(repo, (s) => s.foreground.length === 0, "the session to be handed back");
	return { root, file };
};

describe("several repositories", () => {
	it("records each tree where the person's other terminals can find it", async () => {
		const shop = repository("shop");
		await treeIn(shop, "saffron");
		process.env.LATTICE_HOME = sandbox.home;
		try {
			expect(knownTrees()).toEqual([{ stateDir: join(shop, ".lattice"), root: shop, scope: expect.stringMatching(/^(git|dir):/) }]);
		} finally {
			delete process.env.LATTICE_HOME;
		}
	}, 120_000);

	it("starts a tree with the first message in a repository, and keeps it out of git", async () => {
		const shop = repository("shop");
		execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: shop });
		const pi = await terminal(shop);
		await pi.prompt("add a refund endpoint");
		const root = await until(shop, (s) => s.nodes.length === 1 && s.foreground.length === 1 && s.nodes[0], "a tree with this session in it");
		expect(root).toMatchObject({ name: "add a refund endpoint", parentId: null, sessionFile: await sessionFile(pi) });
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: shop, encoding: "utf8" })).toBe("");
		// Asking for a tree now shows the one that is there instead of making a second root.
		await pi.command("/lattice");
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("Tree of 1 session")), "the tree listed");
	}, 120_000);

	it("opens a session from another repository here, moves Pi there, and goes back", async () => {
		const shop = repository("shop");
		const billing = repository("billing-api");
		const there = await treeIn(billing, "cardamom");

		// A terminal in the first repository, with its own tree.
		const pi = await terminal(shop);
		await pi.prompt("remember the word saffron");
		const hereFile = await sessionFile(pi);
		await pi.command("/lattice");
		const here = await until(shop, (s) => s.nodes[0]?.status === "idle" && s.nodes[0], "this repository's root");
		expect(await where(pi)).toBe(shop);

		// The other repository's session opens in this terminal: its host hands it over, and Pi works there.
		await pi.command(`/lattice open ${there.root.id}`);
		await until(billing, (s) => s.foreground.includes(there.root.id), "the other repository's session to be open here");
		await until(shop, (s) => s.foreground.length === 0, "this repository's session to be handed back");
		expect(await sessionFile(pi)).toBe(there.file);
		expect(await where(pi)).toBe(billing);
		await pi.waitFor(() => pi.notifications().find((text) => text.includes("Now in billing-api")), "the notice saying where the terminal now is");
		expect(JSON.stringify(await pi.client.getMessages())).toContain("cardamom");

		// The session speaks as its own node there: a child it spawns belongs to that repository's tree.
		await pi.prompt(`!tool spawn_session ${JSON.stringify({ name: "kid", brief: "wait" })}`);
		await until(billing, (s) => s.nodes.length === 2, "a child in the other repository's tree");
		expect((await stateOf(shop)).nodes).toHaveLength(1);

		// And back to where it was, with one command.
		await pi.command("/lattice back");
		await until(shop, (s) => s.foreground.includes(here.id), "the first session to be open again");
		await until(billing, (s) => !s.foreground.includes(there.root.id), "the other session to be handed back");
		expect(await sessionFile(pi)).toBe(hereFile);
		expect(await where(pi)).toBe(shop);
	}, 180_000);
});
