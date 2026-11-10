import { describe, expect, it } from "vitest";
import { type InboundAction, type InboundState, INBOUND_STATES, requiresApproval, transitionInbound } from "../src/index.ts";

const run = (start: InboundState, ...actions: InboundAction[]) => {
	let state = start;
	for (const action of actions) {
		const result = transitionInbound(state, action);
		if (!result.ok) return result;
		state = result.state;
	}
	return { ok: true as const, state };
};

describe("inbound state machine", () => {
	it("delivers directly when no approval is needed", () => {
		expect(run("received", "deliver")).toEqual({ ok: true, state: "delivered" });
	});

	it("holds, approves, then delivers", () => {
		expect(run("received", "hold", "approve", "deliver")).toEqual({ ok: true, state: "delivered" });
	});

	it("holds then rejects, and rejection is final", () => {
		expect(run("received", "hold", "reject")).toEqual({ ok: true, state: "rejected" });
		expect(transitionInbound("rejected", "approve").ok).toBe(false);
		expect(transitionInbound("rejected", "deliver").ok).toBe(false);
	});

	it("never delivers a pending message without approval", () => {
		expect(transitionInbound("pending", "deliver").ok).toBe(false);
	});

	it("cannot reject after delivery", () => {
		expect(transitionInbound("delivered", "reject").ok).toBe(false);
	});

	it("treats a repeated action as a no-op", () => {
		for (const [state, action] of [
			["pending", "hold"],
			["approved", "approve"],
			["delivered", "approve"],
			["rejected", "reject"],
			["delivered", "deliver"],
		] as const) {
			expect(transitionInbound(state, action)).toEqual({ ok: true, state, changed: false });
		}
	});

	it("has no transition out of a terminal state", () => {
		for (const terminal of ["rejected", "delivered"] as const) {
			for (const action of ["hold", "approve", "reject", "deliver"] as const) {
				const result = transitionInbound(terminal, action);
				if (result.ok) expect(result.state).toBe(terminal);
			}
		}
		expect(INBOUND_STATES).toHaveLength(5);
	});
});

describe("approval policy", () => {
	const input = { senderOwner: "sam", recipientOwner: "yan", senderNode: "nd_remote0001" };

	it("cross-owner approves only mail from another owner", () => {
		expect(requiresApproval({ ...input, policy: "cross-owner" })).toBe(true);
		expect(requiresApproval({ ...input, policy: "cross-owner", senderOwner: "yan" })).toBe(false);
	});

	it("cross-owner honours deliberately trusted senders", () => {
		expect(requiresApproval({ ...input, policy: "cross-owner", trustedSenders: ["nd_remote0001"] })).toBe(false);
		expect(requiresApproval({ ...input, policy: "cross-owner", trustedSenders: ["nd_other00001"] })).toBe(true);
	});

	it("always and never ignore ownership and trust", () => {
		expect(requiresApproval({ ...input, policy: "always", senderOwner: "yan", trustedSenders: ["nd_remote0001"] })).toBe(true);
		expect(requiresApproval({ ...input, policy: "never" })).toBe(false);
	});
});
