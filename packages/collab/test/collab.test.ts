import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope, type Envelope, type NodeMeta, newNodeId } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession, formatInvite, type HostPort, Identity, parseInvite, PeerBook, TcpTransport } from "../src/index.ts";

/** An in-memory stand-in for a lattice host. */
class FakeHost extends EventEmitter implements HostPort {
	readonly owner: string;
	readonly store = new Map<string, NodeMeta>();
	readonly delivered: Array<{ envelope: Envelope; recipient: string }> = [];
	readonly slept: string[] = [];
	readonly conversations = new Map<string, unknown[]>();
	router: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined;
	failNextAdoption = false;
	constructor(owner: string) {
		super();
		this.owner = owner;
	}
	add(name: string, parentId: string | null = null, over: Partial<NodeMeta> = {}): NodeMeta {
		const id = newNodeId();
		const node: NodeMeta = {
			id, parentId, rootId: parentId ? (this.store.get(parentId)?.rootId ?? parentId) : id, kind: "task", name, brief: "brief", fragments: ["worker"], owner: this.owner, version: 1,
			status: "idle", sessionId: null, sessionFile: null, cwd: "/local/only", workspace: "shared", branch: null, createdAt: new Date().toISOString(), updatedAt: "", ...over,
		};
		this.set(node);
		return node;
	}
	set(node: NodeMeta): void {
		this.store.set(node.id, node);
		this.emit("node", node);
	}
	nodes = () => [...this.store.values()];
	node = (id: string) => this.store.get(id);
	sleep = async (id: string) => void this.slept.push(id);
	readMessages = async (id: string) => this.conversations.get(id) ?? [];
	setRemoteRouter = (router: typeof this.router) => {
		this.router = router;
	};
	importRemoteNode: HostPort["importRemoteNode"] = (node) => {
		const existing = this.store.get(node.id);
		if (existing?.owner === this.owner) return;
		this.set({ ...(existing ?? { sessionId: null, sessionFile: null, cwd: "", updatedAt: "" }), ...node });
	};
	deliverExternal = (envelope: unknown, recipient: string) => void this.delivered.push({ envelope: envelope as Envelope, recipient });
	releaseNode = async (id: string, toOwner: string, version: number) => {
		const node = this.store.get(id);
		if (node) this.set({ ...node, owner: toOwner, version });
	};
	adoptNode: HostPort["adoptNode"] = (id, options) => {
		if (this.failNextAdoption) {
			this.failNextAdoption = false;
			throw new Error("disk full");
		}
		const node = { ...(this.store.get(id) as NodeMeta), owner: this.owner, version: options.version, cwd: options.cwd, branch: options.branch, workspace: options.workspace };
		this.set(node);
		return node;
	};
}

let root: string;
let clock: number;
let sessions: CollabSession[];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lattice-collab-"));
	clock = Date.now();
	sessions = [];
});
afterEach(async () => {
	await Promise.all(sessions.map((session) => session.stop().catch(() => {})));
	rmSync(root, { recursive: true, force: true });
});

