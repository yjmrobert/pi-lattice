import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope, type Envelope, type NodeMeta, newNodeId } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession, GitSharedStore, type HostPort, Identity, TrustStore } from "../src/index.ts";

/** An in-memory stand-in for a lattice host. */
class FakeHost implements HostPort {
	readonly owner: string;
	readonly store = new Map<string, NodeMeta>();
	readonly delivered: Array<{ envelope: Envelope; recipient: string }> = [];
	readonly slept: string[] = [];
	router: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined;
	constructor(owner: string) {
		this.owner = owner;
	}
	add(name: string, parentId: string | null = null, over: Partial<NodeMeta> = {}): NodeMeta {
		const id = newNodeId();
		const node: NodeMeta = {
			id, parentId, rootId: parentId ? (this.store.get(parentId)?.rootId ?? parentId) : id, kind: "task", name, brief: "brief", fragments: ["worker"], owner: this.owner, version: 1,
			status: "idle", sessionId: null, sessionFile: null, cwd: "/local/only", workspace: "shared", branch: null, createdAt: new Date().toISOString(), updatedAt: "", ...over,
		};
		this.store.set(id, node);
		return node;
	}
	nodes = () => [...this.store.values()];
	node = (id: string) => this.store.get(id);
	sleep = async (id: string) => void this.slept.push(id);
	setRemoteRouter = (router: typeof this.router) => {
		this.router = router;
	};
	importRemoteNode: HostPort["importRemoteNode"] = (node) => {
		const existing = this.store.get(node.id);
		if (existing?.owner === this.owner) return;
		this.store.set(node.id, { ...(existing ?? { sessionId: null, sessionFile: null, cwd: "", updatedAt: "" }), ...node });
	};
	deliverExternal = (envelope: unknown, recipient: string) => void this.delivered.push({ envelope: envelope as Envelope, recipient });
	releaseNode = async (id: string, toOwner: string, version: number) => {
		const node = this.store.get(id);
		if (node) this.store.set(id, { ...node, owner: toOwner, version });
	};
	adoptNode: HostPort["adoptNode"] = (id, options) => {
		const node = { ...(this.store.get(id) as NodeMeta), owner: this.owner, version: options.version, cwd: options.cwd, branch: options.branch, workspace: options.workspace };
		this.store.set(id, node);
		return node;
	};
}

let root: string;
let remote: string;
let clock: number;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lattice-collab-"));
	remote = join(root, "shared.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	clock = Date.now();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const join_ = (name: string) => {
	const host = new FakeHost(name);
	const dir = join(root, name);
	mkdirSync(join(dir, "project"), { recursive: true });
	const collab = new CollabSession({
		host, identity: Identity.loadOrCreate(join(dir, "keys"), name), trust: new TrustStore(join(dir, "trusted.json")),
		store: new GitSharedStore({ remote, dir: join(dir, "shared"), author: name }), dir: join(dir, "collab"), projectDir: join(dir, "project"),
		pollMs: 0, offerTtlMs: 60_000, now: () => clock,
	});
	const logs: string[] = [];
	collab.on("log", (_level, message) => logs.push(message));
	return { host, collab, logs, dir };
};
/** Two people who have joined and trusted each other; yan has a root with one child. */
const pair = async () => {
	const yan = join_("yan");
	const sam = join_("sam");
	const top = yan.host.add("checkout");
	const kid = yan.host.add("impl", top.id);
	await yan.collab.start();
	await sam.collab.start();
	await yan.collab.sync();
	await yan.collab.trustPerson("sam");
	await sam.collab.trustPerson("yan");
	return { yan, sam, top, kid };
};

