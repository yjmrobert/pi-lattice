import { describe, expect, it } from "vitest";
import { checkWrite, initialOwnership, type LeaseEvent, type Ownership, transitionLease } from "../src/index.ts";

const T0 = 1_000_000;
const EXP = T0 + 60_000;
const offer = (over: Partial<Extract<LeaseEvent, { type: "offer" }>> = {}): LeaseEvent => ({
	type: "offer", id: "ho_1", by: "yan", to: "sam", expectedVersion: 1, expiresAt: EXP, now: T0, ...over,
});
const accept = (over: Partial<Extract<LeaseEvent, { type: "accept" }>> = {}): LeaseEvent => ({ type: "accept", id: "ho_1", by: "sam", now: T0 + 1, ...over });
const confirm = (over: Partial<Extract<LeaseEvent, { type: "confirm" }>> = {}): LeaseEvent => ({ type: "confirm", id: "ho_1", by: "yan", now: T0 + 2, ...over });
const cancel = (over: Partial<Extract<LeaseEvent, { type: "cancel" }>> = {}): LeaseEvent => ({ type: "cancel", id: "ho_1", by: "yan", now: T0 + 2, ...over });

/** Apply events, failing the test on any rejection. */
function apply(start: Ownership, ...events: LeaseEvent[]): Ownership {
	let current = start;
	for (const event of events) {
		const result = transitionLease(current, event);
		if (!result.ok) throw new Error(`${event.type} rejected: ${result.code}`);
		current = result.ownership;
	}
	return current;
}
const code = (current: Ownership, event: LeaseEvent) => {
	const result = transitionLease(current, event);
	return result.ok ? "ok" : result.code;
};

const start = initialOwnership("yan");

describe("handoff happy path", () => {
	it("flips the owner and increments the version only after offer, accept and confirm", () => {
		const offered = apply(start, offer());
		expect(offered).toMatchObject({ owner: "yan", version: 1, handoff: { state: "offered", to: "sam" } });
		const accepted = apply(offered, accept());
		expect(accepted).toMatchObject({ owner: "yan", version: 1, handoff: { state: "accepted" } });
		const done = apply(accepted, confirm());
		expect(done).toEqual({ owner: "sam", version: 2, lastHandoffId: "ho_1" });
	});

	it("can be handed back afterwards under the new version", () => {
		const done = apply(start, offer(), accept(), confirm());
		const back = apply(
			done,
			offer({ id: "ho_2", by: "sam", to: "yan", expectedVersion: 2 }),
			accept({ id: "ho_2", by: "yan" }),
			confirm({ id: "ho_2", by: "sam" }),
		);
		expect(back).toEqual({ owner: "yan", version: 3, lastHandoffId: "ho_2" });
	});
});

describe("handoff guards", () => {
	it("rejects an offer from a non-owner", () => {
		expect(code(start, offer({ by: "sam", to: "kim" }))).toBe("not-owner");
	});

	it("rejects an offer carrying a stale version", () => {
		const done = apply(start, offer(), accept(), confirm());
		expect(code(done, offer({ id: "ho_2", by: "sam", to: "kim", expectedVersion: 1 }))).toBe("stale-version");
	});

	it("rejects handing a node to yourself and already-expired offers", () => {
		expect(code(start, offer({ to: "yan" }))).toBe("self-handoff");
		expect(code(start, offer({ expiresAt: T0 }))).toBe("expired");
	});

	it("rejects a second offer while one is open", () => {
		expect(code(apply(start, offer()), offer({ id: "ho_2", to: "kim" }))).toBe("handoff-in-progress");
	});

	it("rejects acceptance by anyone but the named recipient", () => {
		expect(code(apply(start, offer()), accept({ by: "kim" }))).toBe("not-recipient");
	});

	it("rejects confirm before acceptance, and confirm by the recipient", () => {
		expect(code(apply(start, offer()), confirm())).toBe("not-accepted");
		expect(code(apply(start, offer(), accept()), confirm({ by: "sam" }))).toBe("not-owner");
	});

	it("rejects accept and confirm for an unknown handoff", () => {
		expect(code(start, accept())).toBe("no-such-handoff");
		expect(code(apply(start, offer()), confirm({ id: "ho_other" }))).toBe("no-such-handoff");
	});
});

describe("expiry and cancel", () => {
	it("voids an offer that is not accepted in time", () => {
		const offered = apply(start, offer());
		expect(code(offered, accept({ now: EXP }))).toBe("expired");
		expect(apply(offered, { type: "expire", now: EXP })).toEqual(start);
	});

	it("voids an accepted handoff that is not confirmed in time", () => {
		const accepted = apply(start, offer(), accept());
		expect(code(accepted, confirm({ now: EXP + 1 }))).toBe("expired");
		expect(apply(accepted, { type: "expire", now: EXP + 1 })).toEqual(start);
	});

	it("does not expire early", () => {
		const offered = apply(start, offer());
		expect(apply(offered, { type: "expire", now: EXP - 1 })).toEqual(offered);
	});

	it("lets a new offer replace an expired one", () => {
		const replaced = apply(apply(start, offer()), offer({ id: "ho_2", to: "kim", now: EXP + 5, expiresAt: EXP + 1000 }));
		expect(replaced.handoff).toMatchObject({ id: "ho_2", to: "kim" });
	});

	it("lets either participant cancel before the flip, and nobody else", () => {
		const accepted = apply(start, offer(), accept());
		expect(apply(accepted, cancel())).toEqual(start);
		expect(apply(accepted, cancel({ by: "sam" }))).toEqual(start);
		expect(code(accepted, cancel({ by: "kim" }))).toBe("not-participant");
	});

	it("cannot cancel a completed handoff", () => {
		expect(code(apply(start, offer(), accept(), confirm()), cancel())).toBe("already-completed");
	});

	it("rejects accept after cancel", () => {
		expect(code(apply(start, offer(), cancel()), accept())).toBe("no-such-handoff");
	});
});

describe("crash mid-handoff: every step can be replayed", () => {
	const steps = [offer(), accept(), confirm()];

	it("replaying the last applied step at any point changes nothing", () => {
		let current = start;
		for (const step of steps) {
			current = apply(current, step);
			const replay = transitionLease(current, step);
			expect(replay).toEqual({ ok: true, ownership: current, changed: false });
		}
	});

	it("a duplicated event stream converges to the same result as a clean one", () => {
		const clean = apply(start, ...steps);
		const noisy = apply(start, offer(), offer(), accept(), accept(), confirm(), confirm(), accept());
		expect(noisy).toEqual(clean);
	});

	it("a crash before confirm leaves the original owner in place", () => {
		const stalled = apply(start, offer(), accept());
		expect(stalled.owner).toBe("yan");
		expect(checkWrite(stalled, "yan", 1).ok).toBe(true);
		expect(checkWrite(stalled, "sam", 1).ok).toBe(false);
	});

	it("a cancel replayed after it applied is a no-op", () => {
		const cancelled = apply(start, offer(), cancel());
		expect(transitionLease(cancelled, cancel())).toEqual({ ok: true, ownership: cancelled, changed: false });
	});
});

describe("write guard", () => {
	it("rejects the previous owner and stale versions after a handoff", () => {
		const done = apply(start, offer(), accept(), confirm());
		expect(checkWrite(done, "sam", 2)).toEqual({ ok: true });
		expect(checkWrite(done, "yan", 1)).toMatchObject({ ok: false, code: "stale-version" });
		expect(checkWrite(done, "yan", 2)).toMatchObject({ ok: false, code: "not-owner" });
	});
});