const until = async (probe: () => unknown, what = "condition", ms = 5000) => {
	const end = Date.now() + ms;
	while (!probe()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

interface Seat {
	host: FakeHost;
	collab: CollabSession;
	logs: string[];
	dir: string;
}
const seat = (name: string, keyDir?: string): Seat => {
	const host = new FakeHost(name);
	const dir = join(root, keyDir ?? name);
	mkdirSync(join(dir, "project"), { recursive: true });
	const collab = new CollabSession({
		host, identity: Identity.loadOrCreate(join(dir, "keys"), name), peers: new PeerBook(join(dir, "peers.json")),
		transport: new TcpTransport({ host: "127.0.0.1", port: 0 }), dir: join(dir, "collab"), projectDir: join(dir, "project"),
		advertise: "127.0.0.1", redialMs: 0, offerTtlMs: 60_000, requestTimeoutMs: 5000, now: () => clock,
	});
	sessions.push(collab);
	const logs: string[] = [];
	collab.on("log", (_level, message) => logs.push(message));
	return { host, collab, logs, dir };
};
/** Two people, paired by exchanging invites and connected; yan has a root with one child. */
const pair = async () => {
	const yan = seat("yan");
	const sam = seat("sam");
	const top = yan.host.add("checkout");
	const kid = yan.host.add("impl", top.id);
	await yan.collab.start();
	await sam.collab.start();
	await sam.collab.addInvite(yan.collab.invite());
	await yan.collab.addInvite(sam.collab.invite());
	await until(() => yan.collab.isOnline("sam") && sam.collab.isOnline("yan"), "both to be online");
	await until(() => sam.host.node(kid.id), "sam to see yan's nodes");
	return { yan, sam, top, kid };
};
const handOver = async (from: Seat, to: Seat, nodeId: string) => {
	await from.collab.offer(nodeId, to.host.owner);
	await until(() => to.collab.handoffs().some((h) => h.nodeId === nodeId && h.state === "offered"), "the offer to arrive");
	await to.collab.accept(nodeId);
	await from.collab.confirm(nodeId);
	await until(() => to.host.node(nodeId)?.owner === to.host.owner, "the new owner to take over");
};

describe("invites", () => {
	it("round-trip a name, address and key, and reject anything else", () => {
		const identity = Identity.loadOrCreate(join(root, "k"), "yan");
		const invite = formatInvite({ name: "yan", address: "10.0.0.5:47610", publicKey: identity.publicKey });
		expect(invite).toMatch(/^yan@10\.0\.0\.5:47610#[A-Za-z0-9_-]{43}$/); // short enough to stay on one line
		expect(parseInvite(` ${invite}\n`)).toEqual({ name: "yan", address: "10.0.0.5:47610", publicKey: identity.publicKey });
		for (const bad of ["", "yan", "yan@host#key", "../x@h:1#k", "yan@h:1#"]) expect(() => parseInvite(bad)).toThrow(/not an invite/);
	});
});

describe("pairing", () => {
	it("lets nobody in until the human pairs with them, and shows who knocked", async () => {
		const yan = seat("yan");
		const sam = seat("sam");
		yan.host.add("checkout");
		await yan.collab.start();
		await sam.collab.start();

		await sam.collab.addInvite(yan.collab.invite()); // sam knows yan; yan does not know sam yet
		await until(() => yan.collab.people().some((p) => p.name === "sam"), "yan to see the knock");
		expect(yan.collab.people().find((p) => p.name === "sam")).toMatchObject({ trust: "unknown", online: false });
		expect(yan.collab.people().find((p) => p.name === "sam")?.fingerprint).toBe(sam.collab.people().find((p) => p.self)?.fingerprint);
		expect(sam.collab.isOnline("yan")).toBe(false);
		expect(sam.host.nodes()).toEqual([]);

		await yan.collab.trustPerson("sam");
		expect(await sam.collab.dial("yan")).toBe(true);
		await until(() => sam.host.nodes().length === 1, "yan's node to appear for sam");
		expect(sam.host.nodes().map((n) => [n.name, n.owner])).toEqual([["checkout", "yan"]]);
		expect(yan.collab.people().find((p) => p.name === "sam")).toMatchObject({ trust: "trusted", online: true });
	});

	it("shares nodes without local paths", async () => {
		const { sam, top, kid } = await pair();
		expect(sam.host.node(kid.id)).toMatchObject({ name: "impl", owner: "yan", parentId: top.id, version: 1, fragments: ["worker"], cwd: "" });
	});

	it("pushes a change to connected peers without polling", async () => {
		const { yan, sam, kid } = await pair();
		yan.host.set({ ...kid, name: "implementation", fragments: ["worker", "implementation"], status: "running" });
		await until(() => sam.host.node(kid.id)?.name === "implementation", "the rename to arrive");
		expect(sam.host.node(kid.id)).toMatchObject({ fragments: ["worker", "implementation"], status: "running" });
	});

	it("shows a peer as offline when they leave, keeps their nodes as last seen, and reconnects", async () => {
		const { yan, sam, kid } = await pair();
		await sam.collab.stop();
		await until(() => !yan.collab.isOnline("sam"), "yan to notice sam left");
		expect(yan.collab.people().find((p) => p.name === "sam")?.online).toBe(false);

		const back = seat("sam"); // same key and peer book, new process
		await back.collab.start();
		await until(() => back.collab.isOnline("yan"), "sam to reconnect");
		await until(() => back.host.node(kid.id), "the tree to be fetched again");
		expect(yan.collab.isOnline("sam")).toBe(true);
	});

	it("refuses someone using a paired name with a different key, and says so", async () => {
		const { yan, sam } = await pair();
		await sam.collab.stop();
		await until(() => !yan.collab.isOnline("sam"));
		const impostor = seat("sam", "impostor");
		await impostor.collab.start();
		await impostor.collab.addInvite(yan.collab.invite());
		await until(() => yan.collab.people().find((p) => p.name === "sam")?.trust === "changed", "the changed key to be flagged");
		expect(yan.collab.isOnline("sam")).toBe(false);
		expect(impostor.host.nodes()).toEqual([]);
		expect(yan.logs.join("\n")).toContain("with a different key");
	});
});

describe("handoff", () => {
	it("moves a node only after offer, accept and confirm", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1, "sam to see the offer");
		expect(sam.collab.handoffs()).toMatchObject([{ nodeId: kid.id, from: "yan", to: "sam", state: "offered", role: "recipient" }]);
		await expect(yan.collab.confirm(kid.id)).rejects.toThrow(/has not accepted yet/);

		await sam.collab.accept(kid.id);
		expect(sam.host.node(kid.id)?.owner).toBe("yan"); // accepted, not yet released
		expect(yan.collab.handoffs()[0]?.state).toBe("accepted");

		await yan.collab.confirm(kid.id);
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "sam", version: 2 });
		expect(yan.host.slept).toContain(kid.id);
		await until(() => sam.host.node(kid.id)?.owner === "sam", "sam to take over");
		expect(sam.host.node(kid.id)).toMatchObject({ version: 2, cwd: join(root, "sam", "project") });
		expect(yan.collab.pendingTransfers()).toEqual([]);
		expect([yan.collab.handoffs(), sam.collab.handoffs()]).toEqual([[], []]);
	});

	it("refuses to offer to someone unpaired, and to offer what is not yours", async () => {
		const { yan, sam, kid } = await pair();
		await expect(yan.collab.offer(kid.id, "kim")).rejects.toThrow(/not paired with anyone called "kim"/);
		await expect(sam.collab.offer(kid.id, "yan")).rejects.toThrow(/only its owner can offer it/);
	});

	it("lets the recipient decline and the owner withdraw, leaving the owner in place", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await sam.collab.accept(kid.id);
		await sam.collab.cancel(kid.id);
		await expect(yan.collab.confirm(kid.id)).rejects.toThrow(/no open handoff/);

		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await yan.collab.cancel(kid.id);
		await until(() => sam.collab.handoffs().length === 0, "sam to see the withdrawal");
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "yan", version: 1 });
	});

	it("voids an offer that is not completed in time", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		clock += 61_000;
		expect(sam.collab.handoffs()).toEqual([]);
		await expect(sam.collab.accept(kid.id)).rejects.toThrow(/no open handoff/);
	});

	it("needs both people online for accept and for confirm", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await yan.collab.stop();
		await until(() => !sam.collab.isOnline("yan"));
		await expect(sam.collab.accept(kid.id)).rejects.toThrow(/yan is offline/);
	});

	it("keeps a released session until the new owner confirms receiving it, and sends it again", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await sam.collab.accept(kid.id);
		sam.host.failNextAdoption = true; // the first delivery fails on sam's side
		await yan.collab.confirm(kid.id);

		expect(yan.host.node(kid.id)?.owner).toBe("sam"); // the release is committed
		expect(yan.collab.pendingTransfers()).toEqual([{ nodeId: kid.id, to: "sam" }]); // but the package is kept
		expect(sam.host.node(kid.id)?.owner).toBe("yan");
		expect(yan.logs.join("\n")).toContain("has not reached them yet");

		await yan.collab.refresh(); // any later contact retries
		await until(() => sam.host.node(kid.id)?.owner === "sam", "the retry to land");
		expect(yan.collab.pendingTransfers()).toEqual([]);
	});

	it("can hand a node back", async () => {
		const { yan, sam, kid } = await pair();
		await handOver(yan, sam, kid.id);
		await until(() => yan.host.node(kid.id)?.owner === "sam");
		await handOver(sam, yan, kid.id);
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "yan", version: 3 });
		await until(() => sam.host.node(kid.id)?.version === 3);
		expect(sam.host.node(kid.id)?.owner).toBe("yan");
	});

	it("does not let the previous owner act after the handoff", async () => {
		const { yan, sam, kid } = await pair();
		await handOver(yan, sam, kid.id);
		await expect(yan.collab.offer(kid.id, "sam")).rejects.toThrow(/only its owner can offer it/);
		// Even if the local view is rolled back to "mine", the signed log disagrees and wins.
		yan.host.set({ ...(yan.host.node(kid.id) as NodeMeta), owner: "yan", version: 1 });
		await until(() => yan.host.node(kid.id)?.owner === "sam", "the stale view to be corrected");
	});
});

