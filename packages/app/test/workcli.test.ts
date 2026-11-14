/** `pi-lattice work` as an agent in a shell meets it: a real server on a local port, and a lattice home that has joined it. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinServer, WorkClient, WorkServer } from "@pi-lattice/server";
import { joinAndSave } from "../src/work.ts";
import { workCommand } from "../src/workcli.ts";

let server: WorkServer;
let home: string;
let cwd: string;
let person: WorkClient;
let clock = 1_000_000;

beforeEach(async () => {
	clock = 1_000_000;
	server = new WorkServer({ file: ":memory:", host: "127.0.0.1", leaseMs: 60_000, now: () => clock++ });
	const address = `http://127.0.0.1:${await server.start()}/#${server.tracker.code}`;
	home = mkdtempSync(join(tmpdir(), "lattice-home-"));
	cwd = mkdtempSync(join(tmpdir(), "shop-"));
	await joinAndSave(home, address, "yan");
	// The same person, as their own host would be: here it files the work the agent takes.
	person = new WorkClient(await joinServer(address, "sam"));
});
afterEach(async () => {
	await server.stop();
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const run = async (...argv: string[]): Promise<{ code: number; out: string; err: string }> => {
	const [out, err]: [string[], string[]] = [[], []];
	const code = await workCommand(argv, { home, cwd, env: { LATTICE_AGENT: "claude" }, out: (text) => void out.push(text), err: (text) => void err.push(text), stdin: async () => "from standard input" });
	return { code, out: out.join(""), err: err.join("\n") };
};

describe("pi-lattice work", () => {
	it("takes the next issue with its brief and the directions above it, notes, reports the result, and is recorded as the agent", async () => {
		const epic = await person.create({ title: "Checkout", type: "epic" });
		const bug = await person.create({ title: "Total is wrong", type: "bug", parent: epic.number, body: "Tax is added twice." });
		await person.stand((await person.say(epic.number, "no new dependencies")).id, true);

		const next = await run("next");
		expect(next.code).toBe(0);
		expect(next.out).toContain(`#${bug.number}  bug  Total is wrong  [doing]  @yan`);
		expect(next.out).toContain("Tax is added twice.");
		expect(next.out).toContain(`⚑ no new dependencies   (sam, on #${epic.number})`);
		expect(next.out).toContain("It is yours until you say done or drop it, or go quiet for 30 minutes.");
		expect(server.tracker.issue(bug.number)).toMatchObject({ agent: "claude", assignee: "yan", state: "doing" });

		expect((await run("note", String(bug.number), "the", "rounding", "is", "fine")).out).toBe(`Noted on #${bug.number}.\n`);
		expect((await run("add", "Round", "per", "line", "--under", String(epic.number), "--type", "bug", "--why", "found on the way", "--body", "-")).out).toContain("Added #3  bug  Round per line  [todo], under #1. Nobody is on it.");
		expect(server.tracker.issue(3)?.body).toBe("from standard input");
		expect(server.tracker.history(3)[0]).toMatchObject({ who: "yan", as: "claude", what: "created", why: "found on the way" });

		const done = await run("done", String(bug.number), "--summary", "Tax is added once.", "--check", "9 tests pass", "--url", "work/2");
		expect(done.out).toBe(`The result is on #${bug.number}, which is now review. It is checked from here: you do not close it.\n`);
		expect(server.tracker.issue(bug.number)).toMatchObject({ state: "review", result: { summary: "Tax is added once.", checks: "9 tests pass", url: "work/2", by: "claude" } });
		expect(server.tracker.issue(bug.number)?.agent).toBeUndefined();

		const shown = await run("show", String(bug.number));
		expect(shown.out).toContain("yan: the rounding is fine");
		expect(shown.out).toContain("Result, from claude: Tax is added once.");
		expect(shown.out).toContain("claude result -> Tax is added once.");
	});

	it("says there is nothing to take with its own exit code, gives back with a reason, and prints data on request", async () => {
		expect(await run("next")).toMatchObject({ code: 3, out: "", err: "Nothing to take: nothing is ready for this repository." });
		const bug = await person.create({ title: "Flaky", type: "bug" });
		await person.create({ title: "After", type: "bug", waitsOn: [bug.number] });
		const taken = JSON.parse((await run("next", "--json", "--agent", "codex")).out) as { issue: { number: number; agent: string } };
		expect(taken.issue).toMatchObject({ number: bug.number, agent: "codex" });
		// What is left waits on it.
		expect(await run("next")).toMatchObject({ code: 3, err: "Nothing to take: 1 issue waits on others that are not finished." });
		expect((await run("drop", String(bug.number), "needs", "the", "staging", "key", "--agent", "codex")).out).toBe(`#${bug.number} is given back, with what you said. It is todo again.\n`);
		expect(server.tracker.comments(bug.number).at(-1)?.body).toBe("codex gave this back: needs the staging key");
		const tree = await run();
		expect(tree.out).toContain("#1  bug  Flaky  [todo]");
		expect(tree.out).toContain("#2  bug  After  [todo]  (waits on #1)");
		expect((JSON.parse((await run("--json")).out) as { issues: unknown[] }).issues).toHaveLength(2);
	});

	it("says what was wrong in one line, and tells refusal from a command it did not understand", async () => {
		expect(await run("done", "1")).toMatchObject({ code: 2, err: 'Say what was done: --summary "…". pi-lattice work --help lists what there is.' });
		expect(await run("done", "9", "--summary", "x")).toMatchObject({ code: 4, err: "There is no issue #9." });
		expect(await run("frobnicate")).toMatchObject({ code: 2, err: 'There is no "frobnicate". pi-lattice work --help lists what there is.' });
		expect(await run("next", "--nope")).toMatchObject({ code: 2 });
		expect((await run("prime")).out).toContain("pi-lattice work done <n> --summary");
		expect((await run("--help")).out).toContain("Usage: pi-lattice work [command] [options]");
		rmSync(join(home, "server.json"));
		expect(await run("next")).toMatchObject({ code: 4, err: "This machine has joined no server. In pi, /lattice server start keeps the work here, and /lattice server <address> joins a team's." });
	});
});
