/**
 * The inbound mail state machine. One machine, shared by every surface that shows or
 * acts on inbound mail (the /inbox command, RPC dialogs, the host tree UI).
 *
 *   received --hold-----> pending --approve--> approved --deliver--> delivered
 *      |                     |
 *      +--deliver (policy    +--reject--> rejected
 *         needs no approval)
 */

export const INBOUND_STATES = ["received", "pending", "approved", "rejected", "delivered"] as const;
export type InboundState = (typeof INBOUND_STATES)[number];

export type InboundAction = "hold" | "approve" | "reject" | "deliver";

export type InboundResult = { ok: true; state: InboundState; changed: boolean } | { ok: false; error: string };

const TRANSITIONS: Record<InboundState, Partial<Record<InboundAction, InboundState>>> = {
	received: { hold: "pending", deliver: "delivered" },
	pending: { approve: "approved", reject: "rejected" },
	approved: { deliver: "delivered" },
	rejected: {},
	delivered: {},
};

/** States an action leaves unchanged because it has already been applied. Makes retries safe. */
const IDEMPOTENT: Record<InboundAction, InboundState[]> = {
	hold: ["pending"],
	approve: ["approved", "delivered"],
	reject: ["rejected"],
	deliver: ["delivered"],
};

export function transitionInbound(state: InboundState, action: InboundAction): InboundResult {
	const next = TRANSITIONS[state][action];
	if (next !== undefined) return { ok: true, state: next, changed: true };
	if (IDEMPOTENT[action].includes(state)) return { ok: true, state, changed: false };
	return { ok: false, error: `cannot ${action} a message that is ${state}` };
}

/** `cross-owner`: approve mail from other owners. `always`: approve everything. `never`: approve nothing. */
export const APPROVAL_POLICIES = ["cross-owner", "always", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
	return typeof value === "string" && (APPROVAL_POLICIES as readonly string[]).includes(value);
}

export interface ApprovalInput {
	policy: ApprovalPolicy;
	senderOwner: string;
	recipientOwner: string;
	senderNode: string;
	/** Node ids the human has deliberately trusted. Only consulted under `cross-owner`. */
	trustedSenders?: readonly string[];
}

/** Whether a human must approve this envelope before a model sees it. */
export function requiresApproval(input: ApprovalInput): boolean {
	if (input.policy === "always") return true;
	if (input.policy === "never") return false;
	if (input.senderOwner === input.recipientOwner) return false;
	return !(input.trustedSenders ?? []).includes(input.senderNode);
}