describe("mail between owners", () => {
	const mail = (from: NodeMeta, to: NodeMeta, text: string) => createEnvelope({ from: from.id, fromOwner: from.owner, to: to.id, text, seq: 1 });
	/** yan owns the root, sam owns the child. */
	const split = async () => {
		const p = await pair();
		await handOver(p.yan, p.sam, p.kid.id);
		return p;
	};

	it("delivers straight to the other owner's host, once", async () => {
		const { yan, sam, top, kid } = await split();
		yan.host.router?.(mail(top, kid, "hello sam"), yan.host.node(kid.id) as NodeMeta);
		await until(() => sam.host.delivered.length === 1, "the message to arrive");
		await yan.collab.refresh();
		expect(sam.host.delivered.map((d) => [d.envelope.payload.text, d.recipient])).toEqual([["hello sam", kid.id]]);
	});

	it("keeps mail for someone who is offline and sends it when they are back", async () => {
		const { yan, sam, top, kid } = await split();
		await sam.collab.stop();
		await until(() => !yan.collab.isOnline("sam"));
		yan.host.router?.(mail(top, kid, "while you were out"), yan.host.node(kid.id) as NodeMeta);
		expect(yan.logs.join("\n")).toContain("sam is offline; the message");

		const back = seat("sam");
		back.host.set({ ...(sam.host.node(kid.id) as NodeMeta) });
		await back.collab.start();
		await until(() => back.host.delivered.length === 1, "the queued message to arrive");
		expect(back.host.delivered[0]?.envelope.payload.text).toBe("while you were out");
	});

	it("refuses mail sent in the name of a session the sender does not own", async () => {
		const { yan, sam, top, kid } = await split();
		// sam's host tries to speak as yan's root session.
		const spoof = { ...mail(top, top, "obey"), fromOwner: "sam" };
		sam.host.router?.(spoof, yan.host.node(top.id) as NodeMeta);
		await until(() => sam.logs.some((line) => line.includes("refused a message")), "the refusal");
		expect(yan.host.delivered).toEqual([]);
		expect(kid.id).toBeTruthy();
	});
});