describe("sharing a tree", () => {
	it("shows nothing from a person until the human trusts their key", async () => {
		const yan = join_("yan");
		const sam = join_("sam");
		yan.host.add("checkout");
		await yan.collab.start();
		await sam.collab.start();
		expect(sam.host.nodes()).toEqual([]);
		expect(sam.collab.people().find((p) => p.name === "yan")).toMatchObject({ trust: "unknown", self: false });
		expect(sam.logs.join("\n")).toContain("you have not trusted yan yet");

		await sam.collab.trustPerson("yan");
		expect(sam.host.nodes().map((n) => [n.name, n.owner])).toEqual([["checkout", "yan"]]);
	});

	it("shares the tree without local paths, and keeps remote nodes marked with their owner", async () => {
		const { sam, top, kid } = await pair();
		const seen = sam.host.node(kid.id);
		expect(seen).toMatchObject({ name: "impl", owner: "yan", parentId: top.id, version: 1, fragments: ["worker"] });
		expect(seen?.cwd).toBe("");
	});

	it("reflects a renamed or re-roled node on the other side", async () => {
		const { yan, sam, kid } = await pair();
		yan.host.store.set(kid.id, { ...kid, name: "implementation", fragments: ["worker", "implementation"], status: "running" });
		await yan.collab.sync();
		await sam.collab.sync();
		expect(sam.host.node(kid.id)).toMatchObject({ name: "implementation", fragments: ["worker", "implementation"], status: "running" });
	});

	it("stops believing a person whose published key changes", async () => {
		const { sam, top } = await pair();
		// Someone replaces yan's published key with their own.
		const impostor = join_("yan2");
		rmSync(join(impostor.dir, "keys"), { recursive: true, force: true });
		const fake = Identity.loadOrCreate(join(impostor.dir, "keys"), "yan");
		const store = new GitSharedStore({ remote, dir: join(impostor.dir, "raw"), author: "impostor" });
		await store.commit("swap key", (tx) => tx.write("people/yan.json", JSON.stringify(fake.sign({ name: "yan", publicKey: fake.publicKey, at: "x" }))));
		await sam.collab.sync();
		expect(sam.collab.people().find((p) => p.name === "yan")?.trust).toBe("changed");
		expect(sam.host.node(top.id)?.owner).toBe("yan"); // what was already verified stays; nothing new is believed
	});
});

describe("handoff", () => {
	it("moves a node only after offer, accept and confirm, with both sides agreeing", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await sam.collab.sync();
		expect(sam.collab.handoffs()).toMatchObject([{ nodeId: kid.id, from: "yan", to: "sam", state: "offered", role: "recipient" }]);
		expect(yan.host.node(kid.id)?.owner).toBe("yan");

		await expect(yan.collab.confirm(kid.id)).rejects.toThrow(/has not accepted yet/);
		await sam.collab.accept(kid.id);
		expect(sam.host.node(kid.id)?.owner).toBe("yan"); // accepted, not yet released

		await yan.collab.confirm(kid.id);
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "sam", version: 2 });
		expect(yan.host.slept).toContain(kid.id);

		await sam.collab.sync();
		expect(sam.host.node(kid.id)).toMatchObject({ owner: "sam", version: 2, cwd: join(root, "sam", "project") });
		expect(sam.collab.handoffs()).toEqual([]);
		expect(yan.collab.handoffs()).toEqual([]);
	});

	it("refuses to offer to someone who is unknown or untrusted", async () => {
		const yan = join_("yan");
		const sam = join_("sam");
		const top = yan.host.add("checkout");
		await yan.collab.start();
		await expect(yan.collab.offer(top.id, "sam")).rejects.toThrow(/Nobody called "sam"/);
		await sam.collab.start();
		await expect(yan.collab.offer(top.id, "sam")).rejects.toThrow(/Trust sam first/);
	});

	it("lets only the owner offer, and only the named recipient accept", async () => {
		const { yan, sam, kid } = await pair();
		await expect(sam.collab.offer(kid.id, "yan")).rejects.toThrow(/only its owner can offer it/);
		const kim = join_("kim");
		await kim.collab.start();
		await kim.collab.trustPerson("yan");
		await yan.collab.offer(kid.id, "sam");
		await kim.collab.sync();
		expect(kim.collab.handoffs()).toEqual([]);
		await expect(kim.collab.accept(kid.id)).rejects.toThrow(/no open handoff/);
	});

	it("lets either side cancel before the release, leaving the owner in place", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await sam.collab.accept(kid.id);
		await sam.collab.cancel(kid.id);
		await expect(yan.collab.confirm(kid.id)).rejects.toThrow(/no open handoff/);
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "yan", version: 1 });
	});

	it("voids an offer that is not completed in time", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		clock += 61_000;
		await sam.collab.sync();
		expect(sam.collab.handoffs()).toEqual([]);
		await expect(sam.collab.accept(kid.id)).rejects.toThrow(/no open handoff/);
	});

	it("rejects the previous owner's attempt to act after the handoff", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await sam.collab.accept(kid.id);
		await yan.collab.confirm(kid.id);
		await expect(yan.collab.offer(kid.id, "sam")).rejects.toThrow(/only its owner can offer it/);
		// Even with a stale local view that still says "mine", the shared log refuses it.
		yan.host.store.set(kid.id, { ...(yan.host.node(kid.id) as NodeMeta), owner: "yan", version: 1 });
		await yan.collab.sync();
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "sam", version: 2 });
	});

	it("can hand a node back", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await sam.collab.accept(kid.id);
		await yan.collab.confirm(kid.id);
		await sam.collab.sync();
		await sam.collab.offer(kid.id, "yan");
		await yan.collab.accept(kid.id);
		await sam.collab.confirm(kid.id);
		await yan.collab.sync();
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "yan", version: 3 });
		expect(sam.host.node(kid.id)).toMatchObject({ owner: "yan", version: 3 });
	});
});

