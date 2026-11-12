import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, runDaemon } from "../../packages/app/src/index.ts";
import { joinAndSave } from "../../packages/app/src/work.ts";
import { WorkServer } from "../../packages/server/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

/**
 * The whole path a person takes: create a network in one repository's host, join it from
 * another machine with the code, and from then on see each other's sessions and hand them
 * over. Each "machine" is a background host with its own lattice home, on this computer.
 */
interface Machine {
	sandbox: Sandbox;
	daemon: Daemon;
}
let machines: Machine[] = [];
let scratch: Sandbox | undefined;
afterEach(async () => {
	for (const machine of machines) {
		await machine.daemon.stop().catch(() => {});
		machine.sandbox.cleanup();
	}
	machines = [];
	scratch?.cleanup();
	scratch = undefined;
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A person's computer. `repo` is a checkout to work in; hosts for several checkouts share the person's home. */
const machine = async (owner: string, sandbox: Sandbox, repo: string): Promise<Machine> => {
	const stateDir = join(repo, ".lattice");
	const daemon = await runDaemon({
		stateDir, cwd: repo, owner, idleExitMs: 0, tickMs: 100, home: sandbox.home, discovery: false, advertise: "127.0.0.1",
		hostOptions: hostOptionsFor(sandbox, { stateDir, owner, socketDir: join(sandbox.root, `sock-${machines.length}`) }),
	});
	const made = { sandbox, daemon };
	machines.push(made);
	return made;
};
const sharing = (m: Machine) => m.daemon.host.uiState().sharing;
const run = (m: Machine, action: string, ...args: string[]) => m.daemon.host.runSharing(action, args);

describe("a network of teammates, through the background host", () => {
	it("is created once, joined with one code, and then shows and moves sessions with nothing else to set up", async () => {
		scratch = createSandbox();
		const origin = join(scratch.root, "project.git");
		git(scratch.root, "init", "-q", "--bare", "-b", "main", origin);
		const checkout = (dir: string, who: string, fresh: boolean): string => {
			if (fresh) {
				git(dir, "init", "-q", "-b", "main");
				writeFileSync(join(dir, "README.md"), "project\n");
			} else git(dir, "clone", "-q", origin, ".");
			git(dir, "config", "user.email", `${who}@example.com`);
			git(dir, "config", "user.name", who);
			if (fresh) {
				git(dir, "add", ".");
				git(dir, "commit", "-q", "-m", "init");
				git(dir, "remote", "add", "origin", origin);
				git(dir, "push", "-q", "origin", "main");
			}
			return dir;
		};

		const yanBox = createSandbox();
		const yan = await machine("yan", yanBox, checkout(yanBox.work, "yan", true));
		expect(sharing(yan)).toBeNull(); // nothing is shared until there is a network

		const root = await yan.daemon.host.createRoot({ name: "checkout", cwd: yanBox.work, fragments: [] });
		const kid = await yan.daemon.host.spawnChild(root.id, { name: "impl", fragments: ["worker"], brief: "the password is heliotrope" });
		await eventually(() => yan.daemon.host.node(kid.id)?.status === "idle", "yan's child to settle");

		// Yan creates the network. The answer is the code to pass on; it names where yan is.
		const created = await run(yan, "create", "team");
		const code = created.split("\n").at(-1) ?? "";
		expect(code).toMatch(/^\/lattice join team\.[A-Za-z0-9_-]{43}@127\.0\.0\.1/);
		expect(sharing(yan)).toMatchObject({ network: "team", people: [{ name: "yan", self: true }] });
		expect(statSync(join(yanBox.home, "network.json")).mode & 0o077).toBe(0); // the secret is the person's alone
		await expect(run(yan, "create", "another")).rejects.toThrow(/already in team/);

		// Sam joins with the code, in their clone of the same repository. That is all either of them does.
		const samBox = createSandbox();
		const sam = await machine("sam", samBox, checkout(samBox.work, "sam", false));
		await run(sam, "join", code);
		await eventually(() => sam.daemon.host.nodes().length === 2, "yan's sessions to appear for sam");
		expect(sam.daemon.host.nodes().map((n) => [n.name, n.owner]).sort()).toEqual([["checkout", "yan"], ["impl", "yan"]]);
		await eventually(() => sharing(yan)?.people.some((p) => p.name === "sam" && p.online), "yan to see sam");

		// A host sam already had running for another repository joins by itself, and stays out of this one's tree.
		const elsewhere = join(samBox.root, "other-repo");
		git(samBox.root, "init", "-q", "-b", "main", elsewhere);
		git(elsewhere, "-c", "user.email=sam@example.com", "-c", "user.name=sam", "commit", "-q", "--allow-empty", "-m", "another project");
		const other = await machine("sam", samBox, elsewhere);
		await eventually(() => sharing(other)?.network === "team", "sam's other host to follow the network file");
		expect(other.daemon.host.nodes()).toEqual([]);

		// From that other repository sam still sees what yan has running, as a repository that is not here, with where to clone it.
		await eventually(() => sharing(other)?.elsewhere.length === 1, "sam's other host to hear what yan has running");
		expect(sharing(other)?.people.find((p) => p.name === "yan")).toMatchObject({ online: true, here: false }); // reachable, not working there
		expect(sharing(other)?.elsewhere[0]).toMatchObject({ repo: "work", url: origin, owner: "yan", online: true });
		expect(sharing(other)?.elsewhere[0]?.nodes.map((n) => [n.name, n.owner]).sort()).toEqual([["checkout", "yan"], ["impl", "yan"]]);
		expect(sharing(sam)?.elsewhere).toEqual([]); // from sam's clone of the same repository, nothing of yan's is elsewhere
		// And can watch one of those sessions: what it last did is fetched from yan's host for that repository.
		const seen = await eventually(async () => {
			const lines = await other.daemon.host.tail(kid.id);
			return lines.length > 0 && lines;
		}, "the session's recent activity to arrive from yan");
		expect(seen.join("\n")).toContain('as its child "impl"');
		// It keeps coming while sam looks: yan's session does something more, and sam sees it without asking yan's host again.
		await yan.daemon.host.prompt(kid.id, "say saffron");
		await eventually(async () => (await other.daemon.host.tail(kid.id)).join("\n").includes("saffron"), "what the session did next to reach sam");

		// Sam asks for yan's session; yan approves; it is sam's.
		await run(sam, "ask", kid.id);
		await eventually(() => sharing(yan)?.requests.some((r) => r.from === "sam" && r.nodeId === kid.id), "the request to reach yan");
		expect(sharing(sam)?.requests).toMatchObject([{ nodeId: kid.id, to: "yan", role: "asker" }]);
		await run(yan, "approve", kid.id, "sam");
		await eventually(() => sam.daemon.host.node(kid.id)?.owner === "sam", "the session to become sam's");
		await eventually(() => yan.daemon.host.node(kid.id)?.owner === "sam", "yan to see it is sam's");
		expect([sharing(yan)?.requests, sharing(sam)?.requests]).toEqual([[], []]);

		// And back the other way: sam offers it, yan accepts, with no third step.
		await run(sam, "offer", kid.id, "yan");
		await eventually(() => sharing(yan)?.handoffs.some((h) => h.nodeId === kid.id && h.role === "recipient"), "the offer to reach yan");
		await run(yan, "accept", kid.id);
		await eventually(() => yan.daemon.host.node(kid.id)?.owner === "yan" && sam.daemon.host.node(kid.id)?.owner === "yan", "the session to be yan's again");

		// Leaving takes effect in every one of sam's hosts, and yan sees sam go.
		await run(sam, "leave");
		expect(sharing(sam)).toBeNull();
		await eventually(() => sharing(other) === null, "sam's other host to leave too");
		expect(existsSync(join(samBox.home, "network.json"))).toBe(false);
		await eventually(() => sharing(yan)?.people.some((p) => p.name === "sam" && !p.online), "yan to see sam leave");

		// One repository can be kept out of the network, by a setting of its own.
		writeFileSync(join(yanBox.work, ".lattice", "config.json"), JSON.stringify({ network: { share: false } }));
		await eventually(() => sharing(yan) === null, "yan's host for that repository to stop sharing");
		expect(existsSync(join(yanBox.home, "network.json"))).toBe(true); // yan is still in the network, elsewhere
	}, 120_000);

	it("needs no code on a team's server: the server says who is where and carries offers and requests, and the session goes straight across", async () => {
		const server = new WorkServer({ file: ":memory:", host: "127.0.0.1" });
		const address = `http://127.0.0.1:${await server.start()}/#${server.tracker.code}`;
		try {
			scratch = createSandbox();
			const origin = join(scratch.root, "project.git");
			git(scratch.root, "init", "-q", "--bare", "-b", "main", origin);
			const yanBox = createSandbox();
			git(yanBox.work, "init", "-q", "-b", "main");
			writeFileSync(join(yanBox.work, "README.md"), "project\n");
			git(yanBox.work, "-c", "user.email=yan@example.com", "-c", "user.name=yan", "add", ".");
			git(yanBox.work, "-c", "user.email=yan@example.com", "-c", "user.name=yan", "commit", "-q", "-m", "init");
			git(yanBox.work, "remote", "add", "origin", origin);
			git(yanBox.work, "push", "-q", "origin", "main");
			const samBox = createSandbox();
			git(samBox.work, "clone", "-q", origin, ".");

			// Each joins the server, and that is all: no network is created and no code is passed.
			await joinAndSave(yanBox.home, address, "yan");
			await joinAndSave(samBox.home, address, "sam");
			const yan = await machine("yan", yanBox, yanBox.work);
			const root = await yan.daemon.host.createRoot({ name: "checkout", cwd: yanBox.work, fragments: [] });
			const kid = await yan.daemon.host.spawnChild(root.id, { name: "impl", fragments: ["worker"], brief: "the password is heliotrope" });
			await eventually(() => yan.daemon.host.node(kid.id)?.status === "idle", "yan's child to settle");
			const sam = await machine("sam", samBox, samBox.work);
			await eventually(() => sharing(yan)?.network === "team" && sharing(sam)?.network === "team", "both hosts to take the server's team as their network");
			expect(existsSync(join(yanBox.home, "network.json"))).toBe(false);

			// The server tells each where the other is and which key they sign with; the hosts connect.
			await eventually(() => sam.daemon.host.nodes().length === 2, "yan's sessions to appear for sam");
			await eventually(() => sharing(yan)?.people.some((p) => p.name === "sam" && p.here), "yan to be connected to sam");
			expect(yan.daemon.host.uiState().work?.hosts.map((entry) => [entry.owner, entry.addresses.length > 0]).sort()).toEqual([["sam", true], ["yan", true]]);
			expect(yan.daemon.host.uiState().work?.people.every((person) => typeof person.key === "string")).toBe(true);

			// Sam asks; yan approves; it is sam's. The asking and the offer went by the server.
			const before = server.relayed;
			await run(sam, "ask", kid.id);
			await eventually(() => sharing(yan)?.requests.some((r) => r.from === "sam" && r.nodeId === kid.id), "the request to reach yan");
			await run(yan, "approve", kid.id, "sam");
			await eventually(() => sam.daemon.host.node(kid.id)?.owner === "sam" && yan.daemon.host.node(kid.id)?.owner === "sam", "the session to become sam's");
			expect(server.relayed).toBeGreaterThanOrEqual(before + 6); // ask, offered and accept, each with its answer
			// It arrived whole, straight from yan's machine: it is in sam's checkout, and nothing is left to send.
			await eventually(() => sam.daemon.host.node(kid.id)?.cwd === samBox.work, "the session to be set up in sam's checkout");
			await eventually(() => sharing(yan)?.pendingTransfers.length === 0, "sam's receipt to reach yan");

			// Back the other way: offered, declined by cancelling, offered again, accepted.
			await run(sam, "offer", kid.id, "yan");
			await eventually(() => sharing(yan)?.handoffs.some((h) => h.nodeId === kid.id && h.role === "recipient" && h.state === "offered"), "the offer to reach yan");
			await run(sam, "cancel", kid.id);
			await eventually(() => !sharing(yan)?.handoffs.some((h) => h.nodeId === kid.id && h.state === "offered"), "yan to see the offer withdrawn");
			await run(sam, "offer", kid.id, "yan");
			await eventually(() => sharing(yan)?.handoffs.some((h) => h.nodeId === kid.id && h.state === "offered"), "the second offer to reach yan");
			await run(yan, "accept", kid.id);
			await eventually(() => yan.daemon.host.node(kid.id)?.owner === "yan" && sam.daemon.host.node(kid.id)?.owner === "yan", "the session to be yan's again");

			// With sam gone, an offer waits; nothing is stored for sam on the server.
			await sam.daemon.stop();
			await eventually(() => !yan.daemon.host.uiState().work?.hosts.some((entry) => entry.owner === "sam"), "the server to forget sam's host", 60_000);
			const quiet = server.relayed;
			await run(yan, "offer", kid.id, "sam");
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(sharing(yan)?.handoffs).toMatchObject([{ nodeId: kid.id, to: "sam", state: "offered", role: "owner" }]);
			expect(server.relayed).toBe(quiet);
		} finally {
			await server.stop();
		}
	}, 180_000);

	it("asks a person's name once, and their sessions follow it", async () => {
		const box = createSandbox();
		git(box.work, "init", "-q", "-b", "main");
		const stateDir = join(box.work, ".lattice");
		const { owner: _unused, ...hostOptions } = hostOptionsFor(box, { stateDir, socketDir: join(box.root, "sock") });
		const start = async (): Promise<Machine> => {
			const made = { sandbox: box, daemon: await runDaemon({ stateDir, cwd: box.work, idleExitMs: 0, tickMs: 100, home: box.home, discovery: false, advertise: "127.0.0.1", hostOptions }) };
			machines.push(made);
			return made;
		};

		// Until they say otherwise a person is called after their OS user, and the pane knows to ask.
		let me = await start();
		const before = me.daemon.host.owner;
		expect(before).toBe(userInfo().username);
		expect(me.daemon.host.uiState().named).toBe(false);
		const root = await me.daemon.host.createRoot({ name: "checkout", cwd: box.work, fragments: [] });
		await expect(run(me, "name", "not a name")).rejects.toThrow(/cannot be used as a name/);

		// The name is kept for every repository; this host uses it from its next start, and shares nothing until then.
		expect(await run(me, "name", "robin")).toContain("next start");
		await run(me, "create", "team");
		expect(sharing(me)).toBeNull();
		await me.daemon.stop();
		machines = [];

		me = await start();
		expect(me.daemon.host.owner).toBe("robin");
		expect(me.daemon.host.uiState().named).toBe(true);
		expect(me.daemon.host.node(root.id)?.owner).toBe("robin"); // what was theirs still is
		expect(sharing(me)).toMatchObject({ network: "team", people: [{ name: "robin", self: true }] });

		// Teammates know them by it now: it stays while they are in the network.
		await expect(run(me, "name", "bob")).rejects.toThrow(/Leave the network/);
		expect(await run(me, "name", "robin")).toBe("You go by robin.");
	});

	it("says which addresses it tried and why they did not answer", async () => {
		const box = createSandbox();
		git(box.work, "init", "-q", "-b", "main");
		const sam = await machine("sam", box, box.work);
		// The whole line a teammate was sent, naming a machine where nothing listens.
		expect(await run(sam, "join", `/lattice join team.${"A".repeat(43)}@127.0.0.1:9`)).toContain("You are in team");
		await eventually(() => (sharing(sam)?.tried ?? []).length > 0, "the dead address to be tried");
		expect(sharing(sam)?.tried).toEqual([{ address: "127.0.0.1:9", why: expect.stringContaining("nothing is listening") }]);
	});
});
