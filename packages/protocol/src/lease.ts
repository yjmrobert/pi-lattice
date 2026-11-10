/**
 * Ownership and the two-phase handoff, as a pure state machine.
 *
 *   offer (owner) -> accept (recipient) -> confirm (owner) -> owner flips, version increments
 *
 * Until the flip, either side may cancel and the offer may expire. Every step is idempotent,
 * so a participant that crashes mid-handoff can replay its last step safely.
 *
 * `version` is the ownership epoch. It increments only when the owner changes, and any write
 * that carries an older version is rejected: that is what stops a previous owner, or a
 * partitioned copy, from writing after a handoff.
 */

export interface Handoff {
	id: string;
	from: string;
	to: string;
	state: "offered" | "accepted";
	/** Epoch milliseconds. The handoff is void at or after this time unless already confirmed. */
	expiresAt: number;
}

export interface Ownership {
	owner: string;
	version: number;
	handoff?: Handoff;
	/** Id of the most recently completed handoff, kept so a replayed confirm is recognised. */
	lastHandoffId?: string;
}

export type LeaseEvent =
	| { type: "offer"; id: string; by: string; to: string; expectedVersion: number; expiresAt: number; now: number }
	| { type: "accept"; id: string; by: string; now: number }
	| { type: "confirm"; id: string; by: string; now: number }
	| { type: "cancel"; id: string; by: string; now: number }
	| { type: "expire"; now: number };

export type LeaseErrorCode =
	| "stale-version"
	| "not-owner"
	| "not-recipient"
	| "not-participant"
	| "self-handoff"
	| "handoff-in-progress"
	| "no-such-handoff"
	| "not-accepted"
	| "expired"
	| "already-completed";

export type LeaseResult =
	| { ok: true; ownership: Ownership; changed: boolean }
	| { ok: false; code: LeaseErrorCode; error: string };

export function initialOwnership(owner: string): Ownership {
	return { owner, version: 1 };
}

const fail = (code: LeaseErrorCode, error: string): LeaseResult => ({ ok: false, code, error });
const same = (ownership: Ownership): LeaseResult => ({ ok: true, ownership, changed: false });
const next = (ownership: Ownership): LeaseResult => ({ ok: true, ownership, changed: true });

function without(ownership: Ownership): Ownership {
	const { handoff: _dropped, ...rest } = ownership;
	return rest;
}

function isExpired(handoff: Handoff, now: number): boolean {
	return now >= handoff.expiresAt;
}

export function transitionLease(current: Ownership, event: LeaseEvent): LeaseResult {
	const handoff = current.handoff;

	switch (event.type) {
		case "offer": {
			if (event.by !== current.owner) return fail("not-owner", `${event.by} does not own this node`);
			if (event.expectedVersion !== current.version) {
				return fail("stale-version", `offer carries version ${event.expectedVersion}; current is ${current.version}`);
			}
			if (event.to === current.owner) return fail("self-handoff", "cannot hand a node to its current owner");
			if (event.expiresAt <= event.now) return fail("expired", "offer is already expired");
			if (handoff && !isExpired(handoff, event.now)) {
				if (handoff.id === event.id && handoff.to === event.to) return same(current);
				return fail("handoff-in-progress", `handoff ${handoff.id} to ${handoff.to} is still open`);
			}
			return next({
				...without(current),
				handoff: { id: event.id, from: current.owner, to: event.to, state: "offered", expiresAt: event.expiresAt },
			});
		}

		case "accept": {
			if (!handoff || handoff.id !== event.id) {
				if (current.lastHandoffId === event.id && current.owner === event.by) return same(current);
				return fail("no-such-handoff", `no open handoff ${event.id}`);
			}
			if (event.by !== handoff.to) return fail("not-recipient", `${event.by} is not the recipient of this handoff`);
			if (isExpired(handoff, event.now)) return fail("expired", "the offer has expired");
			if (handoff.state === "accepted") return same(current);
			return next({ ...current, handoff: { ...handoff, state: "accepted" } });
		}

		case "confirm": {
			if (!handoff || handoff.id !== event.id) {
				if (current.lastHandoffId === event.id) return same(current);
				return fail("no-such-handoff", `no open handoff ${event.id}`);
			}
			if (event.by !== handoff.from) return fail("not-owner", `${event.by} is not the owner releasing this node`);
			if (isExpired(handoff, event.now)) return fail("expired", "the offer has expired");
			if (handoff.state !== "accepted") return fail("not-accepted", "the recipient has not accepted yet");
			return next({ owner: handoff.to, version: current.version + 1, lastHandoffId: handoff.id });
		}

		case "cancel": {
			if (!handoff || handoff.id !== event.id) {
				if (current.lastHandoffId === event.id) return fail("already-completed", "the handoff already completed");
				return same(current);
			}
			if (event.by !== handoff.from && event.by !== handoff.to) {
				return fail("not-participant", `${event.by} is not part of this handoff`);
			}
			return next(without(current));
		}

		case "expire": {
			if (handoff && isExpired(handoff, event.now)) return next(without(current));
			return same(current);
		}
	}
}

export type WriteCheck = { ok: true } | { ok: false; code: "stale-version" | "not-owner"; error: string };

/** Guard for any write to an owned node: the writer must be the owner and carry the current version. */
export function checkWrite(current: Ownership, by: string, expectedVersion: number): WriteCheck {
	if (expectedVersion !== current.version) {
		return { ok: false, code: "stale-version", error: `write carries version ${expectedVersion}; current is ${current.version}` };
	}
	if (by !== current.owner) return { ok: false, code: "not-owner", error: `${by} does not own this node` };
	return { ok: true };
}
