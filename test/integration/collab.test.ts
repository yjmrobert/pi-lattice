import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession, GitSharedStore, Identity, TrustStore } from "../../packages/collab/src/index.ts";
import { LatticeHost } from "../../packages/host/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

interface Person {
	name: string;
	sandbox: Sandbox;
	host: LatticeHost;
	collab: CollabSession;
}

let people: Person[] = [];
let shared: Sandbox;

beforeEach(() => {
	shared = createSandbox();
	people = [];
});
afterEach(async () => {
	for (const person of people) {
		await person.collab.stop().catch(() => {});
		await person.host.stop().catch(() => {});
		person.sandbox.cleanup();
	}
	shared.cleanup();
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** One person's machine: their own Pi config, host state, project checkout and key. */
const machine = async (name: string, remote: string, prepareProject: (dir: string) => void): Promise<Person> => {
	const sandbox = createSandbox();
	prepareProject(sandbox.work);
	const host = await LatticeHost.start(hostOptionsFor(sandbox, { owner: name }));
	const collab = new CollabSession({
		host,
		identity: Identity.loadOrCreate(join(sandbox.root, "keys"), name),
		trust: new TrustStore(join(sandbox.root, "trusted.json")),
		store: new GitSharedStore({ remote, dir: join(sandbox.root, "shared"), author: name }),
		dir: join(sandbox.root, "collab"),
		projectDir: sandbox.work,
		pollMs: 0,
	});
	const person = { name, sandbox, host, collab };
	people.push(person);
	return person;
};
const assistantTexts = async (h: LatticeHost, id: string): Promise<string> => {
	const { messages } = await h.rpc<{ messages: Array<{ role: string; content: unknown }> }>(id, { type: "get_messages" });
	return messages
		.filter((m) => m.role === "assistant")
		.map((m) => (m.content as Array<{ type: string; text?: string }>).filter((p) => p.type === "text").map((p) => p.text).join(""))
		.join("\n");
};
const sendTool = (to: string, text: string) => `!tool send_message ${JSON.stringify({ to, text })}`;

describe("two people sharing a tree", () => {
	it("moves a node between owners with its conversation and branch, and gates mail between them", async () => {
		const remote = join(shared.root, "shared.git");
		git(shared.root, "init", "-q", "--bare", "-b", "main", remote);
		const origin = join(shared.root, "project.git");
		git(shared.root, "init", "-q", "--bare", "-b", "main", origin);

		const yan = await machine("yan", remote, (dir) => {
			git(dir, "init", "-q", "-b", "main");
			git(dir, "config", "user.email", "yan@example.com");
			git(dir, "config", "user.name", "Yan");
			writeFileSync(join(dir, "README.md"), "project\n");
			git(dir, "add", ".");
			git(dir, "commit", "-q", "-m", "init");
			git(dir, "remote", "add", "origin", origin);
			git(dir, "push", "-q", "origin", "main");
		});
		const sam = await machine("sam", remote, (dir) => {
			git(dir, "clone", "-q", origin, ".");
			git(dir, "config", "user.email", "sam@example.com");
			git(dir, "config", "user.name", "Sam");
		});

		// Yan builds a small tree and does some work in a child's worktree.
		const root = await yan.host.createRoot({ name: "checkout", cwd: yan.sandbox.work, fragments: ["coordinator"] });
		const kid = await yan.host.spawnChild(root.id, { name: "impl", fragments: ["worker"], workspace: "worktree", brief: "the password is heliotrope" });
		await eventually(() => yan.host.node(kid.id)?.status === "idle", "yan's child to settle");
		writeFileSync(join(kid.cwd, "work.txt"), "yan's work in progress\n");
		git(kid.cwd, "add", ".");
		git(kid.cwd, "-c", "user.email=yan@example.com", "-c", "user.name=Yan", "commit", "-q", "-m", "wip");

		// Both join the shared tree and deliberately trust each other's keys.
		await yan.collab.start();
		await sam.collab.start();
		expect(sam.host.nodes()).toEqual([]);
		await yan.collab.sync();
		await yan.collab.trustPerson("sam");
		await sam.collab.trustPerson("yan");
		expect(sam.host.nodes().map((n) => [n.name, n.owner])).toEqual([["checkout", "yan"], ["impl", "yan"]]);

		// Sam can see yan's node but cannot run it or type into it.
		await expect(sam.host.prompt(kid.id, "hello?")).rejects.toThrow(/owned by yan/);

		// Two-phase handoff: offer, accept, confirm release.
		await yan.collab.offer(kid.id, "sam");
		await sam.collab.accept(kid.id);
		expect(yan.host.node(kid.id)?.owner).toBe("yan");
		await yan.collab.confirm(kid.id);
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "sam", version: 2 });
		expect(yan.host.isRunning(kid.id)).toBe(false);
		await expect(yan.host.prompt(kid.id, "still mine?")).rejects.toThrow(/owned by sam/);

		// Sam's host takes over: the branch and the conversation both arrived.
		await sam.collab.sync();
		const adopted = sam.host.node(kid.id);
		expect(adopted).toMatchObject({ owner: "sam", version: 2, workspace: "worktree", branch: kid.branch });
		expect(adopted?.cwd.startsWith(sam.sandbox.work)).toBe(true);
		expect(readFileSync(join(adopted?.cwd ?? "", "work.txt"), "utf8")).toBe("yan's work in progress\n");

		await sam.host.prompt(kid.id, "what do you remember?");
		await eventually(async () => (await assistantTexts(sam.host, kid.id)).includes("what do you remember?"), "the adopted session to answer");
		const history = await assistantTexts(sam.host, kid.id);
		expect(history).toContain("heliotrope"); // yan's conversation came along
		expect(history).toContain("roles=[lattice-role-worker]"); // and so did the roles

		// The transferred copy is removed from the shared store once adopted.
		await sam.collab.sync();
		const raw = new GitSharedStore({ remote, dir: join(shared.root, "raw"), author: "observer" });
		expect(await raw.read((tx) => tx.exists(`trees/${root.id}/transfer/${kid.id}`))).toBe(false);

		// Mail from yan's agent to the node sam now owns is held for sam's approval.
		await yan.host.prompt(root.id, sendTool(kid.id, "!reply thanks from sam's side"));
		await eventually(async () => {
			await yan.collab.sync();
			await sam.collab.sync();
			return sam.host.pendingMail()[0];
		}, "yan's message to wait in sam's inbox", 20_000);
		const held = sam.host.pendingMail()[0];
		expect(held?.envelope).toMatchObject({ from: root.id, fromOwner: "yan" });
		expect(await assistantTexts(sam.host, kid.id)).not.toContain("thanks from sam's side");

		// Sam approves; sam's agent replies; the reply is held for yan's approval in turn.
		await sam.host.decideMail(kid.id, held?.envelope.id ?? "", "approve");
		await eventually(async () => {
			await sam.collab.sync();
			await yan.collab.sync();
			return yan.host.pendingMail()[0];
		}, "sam's reply to wait in yan's inbox", 20_000);
		const reply = yan.host.pendingMail()[0];
		expect(reply?.envelope).toMatchObject({ from: kid.id, fromOwner: "sam", payload: { text: "thanks from sam's side" } });
		await yan.host.decideMail(root.id, reply?.envelope.id ?? "", "approve");
		await eventually(async () => (await assistantTexts(yan.host, root.id)).includes("thanks from sam's side"), "the approved reply to reach yan's agent");
		expect(await assistantTexts(yan.host, root.id)).toContain('owner="sam"');
		expect(existsSync(join(yan.sandbox.work, ".lattice"))).toBe(true);
		mkdirSync(join(shared.root, "done"), { recursive: true });
	}, 120_000);
});