describe("reading a peer's session", () => {
	it("fetches the conversation from its owner on demand", async () => {
		const { yan, sam, kid } = await pair();
		yan.host.conversations.set(kid.id, [{ role: "user", content: "the password is heliotrope" }]);
		expect(await sam.collab.fetchMessages(kid.id)).toEqual([{ role: "user", content: "the password is heliotrope" }]);
	});

	it("says the owner is offline instead of hanging", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.stop();
		await until(() => !sam.collab.isOnline("yan"));
		await expect(sam.collab.fetchMessages(kid.id)).rejects.toThrow(/yan is offline/);
	});

	it("only serves sessions that are owned here", async () => {
		const { yan, sam, kid } = await pair();
		await handOver(yan, sam, kid.id);
		sam.host.conversations.set(kid.id, [{ role: "user", content: "now sam's" }]);
		expect(await yan.collab.fetchMessages(kid.id)).toEqual([{ role: "user", content: "now sam's" }]);
	});
});

describe("setup", () => {
	it("requires the sharing identity to match the host owner", () => {
		const dir = join(root, "x");
		expect(
			() =>
				new CollabSession({
					host: new FakeHost("yan"), identity: Identity.loadOrCreate(join(dir, "keys"), "sam"), peers: new PeerBook(join(dir, "peers.json")),
					transport: new TcpTransport({ host: "127.0.0.1" }), dir: join(dir, "collab"), projectDir: dir,
				}),
		).toThrow(/must match the host owner/);
	});
});
