/**
 * The contract between lattice extensions inside one Pi process. Extensions never import
 * each other; they exchange these typed events over `pi.events`.
 */
import type { HostAssignment } from "./assignment.ts";
import type { Envelope } from "./envelope.ts";
import type { InboundState } from "./inbound.ts";

export interface LatticeEvents {
	/**
	 * This session has been made a node of a host's tree (or, with null, released from one).
	 * Emitted by whatever opened the node here. Extensions rebind when they receive it, whether
	 * it arrives before or after their own session start.
	 */
	"lattice:host:assigned": { assignment: HostAssignment | null };
	/**
	 * Ask for a host to be started for a project. Whoever can start one sets `claimed` and
	 * does so; the asker then waits for it to appear. Unclaimed means nothing here can.
	 */
	"lattice:host:launch": { stateDir: string; cwd: string; claimed: boolean };
	/** Announced by each lattice extension at session start, so version mismatches are visible. */
	"lattice:hello": { package: string; protocol: number };
	/** The session's node identity is known. Emitted by whichever extension resolved it. */
	"lattice:node:ready": { nodeId: string; owner: string; name: string; hosted: boolean };
	/** Ask for `lattice:node:ready` to be emitted again. */
	"lattice:node:query": Record<string, never>;
	/** Ask the a2a extension to send a message on behalf of another extension. */
	"lattice:a2a:send": {
		requestId: string;
		to: string;
		text: string;
		intent?: string;
		data?: unknown;
		inReplyTo?: string;
	};
	"lattice:a2a:send-result": { requestId: string; ok: boolean; envelopeId?: string; error?: string };
	/** An envelope left this session. */
	"lattice:a2a:sent": { envelope: Envelope };
	/** An inbound envelope changed state. */
	"lattice:a2a:inbound": { envelope: Envelope; state: InboundState };
	/** The session's applied role fragments changed. */
	"lattice:roles:changed": { fragments: string[] };
	/** Ask which role fragments exist here. The asker passes an empty list; the roles extension fills it in. */
	"lattice:roles:available": { names: string[]; fragments?: Array<{ name: string; summary: string; source: string; path: string }> };
	/**
	 * Ask what this session has been told beyond what the person typed. The asker passes an
	 * empty list; each extension that writes into the prompt adds its parts, with where each
	 * comes from, so a person can read exactly what was injected and find the file to change.
	 */
	"lattice:prompt:describe": { parts: Array<{ title: string; source: string; where: string; text: string }> };
	/**
	 * Ask what the settings in effect here are. The asker leaves `values` out; whoever reads
	 * the settings files fills it in, by setting name. With no answer, each extension falls back
	 * to its own environment and defaults.
	 */
	"lattice:settings:query": { values?: Record<string, unknown> };
	/** Ask the roles extension to replace the applied fragments. */
	"lattice:roles:set": { fragments: string[] };
}

export type LatticeEventName = keyof LatticeEvents;

/** The part of `pi.events` this contract needs. */
export interface EventBus {
	emit(name: string, data: unknown): void;
	on(name: string, handler: (data: unknown) => void): unknown;
}

export function emitEvent<K extends LatticeEventName>(bus: EventBus, name: K, data: LatticeEvents[K]): void {
	bus.emit(name, data);
}

export function onEvent<K extends LatticeEventName>(bus: EventBus, name: K, handler: (data: LatticeEvents[K]) => void): void {
	bus.on(name, (data) => handler(data as LatticeEvents[K]));
}
