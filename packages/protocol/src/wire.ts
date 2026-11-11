/**
 * The host socket protocol: LF-delimited JSON frames between a lattice extension inside a
 * Pi session and the host process. Each extension opens its own connection ("channel").
 */
import type { HostAssignment } from "./assignment.ts";
import type { Envelope } from "./envelope.ts";
import type { InboundState } from "./inbound.ts";
import type { NodeMeta, PeerInfo, WorkspaceMode } from "./node.ts";

/** `ui` is a person's own Pi, showing the tree and driving the host; the others belong to one node's session. */
export type Channel = "a2a" | "graph" | "collab" | "ui";

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
	/** Control requests from a person's Pi. Only accepted on the `ui` channel. */
	ui: { params: { method: string; params: unknown }; result: unknown };
}
export type RequestOp = keyof RequestMap;

/** A dialog a headless session is blocked on until a human answers. */
export interface DialogInfo {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
}

export interface SharingPerson {
	name: string;
	fingerprint: string;
	trust: "trusted" | "unknown" | "changed";
	online: boolean;
	self: boolean;
}

export interface SharingHandoff {
	nodeId: string;
	nodeName: string;
	from: string;
	to: string;
	state: "offered" | "accepted";
	role: "owner" | "recipient";
}

/** Everything the pane shows, fetched in one request. */
export interface UiState {
	owner: string;
	nodes: NodeMeta[];
	/** Per node: dialogs blocking it and messages awaiting approval. */
	attention: Record<string, { dialogs: number; pending: number }>;
	/** Nodes currently open in someone's terminal. */
	foreground: string[];
	/** Present when the tree is shared peer to peer. */
	sharing: null | { people: SharingPerson[]; handoffs: SharingHandoff[]; pendingTransfers: Array<{ nodeId: string; to: string }> };
}

/** The control API a person's Pi uses to drive the host. Carried by the `ui` request. */
export interface UiApi {
	state: { params: Record<string, never>; result: UiState };
	/** Take a node over into this terminal. Any headless copy is stopped first. */
	attach: { params: { nodeId: string }; result: { node: NodeMeta; sessionFile: string; assignment: HostAssignment } };
	/** Give a node back; the host runs it headless again when it has work. */
	detach: { params: { nodeId: string }; result: Record<string, never> };
	/** Make the session already open in this terminal the root of a new tree. */
	adopt: { params: { sessionFile: string; sessionId: string; cwd: string; name: string; fragments?: string[] }; result: { node: NodeMeta; assignment: HostAssignment } };
	spawn: { params: { parentId: string; spec: SpawnSpec }; result: { node: NodeMeta } };
	/** Report whether the agent in a foreground node is working. */
	status: { params: { nodeId: string; streaming: boolean }; result: Record<string, never> };
	pendingMail: { params: Record<string, never>; result: { mail: Array<{ nodeId: string; envelope: Envelope }> } };
	decideMail: { params: { nodeId: string; envelopeId: string; action: "approve" | "reject" }; result: Record<string, never> };
	dialogs: { params: { nodeId: string }; result: { dialogs: DialogInfo[] } };
	answerDialog: { params: { nodeId: string; dialogId: string; answer: { value?: string; confirmed?: boolean; cancelled?: boolean } }; result: Record<string, never> };
	sleep: { params: { nodeId: string }; result: Record<string, never> };
	/** A node's conversation, for reading. Fetched from its owner when it is someone else's. */
	messages: { params: { nodeId: string }; result: { messages: unknown[] } };
	/** Sharing actions: invite, add, trust, offer, accept, confirm, cancel, refresh. Returns text to show. */
	sharing: { params: { action: string; args: string[] }; result: { text: string } };
	shutdown: { params: Record<string, never>; result: Record<string, never> };
}
export type UiMethod = keyof UiApi;

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
	| { t: "decide"; envelopeId: string; action: "approve" | "reject" }
	/** Something the pane shows has changed; fetch the state again. Sent on the `ui` channel. */
	| { t: "event"; kind: "changed" | "log"; message?: string };

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
