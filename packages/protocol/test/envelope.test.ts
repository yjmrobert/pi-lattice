import { describe, expect, it } from "vitest";
import { createEnvelope, isAddress, isId, newNodeId, PROTOCOL_VERSION, validateEnvelope } from "../src/index.ts";

const from = newNodeId();
const to = newNodeId();
const base = () => createEnvelope({ from, fromOwner: "yan", to, text: "hello", seq: 1 });

describe("ids", () => {
	it("are valid, unique and sort by creation time", () => {
		const a = newNodeId(1000);
		const b = newNodeId(2000);
		expect(isId(a)).toBe(true);
		expect(a < b).toBe(true);
		expect(newNodeId(1000)).not.toBe(a);
	});

	it("reject path-like and malformed values", () => {
		for (const bad of ["../etc", "nd_", "ND_ABC12345", "nd_abc/def12", "", 42, null]) expect(isId(bad)).toBe(false);
	});
});

describe("addresses", () => {
	it("accept node ids and tree-relative names only", () => {
		expect(isAddress(to)).toBe(true);
		expect(isAddress("parent")).toBe(true);
		expect(isAddress("children")).toBe(true);
		expect(isAddress("planner")).toBe(false);
	});
});

describe("createEnvelope", () => {
	it("starts a conversation with hops 0 and its own correlation id", () => {
		const e = base();
		expect(e.v).toBe(PROTOCOL_VERSION);
		expect(e.correlationId).toBe(e.id);
		expect(e.hops).toBe(0);
		expect(e.intent).toBe("inform");
		expect(e.causationId).toBeUndefined();
	});

	it("carries correlation, causation and hop count through replies", () => {
		const first = base();
		const reply = createEnvelope({ from: to, fromOwner: "yan", to: from, text: "re", seq: 1, inReplyTo: first });
		const again = createEnvelope({ from, fromOwner: "yan", to, text: "re re", seq: 2, inReplyTo: reply });
		expect(reply.correlationId).toBe(first.id);
		expect(reply.causationId).toBe(first.id);
		expect(reply.hops).toBe(1);
		expect(again.correlationId).toBe(first.id);
		expect(again.hops).toBe(2);
	});

	it("counts a hop for a send caused by, but not replying to, an inbound envelope", () => {
		const inbound = { ...base(), hops: 3 };
		const e = createEnvelope({ from: to, fromOwner: "yan", to: "parent", text: "fyi", seq: 1, causedBy: inbound });
		expect(e.hops).toBe(4);
		expect(e.correlationId).toBe(e.id);
		expect(e.causationId).toBe(inbound.id);
	});
});

describe("validateEnvelope", () => {
	it("accepts a well-formed envelope", () => {
		expect(validateEnvelope(base()).ok).toBe(true);
	});

	it("survives a JSON round trip", () => {
		expect(validateEnvelope(JSON.parse(JSON.stringify(base()))).ok).toBe(true);
	});

	it("tolerates unknown fields and unknown intents", () => {
		expect(validateEnvelope({ ...base(), futureField: 1, intent: "negotiate" }).ok).toBe(true);
	});

	it("rejects a newer protocol version with a clear message", () => {
		const result = validateEnvelope({ ...base(), v: PROTOCOL_VERSION + 1 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]).toContain("unsupported protocol version");
	});

	it("rejects non-objects and missing fields", () => {
		expect(validateEnvelope("nope").ok).toBe(false);
		expect(validateEnvelope(null).ok).toBe(false);
		const { payload: _payload, ...rest } = base();
		expect(validateEnvelope(rest).ok).toBe(false);
	});

	it("rejects ids that could escape a spool directory", () => {
		expect(validateEnvelope({ ...base(), id: "../../x" }).ok).toBe(false);
		expect(validateEnvelope({ ...base(), from: "/etc/passwd" }).ok).toBe(false);
		expect(validateEnvelope({ ...base(), to: "somebody" }).ok).toBe(false);
	});

	it("enforces the hop limit", () => {
		expect(validateEnvelope({ ...base(), hops: 9 }).ok).toBe(false);
		expect(validateEnvelope({ ...base(), hops: 9 }, { maxHops: 10 }).ok).toBe(true);
	});

	it("enforces the payload size limit", () => {
		const big = { ...base(), payload: { text: "x".repeat(70 * 1024) } };
		expect(validateEnvelope(big).ok).toBe(false);
		expect(validateEnvelope(big, { maxPayloadBytes: 128 * 1024 }).ok).toBe(true);
	});

	it("rejects an unparseable creation time", () => {
		expect(validateEnvelope({ ...base(), createdAt: "yesterday-ish" }).ok).toBe(false);
	});
});
