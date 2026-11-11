import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeaseEvent, NodeMeta } from "@pi-lattice/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { Identity } from "../src/identity.ts";
import { appendEvent, foldRecord, type KeyLookup, type NodeRecord, parseRecord, toSharedMeta } from "../src/ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-lattice-ledger-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const yan = Identity.loadOrCreate(dir, "yan");
const sam = Identity.loadOrCreate(dir, "sam");
const mallory = Identity.loadOrCreate(dir, "mallory");
const everyone: KeyLookup = (name) => ({ yan: yan.publicKey, sam: sam.publicKey, mallory: mallory.publicKey })[name];
const onlyYan: KeyLookup = (name) => (name === "yan" ? yan.publicKey : undefined);

const T0 = 1_000_000;
const node: NodeMeta = {
	id: "nd_0000000000aaaaaaaaaa", parentId: null, rootId: "nd_0000000000aaaaaaaaaa", kind: "task", name: "impl", brief: "b", fragments: ["worker"], owner: "yan", version: 1,
	status: "idle", sessionId: "s", sessionFile: "/secret/path.jsonl", cwd: "/home/yan/secret", workspace: "shared", branch: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "x",
};
const fresh = (): NodeRecord => ({ genesis: yan.sign({ nodeId: node.id, owner: "yan", at: "2026-01-01T00:00:00.000Z" }), meta: yan.sign(toSharedMeta(node)), events: [] });
const offer: LeaseEvent = { type: "offer", id: "ho_1", by: "yan", to: "sam", expectedVersion: 1, expiresAt: T0 + 1000, now: T0 };
const accept: LeaseEvent = { type: "accept", id: "ho_1", by: "sam", now: T0 + 1 };
const confirm: LeaseEvent = { type: "confirm", id: "ho_1", by: "yan", now: T0 + 2 };
/** Append, failing the test if refused. */
const add = (record: NodeRecord, who: Identity, event: LeaseEvent, keys = everyone): NodeRecord => {
	const result = appendEvent(record, who.sign(event), keys, T0 + 5);
	if (!result.ok) throw new Error(result.error);
	return result.record;
};

describe("shared metadata", () => {
	it("never includes local paths or session files", () => {
		const shared = toSharedMeta(node) as Record<string, unknown>;
		expect(Object.keys(shared).sort()).toEqual(["branch", "brief", "createdAt", "fragments", "id", "kind", "name", "parentId", "rootId", "status", "workspace"]);
		expect(toSharedMeta({ ...node, repo: "shop" }).repo).toBe("shop");
		expect(JSON.stringify(shared)).not.toContain("secret");
	});
});