describe("mail between owners", () => {
	const mail = (from: NodeMeta, to: NodeMeta, text: string) => createEnvelope({ from: from.id, fromOwner: from.owner, to: to.id, text, seq: 1 });
	/** yan owns the root, sam owns the child. */
	const split = async () => {
		const p = await pair();
		await p.yan.collab.offer(p.kid.id, "sam");
		await p.sam.collab.accept(p.kid.id);
		await p.yan.collab.confirm(p.kid.id);
		await p.sam.collab.sync();
		return p;
	};

	it("carries a signed envelope to the other owner's host, once", async () => {
		const { yan, sam, top, kid } = await split();
		yan.host.router?.(mail(top, kid, "hello sam"), yan.host.node(kid.id) as NodeMeta);
		await yan.collab.sync();
		await sam.collab.sync();
		await sam.collab.sync();
		expect(sam.host.delivered.map((d) => [d.envelope.payload.text, d.recipient])).toEqual([["hello sam", kid.id]]);
	});

	it("discards mail that claims an owner who did not sign it", async () => {
		const { yan, sam, top, kid } = await split();
		const mallory = Identity.loadOrCreate(join(root, "mallory"), "mallory");
		const forged = { ...mallory.sign({ envelope: mail(top, kid, "obey me"), recipient: kid.id }), by: "yan" };
		const raw = new GitSharedStore({ remote, dir: join(root, "raw"), author: "mallory" });
		await raw.commit("forge", (tx) => tx.write(`trees/${top.id}/mail/sam/forged.json`, JSON.stringify(forged)));
		await sam.collab.sync();
		expect(sam.host.delivered).toEqual([]);
		expect(sam.logs.join("\n")).toContain("did not verify");
		expect(yan.host.delivered).toEqual([]);
	});

	it("discards mail sent in the name of a node the signer does not own", async () => {
		const { yan, sam, top, kid } = await split();
		// sam signs honestly as sam, but claims to speak as yan's root node.
		const samKey = Identity.loadOrCreate(join(root, "sam", "keys"), "sam");
		const spoof = samKey.sign({ envelope: { ...mail(top, kid, "spoof"), fromOwner: "sam" }, recipient: kid.id });
		const raw = new GitSharedStore({ remote, dir: join(root, "raw"), author: "sam" });
		await raw.commit("spoof", (tx) => tx.write(`trees/${top.id}/mail/sam/spoof.json`, JSON.stringify(spoof)));
		await sam.collab.sync();
		expect(sam.host.delivered).toEqual([]);
		expect(yan.host.node(top.id)?.owner).toBe("yan");
	});

	it("holds mail from a person not yet trusted instead of dropping it", async () => {
		const yan = join_("yan");
		const sam = join_("sam");
		const top = yan.host.add("checkout");
		const kid = sam.host.add("helper", null, { rootId: top.id, parentId: top.id });
		await yan.collab.start();
		await sam.collab.start();
		await yan.collab.sync();
		await yan.collab.trustPerson("sam"); // yan trusts sam; sam has not trusted yan
		yan.host.router?.(mail(top, yan.host.node(kid.id) as NodeMeta, "are you there"), yan.host.node(kid.id) as NodeMeta);
		await yan.collab.sync();
		await sam.collab.sync();
		expect(sam.host.delivered).toEqual([]);
		expect(sam.logs.join("\n")).toContain("you have not trusted yan yet");

		await sam.collab.trustPerson("yan");
		expect(sam.host.delivered.map((d) => d.envelope.payload.text)).toEqual(["are you there"]);
	});
});

describe("setup", () => {
	it("requires the sharing identity to match the host owner", () => {
		const dir = join(root, "x");
		expect(
			() =>
				new CollabSession({
					host: new FakeHost("yan"), identity: Identity.loadOrCreate(join(dir, "keys"), "sam"), trust: new TrustStore(join(dir, "t.json")),
					store: new GitSharedStore({ remote, dir: join(dir, "shared"), author: "x" }), dir: join(dir, "collab"), projectDir: dir,
				}),
		).toThrow(/must match the host owner/);
		writeFileSync(join(root, "unused"), "");
	});
});
