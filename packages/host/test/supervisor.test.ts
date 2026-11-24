/** How the host runs sessions: how many at once, which one makes room, and what a session that cannot start leaves behind. Sessions are a stand-in for Pi. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvelope } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostOptions, LatticeHost } from "../src/index.ts";

const standIn = join(dirname(fileURLToPath(import.meta.url)), "stand-in-pi.mjs");
let dir: string;
let hosts: LatticeHost[];
beforeEach(() => {
	// Short: the host's socket is under it, and the path of a socket may not be long.
	dir = mkdtempSync(join(tmpdir(), "lat-"));
	hosts = [];
});
afterEach(async () => {
	await Promise.all(hosts.map((host) => host.stop().catch(() => {})));
	rmSync(dir, { recursive: true, force: true });
});

const options = (over: Partial<HostOptions> = {}): HostOptions => ({
	stateDir: join(dir, "state"), userDir: join(dir, "user"), socketDir: join(dir, "sock"), piCommand: [process.execPath, standIn], owner: "tester", startTimeoutMs: 8000,
	...over, env: { STAND_IN_DIR: dir, ...over.env },
});
const start = async (over: Partial<HostOptions> = {}): Promise<LatticeHost> => {
	const host = await LatticeHost.start(options(over));
	hosts.push(host);
	return host;
};
const life = (): string[] => (existsSync(join(dir, "life.log")) ? readFileSync(join(dir, "life.log"), "utf8").split("\n").filter(Boolean) : []);
const running = (host: LatticeHost): string[] => host.nodes().filter((node) => host.isRunning(node.id)).map((node) => node.name).sort();
const outcome = (work: Promise<unknown>): Promise<string> => work.then(() => "started", (error: Error) => error.message);
const soon = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe: () => unknown, what: string, ms = 5000): Promise<void> => {
	const end = Date.now() + ms;
	while (!probe()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await soon(10);
	}
};

describe("how many sessions run at once", () => {
	it("is never more than the limit, however many are started in the same moment", async () => {
		const host = await start({ limits: { maxRunning: 2 } });
		const root = await host.createRoot({ name: "root", cwd: dir, brief: "go" });
		let most = 0;
		const watch = setInterval(() => void (most = Math.max(most, running(host).length)), 5);
		const results = await Promise.all(["c1", "c2", "c3", "c4"].map((name) => outcome(host.spawnChild(root.id, { name, brief: "work" }))));
		clearInterval(watch);
		expect(most).toBe(2);
		expect(running(host)).toEqual(["c1", "root"]);
		expect(results[0]).toBe("started");
		for (const result of results.slice(1)) expect(result).toMatch(/was created but could not be started: 2 sessions are already running and none is idle/);
		// What could not start was never started: no process was made for it and then stopped.
		expect(life().filter((line) => line.includes("started pid")).map((line) => line.split(" ")[0])).toEqual(["root", "c1"]);
	});

	it("does not stop a session that is still starting to make room for the next", async () => {
		const host = await start({ limits: { maxRunning: 2 } });
		const root = await host.createRoot({ name: "root", cwd: dir, brief: "go" });
		const slow = outcome(host.spawnChild(root.id, { name: "slow", brief: "the work" }));
		await soon(100); // it has a process, and has not connected
		const next = outcome(host.spawnChild(root.id, { name: "next", brief: "work" }));
		expect(await slow).toBe("started");
		expect(await next).toMatch(/none is idle/);
		expect(running(host)).toEqual(["root", "slow"]);
		expect(life().some((line) => line.startsWith("slow prompted:"))).toBe(true); // it was given its brief
		expect(life()).not.toContain("slow stopped");
	});

	it("puts the idle session to sleep for the one that has work, and leaves it its place in the tree", async () => {
		const host = await start({ limits: { maxRunning: 1 } });
		const root = await host.createRoot({ name: "root", cwd: dir }); // no brief: it is idle
		const child = await host.spawnChild(root.id, { name: "child", brief: "work" });
		expect(running(host)).toEqual(["child"]);
		expect(host.node(root.id)?.status).toBe("dormant");
		expect(host.node(child.id)?.status).toBe("running");
	});

	it("is not held up by a session whose process could not be started", async () => {
		// A NUL in an argument: the process is refused before there is one, so nothing ever says it ended.
		const host = await start({ limits: { maxRunning: 1 }, piArgs: ["bad\0argument"] });
		const first = await outcome(host.createRoot({ name: "first", cwd: dir }));
		expect(first).toMatch(/Pi could not be started/);
		const node = host.nodes()[0];
		expect([node?.status, running(host)]).toEqual(["failed", []]);
		// The place it would have had is free: the next start fails the same way, at once, instead of waiting for room for ever.
		const second = await Promise.race([outcome(host.createRoot({ name: "second", cwd: dir })), soon(3000).then(() => "still waiting")]);
		expect(second).toMatch(/Pi could not be started/);
	});

	it("takes what cannot be an argument out of a child's kind and model", async () => {
		const host = await start();
		const root = await host.createRoot({ name: "root", cwd: dir });
		const child = await host.spawnChild(root.id, { name: "child", brief: "work", kind: "ta\0sk\u001b[2J", model: "some\0model" });
		expect([child.kind, child.model]).toEqual(["ta sk [2J", "some model"]);
		expect(host.isRunning(child.id)).toBe(true);
	});
});

describe("a child that could not be started", () => {
	it("is not something its parent is taken to be waiting on", async () => {
		const host = await start({ limits: { maxRunning: 2 } });
		const root = await host.createRoot({ name: "root", cwd: dir, brief: "go" });
		const parent = await host.spawnChild(root.id, { name: "parent", brief: "do the thing" });
		expect(await outcome(host.spawnChild(parent.id, { name: "kid", brief: "help" }))).toMatch(/could not be started/);
		// The parent ends its turn without answering. It is reminded, as it would be with no child at all.
		await host.rpc(parent.id, { type: "settle" });
		await until(() => life().some((line) => line.startsWith("parent prompted:") && line.includes("without reporting")), "the parent to be reminded");
	});
});

describe("the limits of a tree", () => {
	it("do not count what is archived", async () => {
		const host = await start({ limits: { maxNodes: 1, maxChildren: 3 } });
		const root = await host.createRoot({ name: "root", cwd: dir });
		const plan = (name: string): Promise<string> => outcome(host.spawnChild(root.id, { name, brief: "later", planned: true }));
		const made = [];
		for (const name of ["a", "b", "c"]) made.push(await host.spawnChild(root.id, { name, brief: "later", planned: true }));
		expect(await plan("d")).toMatch(/already has 3 children, the limit/);
		for (const node of made) await host.archive(node.id, true);
		expect(await plan("d")).toBe("started");
	});
});

describe("a session a person opens in their terminal", () => {
	it("is not started again in the background by mail that comes while its background copy stops", async () => {
		const host = await start();
		const root = await host.createRoot({ name: "root", cwd: dir });
		const kid = await host.spawnChild(root.id, { name: "kid", brief: "later", planned: true });
		// Mail the stopping session never takes: when it has gone, the host looks for sessions with mail waiting.
		host.deliverExternal(createEnvelope({ from: kid.id, fromOwner: "tester", to: root.id, intent: "result", text: "done", seq: 1 }), root.id);
		const attached = await host.attachForeground(root.id, "terminal");
		expect(attached.node.id).toBe(root.id);
		await soon(300);
		// One process, started once and stopped: the terminal's session has the session file to itself.
		expect(life().filter((line) => line.startsWith("root "))).toEqual([expect.stringMatching(/^root started pid=/), "root stopped"]);
		expect(host.inUse(root.id)).toBe(true);
		await expect(host.attachForeground(root.id, "another")).rejects.toThrow(/already open in another terminal/);
	});
});

describe("what a person said to a session open in a terminal", () => {
	it("is said to it in the background when the terminal leaves before typing it", async () => {
		const host = await start();
		const root = await host.createRoot({ name: "root", cwd: dir });
		await host.attachForeground(root.id, "terminal");
		await host.steer({ nodeId: root.id, text: "use the blue one" });
		// Only the terminal can type into a session open there: the host keeps the line for it.
		expect(host.uiState().told).toEqual({ [root.id]: 1 });
		host.detachForeground(root.id, "terminal");
		await until(() => life().some((line) => line.startsWith("root prompted:") && line.includes("use the blue one")), "the line to be said in the background");
		expect(host.uiState().told).toBeUndefined();
	});
});

describe("the lock on a tree's state", () => {
	const lock = (text: string): void => {
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(join(dir, "state", "host.lock"), text);
	};

	it("keeps a second host out while the first is running", async () => {
		lock(String(process.ppid)); // another process, and alive
		await expect(LatticeHost.start(options())).rejects.toThrow(/Another lattice host \(pid \d+\) is already running/);
	});

	it("is taken over from a host that is gone", async () => {
		lock("999999999");
		const host = await start();
		expect(readFileSync(join(dir, "state", "host.lock"), "utf8").split("\n")[0]).toBe(String(process.pid));
		await host.stop();
		expect(existsSync(join(dir, "state", "host.lock"))).toBe(false);
	});

	it.runIf(existsSync("/proc/self/stat"))("is taken over when the number of the host that is gone has been given to another process", async () => {
		// The process is alive, and started at another time than the host that wrote the lock did.
		lock(`${process.ppid}\n1`);
		await start();
	});
});
