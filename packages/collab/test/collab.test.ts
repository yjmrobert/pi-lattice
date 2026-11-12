import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope, type Envelope, type NodeMeta, newNodeId } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession, type HostPort, Identity, type Network, PeerBook, TcpTransport } from "../src/index.ts";

/** An in-memory stand-in for a lattice host. */
class FakeHost extends EventEmitter implements HostPort {
	readonly owner: string;
	readonly store = new Map<string, NodeMeta>();
	readonly delivered: Array<{ envelope: Envelope; recipient: string }> = [];
	readonly slept: string[] = [];
	readonly conversations = new Map<string, unknown[]>();
	router: ((envelope: Envelope, recipient: NodeMeta) => void) | undefined;
	failNextAdoption = false;
	/** Sessions a person has open in a terminal. */
	readonly open = new Set<string>();
	inUse = (id: string) => this.open.has(id);
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
	while (!(await probe())) {
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
const teamOf = (name: string): Network => ({ name, secret: randomBytes(32).toString("base64url") });
const TEAM = teamOf("team");

/**
 * Hosts do not look for each other: they are told where a teammate's host is, which in
 * practice the team's server does. Here a test says it, with what `whereIs` gives.
 */
const places = new WeakMap<CollabSession, { name: string; scope: string }>();
const whereIs = (collab: CollabSession): string => {
	const { name, scope } = places.get(collab) as { name: string; scope: string };
	return `${name}|${scope}|${collab.listening()[0]}`;
};
/** Note who a host is, and have it told where another is as soon as it starts. */
const enrol = (collab: CollabSession, name: string, scope: string, where?: string): void => {
	places.set(collab, { name, scope });
	if (where === undefined) return;
	const [who = "", theirs = "", address = ""] = where.split("|");
	const start = collab.start.bind(collab);
	collab.start = async () => {
		await start();
		collab.heardAt(who, [address], theirs === scope);
	};
};

/** A person's host. `code` is where a teammate's host is; without it nobody has told them of anyone. */
const seat = (name: string, code?: string, keyDir?: string, network = TEAM): Seat => {
	const host = new FakeHost(name);
	const dir = join(root, keyDir ?? name);
	mkdirSync(join(dir, "project"), { recursive: true });
	const collab = new CollabSession({
		host, identity: Identity.loadOrCreate(join(dir, "keys"), name), peers: new PeerBook(join(dir, "people.json")), network,
		transport: new TcpTransport({ host: "127.0.0.1", port: 0 }), dir: join(dir, "collab"), projectDir: join(dir, "project"),
		advertise: "127.0.0.1", redialMs: 0, offerTtlMs: 60_000, requestTimeoutMs: 5000, now: () => clock,
	});
	enrol(collab, name, "", code);
	sessions.push(collab);
	const logs: string[] = [];
	collab.on("log", (_level, message) => logs.push(message));
	return { host, collab, logs, dir };
};
/** Two people on one team, connected; yan has a root with one child. */
const pair = async () => {
	const yan = seat("yan");
	const top = yan.host.add("checkout");
	const kid = yan.host.add("impl", top.id);
	await yan.collab.start();
	const code = whereIs(yan.collab);
	const sam = seat("sam", code);
	await sam.collab.start();
	await until(() => yan.collab.isOnline("sam") && sam.collab.isOnline("yan"), "both to be online");
	await until(() => sam.host.node(kid.id), "sam to see yan's nodes");
	return { yan, sam, top, kid, code };
};
const handOver = async (from: Seat, to: Seat, nodeId: string) => {
	await from.collab.offer(nodeId, to.host.owner);
	await until(() => to.collab.handoffs().some((h) => h.nodeId === nodeId && h.state === "offered"), "the offer to arrive");
	await to.collab.accept(nodeId);
	await until(() => to.host.node(nodeId)?.owner === to.host.owner, "the new owner to take over");
	await until(() => from.host.node(nodeId)?.owner === to.host.owner, "the old owner to let go");
};

describe("a team", () => {
	it("lets in whoever holds the team's secret, with nothing for anyone to approve, and says who joined", async () => {
		const { yan, sam } = await pair();
		expect(sam.host.nodes().map((n) => [n.name, n.owner]).sort()).toEqual([["checkout", "yan"], ["impl", "yan"]]);
		expect(yan.collab.people().map((p) => [p.name, p.trust, p.online])).toEqual([["yan", "trusted", true], ["sam", "trusted", true]]);
		expect(yan.collab.people().find((p) => p.name === "sam")?.fingerprint).toBe(sam.collab.people().find((p) => p.self)?.fingerprint);
		expect(yan.logs).toContain("sam joined team.");
		expect(sam.logs).toContain("yan joined team.");
	});

	it("keeps out someone without the team's secret, and tells them nothing", async () => {
		const { yan, code } = await pair();
		const outsider = seat("kim", code, undefined, teamOf("team")); // knows where yan is, and holds another secret
		await outsider.collab.start();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(outsider.collab.isOnline("yan")).toBe(false);
		expect(outsider.host.nodes()).toEqual([]);
		expect(yan.collab.people().map((p) => p.name)).toEqual(["yan", "sam"]);
	});

	it("connects hosts only when they are working on the same thing", async () => {
		const scoped = (name: string, scope: string, code?: string) => {
			const dir = join(root, `${name}-${scope}`);
			const collab = new CollabSession({
				host: new FakeHost(name), identity: Identity.loadOrCreate(join(root, name, "keys"), name), peers: new PeerBook(join(root, name, "people.json")), network: TEAM,
				transport: new TcpTransport({ host: "127.0.0.1", port: 0 }), dir: join(dir, "collab"), projectDir: dir, advertise: "127.0.0.1", redialMs: 0, scope,
			});
			enrol(collab, name, scope, code);
			sessions.push(collab);
			return collab;
		};
		const yan = scoped("yan", "repo-a");
		await yan.start();
		const elsewhere = scoped("sam", "repo-b", whereIs(yan));
		await elsewhere.start();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(elsewhere.isOnline("yan")).toBe(false);
		const here = scoped("sam", "repo-a", whereIs(yan));
		await here.start();
		await until(() => here.isOnline("yan") && yan.isOnline("sam"), "the hosts for the same repository to connect");
	});

	it("shares one list of people between all of a person's hosts", async () => {
		const { sam } = await pair();
		const other = new PeerBook(join(sam.dir, "people.json")); // sam's host for another repository
		expect(other.list().map((p) => p.name)).toEqual(["yan"]);
		expect(other.learn("kim", "a-key")).toBe(true);
		expect(other.learn("kim", "another-key")).toBe(false); // the first key seen stays
		await until(() => sam.collab.people().some((p) => p.name === "kim"), "sam's first host to see who the second one met");
		expect(other.keyOf("kim")).toBe("a-key");
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
		const { yan, sam, kid, code } = await pair();
		await sam.collab.stop();
		await until(() => !yan.collab.isOnline("sam"), "yan to notice sam left");
		expect(yan.collab.people().find((p) => p.name === "sam")?.online).toBe(false);

		const back = seat("sam", code); // same key and people, new process
		await back.collab.start();
		await until(() => back.collab.isOnline("yan"), "sam to reconnect");
		await until(() => back.host.node(kid.id), "the tree to be fetched again");
		expect(yan.collab.isOnline("sam")).toBe(true);
	});

	it("refuses someone using a known name with a different key, even with the secret, until the human accepts it", async () => {
		const { yan, sam, code } = await pair();
		await sam.collab.stop();
		await until(() => !yan.collab.isOnline("sam"));
		const impostor = seat("sam", code, "impostor");
		await impostor.collab.start();
		await until(() => yan.collab.people().find((p) => p.name === "sam")?.trust === "changed", "the changed key to be flagged");
		expect(yan.collab.isOnline("sam")).toBe(false);
		expect(impostor.host.nodes()).toEqual([]);
		expect(yan.logs.join("\n")).toContain("with a different key");

		await yan.collab.trustPerson("sam"); // sam really did get a new machine
		impostor.collab.heardAt("yan", yan.collab.listening(), true);
		await until(() => impostor.collab.isOnline("yan"), "sam's new machine to get in");
		expect(yan.collab.people().find((p) => p.name === "sam")).toMatchObject({ trust: "trusted", online: true });
	});
});

describe("handoff", () => {
	it("moves a node once its owner offers it and the other person accepts", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1, "sam to see the offer");
		expect(sam.collab.handoffs()).toMatchObject([{ nodeId: kid.id, from: "yan", to: "sam", state: "offered", role: "recipient" }]);
		expect(yan.host.node(kid.id)?.owner).toBe("yan"); // offered, not yet gone
		await expect(yan.collab.confirm(kid.id)).rejects.toThrow(/has not accepted yet/);

		await sam.collab.accept(kid.id);
		await until(() => sam.host.node(kid.id)?.owner === "sam", "sam to take over");
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "sam", version: 2 });
		expect(yan.host.slept).toContain(kid.id);
		expect(sam.host.node(kid.id)).toMatchObject({ version: 2, cwd: join(root, "sam", "project") });
		await until(() => yan.collab.pendingTransfers().length === 0);
		expect([yan.collab.handoffs(), sam.collab.handoffs()]).toEqual([[], []]);
	});

	it("refuses to offer to someone outside the network, and to offer what is not yours", async () => {
		const { yan, sam, kid } = await pair();
		await expect(yan.collab.offer(kid.id, "kim")).rejects.toThrow(/Nobody called "kim" is in team/);
		await expect(sam.collab.offer(kid.id, "yan")).rejects.toThrow(/only its owner can offer it/);
	});

	it("lets the recipient decline and the owner withdraw, leaving the owner in place", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await sam.collab.cancel(kid.id);
		expect(yan.collab.handoffs()).toEqual([]);

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

	it("needs the owner online to accept", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await yan.collab.stop();
		await until(() => !sam.collab.isOnline("yan"));
		await expect(sam.collab.accept(kid.id)).rejects.toThrow(/yan is offline/);
	});

	it("does not send a session away while its owner has it open, and sends it when they leave", async () => {
		const { yan, sam, kid } = await pair();
		yan.host.open.add(kid.id);
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await sam.collab.accept(kid.id);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(yan.collab.handoffs()).toMatchObject([{ state: "accepted", role: "owner" }]);
		expect(yan.host.node(kid.id)?.owner).toBe("yan");
		await expect(yan.collab.confirm(kid.id)).rejects.toThrow(/open in a terminal/);

		yan.host.open.delete(kid.id);
		await yan.collab.settle(); // what the timer does
		await until(() => sam.host.node(kid.id)?.owner === "sam", "the session to go once it is left");
	});

	it("keeps a released session until the new owner confirms receiving it, and sends it again", async () => {
		const { yan, sam, kid } = await pair();
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		sam.host.failNextAdoption = true; // the first delivery fails on sam's side
		await sam.collab.accept(kid.id);
		await until(() => yan.host.node(kid.id)?.owner === "sam", "the release to be committed");
		await until(() => yan.logs.join("\n").includes("has not reached them yet"), "the failed delivery to be noticed");

		expect(yan.collab.pendingTransfers()).toEqual([{ nodeId: kid.id, to: "sam" }]); // the package is kept
		expect(sam.host.node(kid.id)?.owner).toBe("yan");

		await yan.collab.refresh(); // any later contact retries
		await until(() => sam.host.node(kid.id)?.owner === "sam", "the retry to land");
		expect(yan.collab.pendingTransfers()).toEqual([]);
	});

	it("can hand a node back", async () => {
		const { yan, sam, kid } = await pair();
		await handOver(yan, sam, kid.id);
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

describe("asking for a session", () => {
	it("moves it as soon as its owner approves, with nothing more for the asker to do", async () => {
		const { yan, sam, kid } = await pair();
		await sam.collab.ask(kid.id);
		expect(sam.collab.requests()).toMatchObject([{ nodeId: kid.id, from: "sam", to: "yan", role: "asker" }]);
		expect(yan.collab.requests()).toMatchObject([{ nodeId: kid.id, nodeName: "impl", from: "sam", to: "yan", role: "owner" }]);
		expect(yan.logs).toContain('sam asks to take over "impl".');
		expect(yan.host.node(kid.id)?.owner).toBe("yan"); // asking moves nothing

		await yan.collab.approve(kid.id, "sam");
		await until(() => sam.host.node(kid.id)?.owner === "sam", "the session to become sam's");
		await until(() => yan.host.node(kid.id)?.owner === "sam");
		expect(sam.host.node(kid.id)).toMatchObject({ version: 2 });
		expect([yan.collab.requests(), sam.collab.requests()]).toEqual([[], []]);
	});

	it("leaves everything as it was when the owner declines, and tells the asker", async () => {
		const { yan, sam, kid } = await pair();
		await sam.collab.ask(kid.id);
		await yan.collab.decline(kid.id, "sam");
		await until(() => sam.collab.requests().length === 0, "sam to hear the no");
		expect(sam.logs).toContain('yan declined to hand over "impl".');
		expect(yan.collab.requests()).toEqual([]);
		expect(yan.host.node(kid.id)).toMatchObject({ owner: "yan", version: 1 });
		// A later offer is an ordinary offer: sam is asked, not assumed.
		await yan.collab.offer(kid.id, "sam");
		await until(() => sam.collab.handoffs().length === 1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sam.host.node(kid.id)?.owner).toBe("yan");
	});

	it("can be withdrawn, and cannot be approved after that", async () => {
		const { yan, sam, kid } = await pair();
		await sam.collab.ask(kid.id);
		await sam.collab.withdraw(kid.id);
		expect([yan.collab.requests(), sam.collab.requests()]).toEqual([[], []]);
		await expect(yan.collab.approve(kid.id, "sam")).rejects.toThrow(/sam is not asking/);
	});

	it("is refused for your own session, and while its owner is away", async () => {
		const { yan, sam, kid } = await pair();
		await expect(yan.collab.ask(kid.id)).rejects.toThrow(/already yours/);
		await yan.collab.stop();
		await until(() => !sam.collab.isOnline("yan"));
		await expect(sam.collab.ask(kid.id)).rejects.toThrow(/yan is offline/);
		expect(sam.collab.requests()).toEqual([]);
	});

	it("is granted when the asker comes back, if the owner approved while they were away", async () => {
		const { yan, sam, kid, code } = await pair();
		await sam.collab.ask(kid.id);
		await sam.collab.stop();
		await until(() => !yan.collab.isOnline("sam"));
		await yan.collab.approve(kid.id, "sam");
		expect(yan.host.node(kid.id)?.owner).toBe("yan");

		const back = seat("sam", code);
		await back.collab.start();
		await until(() => back.host.node(kid.id)?.owner === "sam", "the session to arrive once sam is back");
	});

	it("expires like an offer does", async () => {
		const { yan, sam, kid } = await pair();
		await sam.collab.ask(kid.id);
		clock += 61_000;
		expect([yan.collab.requests(), sam.collab.requests()]).toEqual([[], []]);
	});
});

describe("everything everyone has running", () => {
	/** One of a person's hosts, for one repository. A person's hosts share their keys, their people and what each says it has running. */
	const hostFor = (name: string, repo: string, code?: string) => {
		const person = join(root, name);
		const dir = join(person, repo);
		const host = new FakeHost(name);
		const logs: string[] = [];
		const collab = new CollabSession({
			host, identity: Identity.loadOrCreate(join(person, "keys"), name), peers: new PeerBook(join(person, "people.json")), network: TEAM,
			transport: new TcpTransport({ host: "127.0.0.1", port: 0 }), dir: join(dir, "collab"), projectDir: dir, advertise: "127.0.0.1", redialMs: 0, requestTimeoutMs: 5000, now: () => clock,
			scope: `git:${repo}`, repo: { name: repo, url: `git@example.com:team/${repo}.git` }, directoryDir: join(person, "summaries"), followMs: 20,
		});
		enrol(collab, name, `git:${repo}`, code);
		sessions.push(collab);
		collab.on("log", (_level, message) => logs.push(message));
		return { host, collab, logs };
	};
	const names = (seat: { collab: CollabSession }) => seat.collab.elsewhere().map((tree) => `${tree.owner}/${tree.repo}: ${tree.nodes.map((node) => node.name).join(" ")}`);

	it("shows a teammate's sessions in a repository this person does not have, with where to clone it", async () => {
		const yan = hostFor("yan", "shop");
		yan.host.add("checkout");
		await yan.collab.start();
		const sam = hostFor("sam", "api", whereIs(yan.collab));
		sam.host.add("auth-rework");
		await sam.collab.start();

		await until(() => names(yan).length === 1 && names(sam).length === 1, "each to hear what the other has running");
		expect(names(yan)).toEqual(["sam/api: auth-rework"]);
		expect(names(sam)).toEqual(["yan/shop: checkout"]);
		expect(sam.collab.elsewhere()[0]).toMatchObject({ scope: "git:shop", url: "git@example.com:team/shop.git", online: true });
		// They can see each other, and each knows the other is not here: nothing can be handed over between repositories.
		expect(sam.collab.people().find((p) => p.name === "yan")).toMatchObject({ online: true, here: false });
		expect(sam.collab.isOnline("yan")).toBe(false);
		expect(sam.host.nodes().map((n) => n.name)).toEqual(["auth-rework"]); // and nothing of yan's is in sam's own tree

		// A new session shows up without anyone asking.
		yan.host.add("billing");
		await until(() => names(sam)[0] === "yan/shop: checkout billing", "the new session to appear for sam");
	});

	it("lets any one of a person's hosts answer for all of them, and reads a session from the host that has it", async () => {
		const shop = hostFor("yan", "shop");
		shop.host.add("checkout");
		await shop.collab.start();
		const api = hostFor("yan", "api"); // yan's host for another repository
		const auth = api.host.add("auth-rework");
		api.host.conversations.set(auth.id, [{ role: "user", content: "rotate the keys" }]);
		await api.collab.start();

		// Sam works in a third repository and was only told where yan's shop host is.
		const sam = hostFor("sam", "infra", whereIs(shop.collab));
		await sam.collab.start();
		await until(() => names(sam).length === 2, "sam to hear of both of yan's repositories");
		expect(names(sam)).toEqual(["yan/api: auth-rework", "yan/shop: checkout"]);
		expect(await sam.collab.fetchMessages(auth.id)).toEqual([{ role: "user", content: "rotate the keys" }]);
		await expect(sam.collab.fetchMessages("nd_missing")).rejects.toThrow(/No session/);
	});

	it("leads a host to a teammate's host for the same repository when it was told of another", async () => {
		const shop = hostFor("yan", "shop");
		const api = hostFor("yan", "api");
		const kid = api.host.add("auth-rework");
		await shop.collab.start();
		await api.collab.start();
		const sam = hostFor("sam", "api", whereIs(shop.collab)); // told of yan's shop host, not the api one
		await sam.collab.start();
		await until(() => sam.collab.isOnline("yan"), "sam's api host to find yan's api host");
		await until(() => sam.host.node(kid.id), "yan's api sessions to join sam's tree");
		expect(names(sam)).toEqual([]); // nothing of yan's is elsewhere, from where sam stands: shop has no sessions, api is here
	});

	it("keeps what a teammate had running as last heard when they go, marked as away", async () => {
		const yan = hostFor("yan", "shop");
		yan.host.add("checkout");
		await yan.collab.start();
		const code = whereIs(yan.collab);
		const sam = hostFor("sam", "api", code);
		await sam.collab.start();
		await until(() => names(sam).length === 1);
		await yan.collab.stop();
		await until(() => sam.collab.elsewhere()[0]?.online === false, "sam to see yan go");
		expect(names(sam)).toEqual(["yan/shop: checkout"]);
		await sam.collab.stop();
		const again = hostFor("sam", "api", code); // after a restart it is still there to look at
		expect(names(again)).toEqual(["yan/shop: checkout"]);
	});

	it("does not let someone working elsewhere do more than look", async () => {
		const yan = hostFor("yan", "shop");
		const top = yan.host.add("checkout");
		await yan.collab.start();
		const sam = hostFor("sam", "api", whereIs(yan.collab));
		await sam.collab.start();
		await until(() => names(sam).length === 1);
		await expect(sam.collab.ask(top.id)).rejects.toThrow(/No node/);
		await expect(yan.collab.offer(top.id, "sam")).resolves.toBeUndefined(); // an offer waits for sam to have the repository
		expect(sam.collab.handoffs()).toEqual([]);
	});
});

describe("watching a teammate's session", () => {
	it("sends what is new while someone is watching, and stops when they stop", async () => {
		const { yan, sam, kid } = await pair();
		const said = (text: string) => ({ role: "assistant", content: text });
		yan.host.conversations.set(kid.id, [said("one")]);
		expect(await sam.collab.follow(kid.id)).toEqual([said("one")]);

		let news = 0;
		sam.collab.on("changed", () => news++);
		yan.host.conversations.set(kid.id, [said("one"), said("two")]);
		await until(async () => (await sam.collab.follow(kid.id)).length === 2, "the new message to arrive unasked");
		expect(news).toBeGreaterThan(0); // the pane is told to look again
		expect(await sam.collab.follow(kid.id)).toEqual([said("one"), said("two")]);

		// A conversation that was rewound is sent whole.
		yan.host.conversations.set(kid.id, [said("again")]);
		await until(async () => (await sam.collab.follow(kid.id)).length === 1, "the rewound conversation");
		expect(await sam.collab.follow(kid.id)).toEqual([said("again")]);

		// Nobody looks for a while: the owner stops sending, and a later look catches up.
		clock += 30_000;
		await new Promise((resolve) => setTimeout(resolve, 60));
		yan.host.conversations.set(kid.id, [said("again"), said("while you were away")]);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(await sam.collab.follow(kid.id)).toEqual([said("again"), said("while you were away")]);
	});

	it("refuses to watch what is not there", async () => {
		const { yan, sam, kid } = await pair();
		await expect(yan.collab.follow(kid.id)).rejects.toThrow(/yours/);
		await yan.collab.stop();
		await until(() => !sam.collab.isOnline("yan"));
		await expect(sam.collab.follow(kid.id)).rejects.toThrow(/yan is offline/);
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

		const back = seat("sam", whereIs(yan.collab));
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
					host: new FakeHost("yan"), identity: Identity.loadOrCreate(join(dir, "keys"), "sam"), peers: new PeerBook(join(dir, "people.json")), network: TEAM,
					transport: new TcpTransport({ host: "127.0.0.1" }), dir: join(dir, "collab"), projectDir: dir,
				}),
		).toThrow(/must match the host owner/);
	});
});
