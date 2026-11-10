/**
 * The A2A envelope: the one message shape every transport, session and the host agree on.
 * Pure data and validation.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isId, newEnvelopeId } from "./ids.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

/** Wire version. A receiver rejects envelopes with a higher version than it implements. */
export const PROTOCOL_VERSION = 1;

/** Tree-relative recipients, resolved by whoever knows the tree. */
export const RELATIVE_ADDRESSES = ["parent", "children", "root"] as const;
export type RelativeAddress = (typeof RELATIVE_ADDRESSES)[number];

/** Well-known intents. The vocabulary is open: any non-empty string is a valid intent. */
export const INTENTS = ["ask", "inform", "result", "request-approval", "handoff"] as const;

export const PayloadSchema = Type.Object({
	/** The message body, as text for the receiving model or human. */
	text: Type.String(),
	/** Optional structured data. Receivers treat it as untrusted. */
	data: Type.Optional(Type.Unknown()),
	/** Optional file paths the message refers to, for content too large to inline. */
	refs: Type.Optional(Type.Array(Type.String())),
});
export type Payload = Static<typeof PayloadSchema>;

export const EnvelopeSchema = Type.Object({
	v: Type.Integer({ minimum: 1 }),
	id: Type.String({ minLength: 1 }),
	/** Sender node id. */
	from: Type.String({ minLength: 1 }),
	/** Owner of the sender node, as claimed by the sender. Unauthenticated until signatures are in use. */
	fromOwner: Type.String({ minLength: 1 }),
	/** Human-readable sender label, for display only. */
	fromName: Type.Optional(Type.String()),
	/** Recipient node id, or a tree-relative address. */
	to: Type.String({ minLength: 1 }),
	intent: Type.String({ minLength: 1, maxLength: 64 }),
	/** Groups a conversation. The first envelope's id by convention. */
	correlationId: Type.String({ minLength: 1 }),
	/** The envelope this one responds to, when there is one. */
	causationId: Type.Optional(Type.String()),
	/** Per sender-recipient sequence number, starting at 1. */
	seq: Type.Integer({ minimum: 1 }),
	/** How many agent-to-agent steps led to this envelope. */
	hops: Type.Integer({ minimum: 0 }),
	payload: PayloadSchema,
	/** ISO 8601 creation time. */
	createdAt: Type.String({ minLength: 1 }),
	/** Signature over the envelope, required for cross-owner mail once collab identity is in use. */
	sig: Type.Optional(Type.String()),
});
export type Envelope = Static<typeof EnvelopeSchema>;

export type ValidationResult = { ok: true; envelope: Envelope } | { ok: false; errors: string[] };

export function isRelativeAddress(value: string): value is RelativeAddress {
	return (RELATIVE_ADDRESSES as readonly string[]).includes(value);
}

/** True when the value can be used as a recipient: a node id or a tree-relative address. */
export function isAddress(value: unknown): value is string {
	return typeof value === "string" && (isRelativeAddress(value) || isId(value));
}

const encoder = new TextEncoder();

/** Serialized payload size in bytes. */
export function payloadBytes(payload: Payload): number {
	return encoder.encode(JSON.stringify(payload)).length;
}

export interface ValidateOptions {
	maxPayloadBytes?: number;
	maxHops?: number;
}

/**
 * Validate an untrusted value as an envelope.
 * Unknown fields are tolerated (forward compatibility); a higher version is rejected.
 */
export function validateEnvelope(value: unknown, options: ValidateOptions = {}): ValidationResult {
	const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes;
	const maxHops = options.maxHops ?? DEFAULT_LIMITS.maxHops;
	if (typeof value !== "object" || value === null) return { ok: false, errors: ["not an object"] };
	const version = (value as { v?: unknown }).v;
	if (typeof version === "number" && version > PROTOCOL_VERSION) {
		return { ok: false, errors: [`unsupported protocol version ${version}; this build implements ${PROTOCOL_VERSION}`] };
	}
	if (!Value.Check(EnvelopeSchema, value)) {
		const errors = Value.Errors(EnvelopeSchema, value).map((e) => `${e.instancePath || "/"}: ${e.message}`);
		return { ok: false, errors: errors.length > 0 ? errors.slice(0, 8) : ["schema mismatch"] };
	}
	const envelope = value as Envelope;
	const errors: string[] = [];
	if (!isId(envelope.id)) errors.push("/id: not a valid id");
	if (!isId(envelope.from)) errors.push("/from: not a valid node id");
	if (!isAddress(envelope.to)) errors.push("/to: not a node id or relative address");
	if (envelope.hops > maxHops) errors.push(`/hops: ${envelope.hops} exceeds limit ${maxHops}`);
	if (payloadBytes(envelope.payload) > maxPayloadBytes) errors.push(`/payload: larger than ${maxPayloadBytes} bytes`);
	if (Number.isNaN(Date.parse(envelope.createdAt))) errors.push("/createdAt: not a date");
	return errors.length > 0 ? { ok: false, errors } : { ok: true, envelope };
}

export interface NewEnvelope {
	from: string;
	fromOwner: string;
	fromName?: string | undefined;
	to: string;
	intent?: string | undefined;
	text: string;
	data?: unknown;
	refs?: string[] | undefined;
	seq: number;
	/** The envelope being answered. Sets correlation, causation and the hop count. */
	inReplyTo?: Pick<Envelope, "id" | "correlationId" | "hops"> | undefined;
	/** The envelope whose handling caused this send, when it is not a direct reply. */
	causedBy?: Pick<Envelope, "id" | "hops"> | undefined;
	now?: number | undefined;
}

/** Build a well-formed envelope. Does not validate limits; call {@link validateEnvelope} before sending. */
export function createEnvelope(input: NewEnvelope): Envelope {
	const now = input.now ?? Date.now();
	const id = newEnvelopeId(now);
	const cause = input.inReplyTo ?? input.causedBy;
	const hops = Math.max(input.inReplyTo ? input.inReplyTo.hops + 1 : 0, input.causedBy ? input.causedBy.hops + 1 : 0);
	const payload: Payload = { text: input.text };
	if (input.data !== undefined) payload.data = input.data;
	if (input.refs !== undefined && input.refs.length > 0) payload.refs = input.refs;
	const envelope: Envelope = {
		v: PROTOCOL_VERSION,
		id,
		from: input.from,
		fromOwner: input.fromOwner,
		to: input.to,
		intent: input.intent ?? "inform",
		correlationId: input.inReplyTo?.correlationId ?? id,
		seq: input.seq,
		hops,
		payload,
		createdAt: new Date(now).toISOString(),
	};
	if (input.fromName !== undefined) envelope.fromName = input.fromName;
	if (cause !== undefined) envelope.causationId = cause.id;
	return envelope;
}