describe("foldRecord", () => {
	it("starts with the creator as owner at version 1", () => {
		expect(foldRecord(fresh(), everyone, T0)).toMatchObject({ valid: true, ownership: { owner: "yan", version: 1 }, metaTrusted: true });
	});

	it("flips ownership only after a fully signed offer, accept and confirm", () => {
		let record = add(fresh(), yan, offer);
		expect(foldRecord(record, everyone, T0 + 5).ownership).toMatchObject({ owner: "yan", handoff: { state: "offered" } });
		record = add(record, sam, accept);
		expect(foldRecord(record, everyone, T0 + 5).ownership).toMatchObject({ owner: "yan", handoff: { state: "accepted" } });
		record = add(record, yan, confirm);
		expect(foldRecord(record, everyone, T0 + 5).ownership).toEqual({ owner: "sam", version: 2, lastHandoffId: "ho_1" });
	});

	it("does not believe a record whose creator is not trusted", () => {
		const folded = foldRecord({ ...fresh(), genesis: mallory.sign({ nodeId: node.id, owner: "mallory", at: "x" }) }, onlyYan, T0);
		expect(folded).toMatchObject({ valid: false, unverified: ["mallory"] });
	});

	it("rejects a genesis signed by someone other than the claimed owner", () => {
		const forged = { ...fresh(), genesis: mallory.sign({ nodeId: node.id, owner: "yan", at: "x" }) };
		expect(foldRecord(forged, everyone, T0).valid).toBe(false);
	});

	it("stops at an event signed by an untrusted person, keeping the earlier state", () => {
		const record = add(add(fresh(), yan, offer), sam, accept);
		const folded = foldRecord(record, onlyYan, T0 + 5);
		expect(folded.ownership).toMatchObject({ owner: "yan", handoff: { state: "offered" } });
		expect(folded.unverified).toEqual(["sam"]);
	});

	it("ignores an acceptance forged in the recipient's name", () => {
		const record = add(fresh(), yan, offer);
		const forged = { ...record, events: [...record.events, { ...mallory.sign(accept), by: "sam" }] };
		expect(foldRecord(forged, everyone, T0 + 5).ownership.handoff?.state).toBe("offered");
	});

	it("ignores an event whose signer differs from the actor it names", () => {
		const record = add(fresh(), yan, offer);
		const forged = { ...record, events: [...record.events, mallory.sign(accept)] };
		expect(foldRecord(forged, everyone, T0 + 5).ownership.handoff?.state).toBe("offered");
	});

	it("ignores a takeover attempt by someone who is not the owner", () => {
		const steal: LeaseEvent = { type: "offer", id: "ho_x", by: "mallory", to: "mallory", expectedVersion: 1, expiresAt: T0 + 1000, now: T0 };
		const forged = { ...fresh(), events: [mallory.sign(steal)] };
		expect(foldRecord(forged, everyone, T0 + 5)).toMatchObject({ ownership: { owner: "yan", version: 1 }, applied: 0 });
	});

	it("voids an offer that expired without being confirmed", () => {
		const record = add(add(fresh(), yan, offer), sam, accept);
		expect(foldRecord(record, everyone, T0 + 5000).ownership).toEqual({ owner: "yan", version: 1 });
	});

	it("distrusts metadata signed by someone who never owned the node", () => {
		const record = { ...fresh(), meta: mallory.sign({ ...toSharedMeta(node), name: "pwned" }) };
		expect(foldRecord(record, everyone, T0).metaTrusted).toBe(false);
	});

	it("accepts metadata from the previous owner right after a handoff, and from the new one", () => {
		const done = add(add(add(fresh(), yan, offer), sam, accept), yan, confirm);
		expect(foldRecord(done, everyone, T0 + 5).metaTrusted).toBe(true);
		expect(foldRecord({ ...done, meta: sam.sign(toSharedMeta(node)) }, everyone, T0 + 5).metaTrusted).toBe(true);
	});
});

describe("appendEvent", () => {
	it("refuses a stale-version offer after ownership moved", () => {
		const done = add(add(add(fresh(), yan, offer), sam, accept), yan, confirm);
		const result = appendEvent(done, yan.sign({ ...offer, id: "ho_2" }), everyone, T0 + 5);
		expect(result).toMatchObject({ ok: false });
	});

	it("treats a replayed step as a no-op, so a crash mid-handoff can be retried", () => {
		const record = add(fresh(), yan, offer);
		expect(appendEvent(record, yan.sign(offer), everyone, T0 + 5)).toMatchObject({ ok: true, changed: false });
		const done = add(add(record, sam, accept), yan, confirm);
		expect(appendEvent(done, yan.sign(confirm), everyone, T0 + 5)).toMatchObject({ ok: true, changed: false });
	});

	it("drops a forged tail instead of building on it", () => {
		const record = add(fresh(), yan, offer);
		const forged = { ...record, events: [...record.events, { ...mallory.sign(accept), by: "sam" }] };
		const result = appendEvent(forged, sam.sign(accept), everyone, T0 + 5);
		expect(result.ok && result.record.events).toHaveLength(2);
		expect(result.ok && foldRecord(result.record, everyone, T0 + 5).ownership.handoff?.state).toBe("accepted");
	});

	it("refuses to act on a record that depends on an untrusted person", () => {
		const record = add(add(fresh(), yan, offer), sam, accept);
		expect(appendEvent(record, yan.sign(confirm), onlyYan, T0 + 5)).toMatchObject({ ok: false });
	});
});

describe("parseRecord", () => {
	it("round-trips a record and rejects junk", () => {
		expect(parseRecord(JSON.stringify(fresh()))).toEqual(fresh());
		for (const bad of [undefined, "", "{", "{}", '{"genesis":{}}']) expect(parseRecord(bad)).toBeUndefined();
	});
});
