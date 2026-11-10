import type { Envelope, InboundState, PeerInfo } from "@pi-lattice/protocol";

/**
 * Called for each inbound item. The value is untrusted and not yet validated.
 * Resolving acknowledges it; the transport will not deliver it again. Rejecting leaves
 * the transport free to set it aside. Delivery is at-least-once, so handlers dedupe.
 */
export type InboundHandler = (value: unknown) => Promise<void>;

/** A failure the sender can act on. The message is shown to the model or the human as-is. */
export class TransportError extends Error {
	override readonly name = "TransportError";
}

/**
 * How envelopes move between nodes. A session picks one transport at session start and
 * keeps it until shutdown.
 */
export interface Transport {
	/** Short label for status displays, for example "file" or "host". */
	readonly kind: string;
	/** Hand an envelope over for delivery. Resolves with the node ids it was addressed to. */
	send(envelope: Envelope): Promise<string[]>;
	/** Start receiving. Called once. */
	subscribe(handler: InboundHandler): Promise<void>;
	/** Nodes this transport can currently name. */
	peers(): Promise<PeerInfo[]>;
	/** Stop receiving and release resources. Safe to call more than once. */
	close(): Promise<void>;
	/** Tell whoever watches this transport that an inbound envelope changed state. Optional. */
	reportMail?(envelope: Envelope, state: InboundState): void;
	/** Receive approve or reject decisions made outside the session, for example in a host UI. Optional. */
	onDecision?(handler: (envelopeId: string, action: "approve" | "reject") => void): void;
}

/** What a transport needs to know about the node it serves. */
export interface SelfInfo {
	id: string;
	name: string;
	owner: string;
	cwd: string;
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
}
