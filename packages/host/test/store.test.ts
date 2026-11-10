import { createEnvelope, type NodeMeta, newNodeId } from "@pi-lattice/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.ts";

let store: SqliteStore;
beforeEach(() => {
	store = new SqliteStore(":memory:");
});

const node = (over: Partial<NodeMeta> = {}): NodeMeta => {
	const id = over.id ?? newNodeId();
	return {
		id, parentId: null, rootId: id, kind: "feature", name: "root", brief: "do it", fragments: ["coordinator", "planning"], owner: "yan", version: 1,
		status: "dormant", sessionId: null, sessionFile: null, cwd: "/w", workspace: "shared", branch: null,
		createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
	};
};

describe("SqliteStore nodes", () => {
	it("round-trips a node, including its fragment list", () => {
		const n = node();
		store.insertNode(n);
		expect(store.getNode(n.id)).toEqual(n);
		expect(store.listNodes()).toEqual([n]);
	});

	it("applies a patch and stamps the update time", () => {
		const n = node();
		store.insertNode(n);
		const updated = store.updateNode(n.id, { status: "running", sessionId: "s1" });
		expect(updated).toMatchObject({ status: "running", sessionId: "s1", name: "root" });
		expect(updated.updatedAt).not.toBe(n.updatedAt);
		expect(store.getNode(n.id)).toEqual(updated);
	});

	it("refuses to update a node that does not exist", () => {
		expect(() => store.updateNode("nd_missing00000", { status: "idle" })).toThrow(/no node/);
	});

	it("lists nodes in creation order", () => {
		const second = node({ createdAt: "2026-01-02T00:00:00.000Z", name: "second" });
		const first = node({ createdAt: "2026-01-01T00:00:00.000Z", name: "first" });
		store.insertNode(second);
		store.insertNode(first);
		expect(store.listNodes().map((n) => n.name)).toEqual(["first", "second"]);
	});
});

describe("SqliteStore journal", () => {
	const a = newNodeId();
	const b = newNodeId();
	const c = newNodeId();
	const envelope = (text: string, now: number) => createEnvelope({ from: a, fromOwner: "yan", to: "children", text, seq: 1, now });

	it("keeps an envelope queued for each recipient until that recipient acknowledges it", () => {
		const e = envelope("fan out", 1000);
		store.journal(e, b);
		store.journal(e, c);
		store.journal(e, b); // routed twice: still one record
		expect(store.unacked(b)).toEqual([e]);
		store.markAcked(e.id, b);
		expect(store.unacked(b)).toEqual([]);
		expect(store.unacked(c)).toEqual([e]);
	});

	it("returns queued envelopes oldest first", () => {
		store.journal(envelope("second", 2000), b);
		store.journal(envelope("first", 1000), b);
		expect(store.unacked(b).map((e) => e.payload.text)).toEqual(["first", "second"]);
	});

	it("tracks the recipient's mailbox state and filters on it", () => {
		const held = envelope("held", 1000);
		const seen = envelope("seen", 2000);
		store.journal(held, b);
		store.journal(seen, b);
		store.setMailState(held.id, b, "pending");
		store.setMailState(seen.id, b, "delivered");
		expect(store.traffic({ mailState: "pending" }).map((r) => r.envelope.payload.text)).toEqual(["held"]);
		expect(store.traffic().map((r) => r.envelope.payload.text)).toEqual(["seen", "held"]);
		expect(store.traffic({ node: c })).toEqual([]);
		expect(store.traffic({ node: a, limit: 1 })).toHaveLength(1);
	});
});
