/**
 * The host socket protocol: LF-delimited JSON frames between a lattice extension inside a
 * Pi session and the host process. Each extension opens its own connection ("channel").
 */
import type { Envelope } from "./envelope.ts";
import type { InboundState } from "./inbound.ts";
import type { NodeMeta, PeerInfo, WorkspaceMode } from "./node.ts";

export type Channel = "a2a" | "graph" | "collab";

/** What a session asks the host to create. All strings are free-form. */
export interface SpawnSpec {
	name: string;
	brief: string;
	kind?: string;
	fragments?: string[];
	workspace?: WorkspaceMode;
}

export interface RequestMap {
	send: { params: { envelope: Envelope }; result: { recipients: string[] } };
	peers: { params: Record<string, never>; result: { peers: PeerInfo[] } };
	spawn: { params: { spec: SpawnSpec }; result: { node: NodeMeta } };
	list: { params: Record<string, never>; result: { self: string; nodes: NodeMeta[] } };
}
export type RequestOp = keyof RequestMap;

export type ClientFrame =
	/** First frame on every connection. A connection without a valid token is dropped. */
	| { t: "hello"; token: string; nodeId: string; channel: Channel; protocol: number; pid: number; sessionId?: string; sessionFile?: string }
	| { [K in RequestOp]: { t: "req"; rid: string; op: K; params: RequestMap[K]["params"] } }[RequestOp]
	/** The session stored a delivered envelope; the host may stop redelivering it. */
	| { t: "ack"; envelopeId: string }
	/** An inbound envelope changed state in the session's mailbox. */
	| { t: "mail"; envelope: Envelope; state: InboundState };

export type HostFrame =
	| { t: "welcome"; nodeId: string }
	| { t: "res"; rid: string; ok: true; result: unknown }
	| { t: "res"; rid: string; ok: false; error: string }
	| { t: "deliver"; envelope: Envelope }
	/** The human decided on a pending message from the host UI. */
	| { t: "decide"; envelopeId: string; action: "approve" | "reject" };

export function encodeFrame(frame: ClientFrame | HostFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

/**
 * Incremental decoder for LF-delimited JSON. Splits on LF only: JSON strings may contain
 * U+2028 and U+2029, which generic line readers treat as line breaks.
 */
export class FrameDecoder {
	private buffer = "";
	private readonly maxFrameBytes: number;

	constructor(maxFrameBytes = 1024 * 1024) {
		this.maxFrameBytes = maxFrameBytes;
	}

	/** Feed a chunk; returns the complete frames it finished. Malformed lines are skipped. */
	push(chunk: string): unknown[] {
		this.buffer += chunk;
		const out: unknown[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
			if (line === "") continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				// Not a frame; ignore.
			}
		}
		if (this.buffer.length > this.maxFrameBytes) {
			this.buffer = "";
			throw new Error("frame exceeds maximum size");
		}
		return out;
	}
}

/** Environment variables a host sets on the sessions it spawns. */
export const HOST_ENV = {
	socket: "LATTICE_SOCK",
	token: "LATTICE_TOKEN",
	nodeId: "LATTICE_NODE_ID",
	parentId: "LATTICE_PARENT_ID",
	rootId: "LATTICE_ROOT_ID",
	kind: "LATTICE_KIND",
	name: "LATTICE_NODE_NAME",
	fragments: "LATTICE_FRAGMENTS",
	owner: "LATTICE_OWNER",
	home: "LATTICE_HOME",
} as const;
