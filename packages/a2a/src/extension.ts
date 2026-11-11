/**
 * pi-lattice a2a: agent-to-agent messaging between Pi sessions.
 *
 * Gives the model `send_message` and `list_peers`, gives the human `/inbox`, `/peers`
 * and `/node`, and delivers inbound mail to the model after the approval policy allows it.
 * Useful on its own: without a host, sessions sharing a lattice home talk through a file spool.
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ApprovalPolicy,
	assignmentFromEnv,
	createEnvelope,
	emitEvent,
	type Envelope,
	type HostAssignment,
	isAddress,
	isApprovalPolicy,
	isId,
	limitsFromEnv,
	onEvent,
	PROTOCOL_VERSION,
	requiresApproval,
	sameAssignment,
	transitionInbound,
	validateEnvelope,
} from "@pi-lattice/protocol";
import { Type } from "typebox";
import { formatInbound, summarize } from "./format.ts";
import { releaseNode, resolveIdentity } from "./identity.ts";
import { MailStore } from "./mailstore.ts";
import { latticeHome, nodeDir } from "./paths.ts";
import { RateLimiter } from "./rate.ts";
import { selectTransport } from "./select-transport.ts";
import type { Transport } from "./transport.ts";

const MESSAGE_TYPE = "lattice-a2a";
const NODE_ENTRY = "lattice:node";

interface Active {
	/** Where this node's mailbox lives. */
	home: string;
	/** The host assignment in effect, when a host owns this node. */
	assignment: HostAssignment | undefined;
	nodeId: string;
	owner: string;
	name: string;
	store: MailStore;
	transport: Transport;
	ctx: ExtensionContext;
}

/**
 * Pi builds a fresh extension instance when a session is replaced, so the id held by this
 * process cannot live in the factory closure. It is kept process-wide; one Pi process runs
 * one active session.
 */
const HELD = Symbol.for("pi-lattice.a2a.heldNodeId");
const held = globalThis as { [HELD]?: string };

/** The node id recorded in a session file, if any. */
function recordedIn(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	let found: string | undefined;
	try {
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.includes(NODE_ENTRY)) continue;
			const entry = JSON.parse(line) as { type?: string; customType?: string; data?: { nodeId?: unknown } };
			if (entry.type === "custom" && entry.customType === NODE_ENTRY && typeof entry.data?.nodeId === "string") found = entry.data.nodeId;
		}
	} catch {
		return undefined;
	}
	return found;
}

interface SendInput {
	to: string;
	text: string;
	intent?: string | undefined;
	replyTo?: string | undefined;
	data?: unknown;
}

export default function a2aExtension(pi: ExtensionAPI): void {
	const limits = limitsFromEnv(process.env);
	const rate = new RateLimiter(limits.maxSendsPerMinute);

	let active: Active | undefined;
	/** The inbound envelope with the most hops delivered since the human last spoke. */
	let cause: Envelope | undefined;

	pi.registerFlag("lattice-approval", {
		description: "Which inbound agent messages need human approval: cross-owner (default), always, never",
		type: "string",
	});

	const policy = (): ApprovalPolicy => {
		const value = pi.getFlag("lattice-approval") ?? process.env.LATTICE_APPROVAL;
		return isApprovalPolicy(value) ? value : "cross-owner";
	};

	const refreshStatus = (): void => {
		if (!active?.ctx.hasUI) return;
		const pending = active.store.count("pending");
		active.ctx.ui.setStatus("lattice", `${active.nodeId}${pending > 0 ? ` · ${pending} pending` : ""}`);
	};

	const notify = (text: string, level: "info" | "warning" | "error" = "info"): void => {
		if (active?.ctx.hasUI) active.ctx.ui.notify(text, level);
	};

	// --- inbound ---------------------------------------------------------------

	/** Record a state change everywhere it is observed: disk, other extensions, the host. */
	const mark = (state: Active, envelope: Envelope, to: "pending" | "approved" | "rejected" | "delivered"): void => {
		state.store.put(envelope, to);
		emitEvent(pi.events, "lattice:a2a:inbound", { envelope, state: to });
		state.transport.reportMail?.(envelope, to);
	};

	const deliver = (state: Active, envelope: Envelope): void => {
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: formatInbound(envelope), display: true, details: { envelope } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		mark(state, envelope, "delivered");
		if (!cause || envelope.hops > cause.hops) cause = envelope;
	};

	const handleInbound = async (value: unknown): Promise<void> => {
		const state = active;
		if (!state) throw new Error("no active session");
		const checked = validateEnvelope(value, limits);
		if (!checked.ok) {
			notify(`Dropped a malformed lattice message: ${checked.errors[0] ?? "invalid"}`, "warning");
			return;
		}
		const envelope = checked.envelope;
		if (state.store.findInbound(envelope.id)) return; // at-least-once delivery: already seen

		const hold = requiresApproval({
			policy: policy(),
			senderOwner: envelope.fromOwner,
			recipientOwner: state.owner,
			senderNode: envelope.from,
			trustedSenders: state.store.trustedSenders(),
		});
		if (hold) {
			mark(state, envelope, "pending");
			notify(`Message waiting for approval (/inbox): ${summarize(envelope, 60)}`);
		} else {
			deliver(state, envelope);
		}
		refreshStatus();
	};

	/** Apply a human decision to a pending message. */
	const decide = (id: string, action: "approve" | "reject"): string => {
		const state = active;
		if (!state) return "No active lattice session.";
		const mail = state.store.findInbound(id);
		if (!mail) return `No message ${id}.`;
		const result = transitionInbound(mail.state, action);
		if (!result.ok) return `Message ${id}: ${result.error}.`;
		if (!result.changed) return `Message ${id} is already ${mail.state}.`;
		if (action === "reject") {
			mark(state, mail.envelope, "rejected");
			refreshStatus();
			return `Rejected ${id}.`;
		}
		mark(state, mail.envelope, "approved");
		deliver(state, mail.envelope);
		refreshStatus();
		return `Approved ${id}; delivered to the agent.`;
	};

	// --- outbound --------------------------------------------------------------

	const send = async (input: SendInput): Promise<{ ok: true; envelope: Envelope; recipients: string[] } | { ok: false; error: string }> => {
		const state = active;
		if (!state) return { ok: false, error: "Lattice messaging is not active in this session." };
		if (!isAddress(input.to)) {
			return { ok: false, error: `"${input.to}" is not a valid recipient. Use a node id from list_peers, or parent, children or root.` };
		}
		let inReplyTo: Envelope | undefined;
		if (input.replyTo !== undefined) {
			if (!isId(input.replyTo)) return { ok: false, error: `replyTo "${input.replyTo}" is not a message id.` };
			inReplyTo = state.store.findInbound(input.replyTo)?.envelope;
			if (!inReplyTo) return { ok: false, error: `No received message ${input.replyTo} to reply to.` };
		}
		const envelope = createEnvelope({
			from: state.nodeId,
			fromOwner: state.owner,
			fromName: state.name,
			to: input.to,
			intent: input.intent,
			text: input.text,
			data: input.data,
			seq: state.store.nextSeq(input.to),
			inReplyTo,
			causedBy: cause,
		});
		if (envelope.hops > limits.maxHops) {
			return {
				ok: false,
				error: `Not sent: this exchange has passed between agents ${limits.maxHops} times without human input. Stop messaging and report the current state to the user.`,
			};
		}
		const checked = validateEnvelope(envelope, limits);
		if (!checked.ok) return { ok: false, error: `Not sent: ${checked.errors.join("; ")}` };
		if (!rate.tryAcquire()) {
			return { ok: false, error: `Not sent: rate limit of ${limits.maxSendsPerMinute} messages per minute reached. Wait before sending more.` };
		}
		try {
			const recipients = await state.transport.send(envelope);
			state.store.put(envelope, "sent");
			emitEvent(pi.events, "lattice:a2a:sent", { envelope });
			return { ok: true, envelope, recipients };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};

	// --- lifecycle -------------------------------------------------------------

	/** The session this instance serves, once it has started. */
	let session: { ctx: ExtensionContext; reason: "startup" | "reload" | "new" | "resume" | "fork"; previous: string | undefined } | undefined;
	/** A host assignment received by event. Undefined means nobody has said; null means released. */
	let assigned: HostAssignment | null | undefined;
	/** Binding and unbinding never overlap. */
	let binding: Promise<void> = Promise.resolve();

	/** Start speaking as a node: the host's, when assigned one, otherwise this session's own. */
	const bind = async (assignment: HostAssignment | undefined): Promise<void> => {
		const current = session;
		if (!current) return;
		const { ctx } = current;
		let recorded: string | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === NODE_ENTRY) {
				const id = (entry.data as { nodeId?: unknown } | undefined)?.nodeId;
				if (typeof id === "string") recorded = id;
			}
		}
		// A node's mailbox lives with whoever owns the tree, so every session speaking as it shares one.
		const home = assignment?.home ?? latticeHome();
		const identity = resolveIdentity({ home, assigned: assignment?.nodeId, held: current.previous, recorded, reason: current.reason });
		held[HELD] = identity.nodeId;
		if (recorded !== identity.nodeId) pi.appendEntry(NODE_ENTRY, { nodeId: identity.nodeId });

		const owner = assignment?.owner ?? process.env.LATTICE_OWNER ?? userInfo().username;
		const name = assignment?.name ?? process.env.LATTICE_NODE_NAME ?? pi.getSessionName() ?? basename(ctx.cwd);
		const store = new MailStore(nodeDir(home, identity.nodeId));
		const transport = await selectTransport(
			home,
			{ id: identity.nodeId, name, owner, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() },
			assignment,
		);
		if (session !== current) {
			// The session ended while we were connecting. Its objects are stale; let go and stop.
			await transport.close();
			releaseNode(home, identity.nodeId);
			return;
		}
		active = { nodeId: identity.nodeId, owner, name, store, transport, ctx, home, assignment };
		cause = undefined;

		// Finish deliveries a crash interrupted between approval and delivery.
		for (const envelope of store.list("approved")) deliver(active, envelope);

		transport.onDecision?.((envelopeId, action) => {
			notify(decide(envelopeId, action));
		});
		await transport.subscribe(handleInbound);
		refreshStatus();
		emitEvent(pi.events, "lattice:node:ready", { nodeId: identity.nodeId, owner, name, hosted: transport.kind === "host" });
	};

	const unbind = async (): Promise<void> => {
		const state = active;
		active = undefined;
		if (!state) return;
		await state.transport.close();
		releaseNode(state.home, state.nodeId);
	};

	const queue = (work: () => Promise<void>): Promise<void> => {
		// A failed bind must not poison later ones, nor surface as an unhandled rejection.
		binding = binding.then(work, work).catch(() => {});
		return binding;
	};

	pi.on("session_start", async (event, ctx) => {
		emitEvent(pi.events, "lattice:hello", { package: "a2a", protocol: PROTOCOL_VERSION });
		// /new and /fork keep the worker's address (ADR 0004): prefer the id of the session being left.
		session = { ctx, reason: event.reason, previous: recordedIn(event.previousSessionFile) ?? held[HELD] };
		// An assignment may already have arrived by event; otherwise a host that started us put one in the environment.
		await queue(() => bind(assigned !== undefined ? (assigned ?? undefined) : assignmentFromEnv(process.env)));
	});

	// Whoever opens a node in this session says so here. It can arrive before or after our own start.
	onEvent(pi.events, "lattice:host:assigned", ({ assignment }) => {
		assigned = assignment;
		if (!session) return; // not started yet: session_start will use it
		void queue(async () => {
			if (active && sameAssignment(active.assignment, assignment)) return;
			await unbind();
			if (!session) return;
			session = { ...session, previous: held[HELD] };
			await bind(assignment ?? undefined);
		});
	});

	pi.on("session_shutdown", async () => {
		session = undefined;
		await queue(unbind);
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") {
			cause = undefined; // the human spoke: a new chain starts
		} else if (event.message.customType === MESSAGE_TYPE) {
			const envelope = (event.message.details as { envelope?: Envelope } | undefined)?.envelope;
			if (envelope && (!cause || envelope.hops > cause.hops)) cause = envelope;
		}
	});

	onEvent(pi.events, "lattice:node:query", () => {
		if (active) {
			emitEvent(pi.events, "lattice:node:ready", {
				nodeId: active.nodeId, owner: active.owner, name: active.name, hosted: active.transport.kind === "host",
			});
		}
	});

	onEvent(pi.events, "lattice:a2a:send", (request) => {
		if (!session) return; // the bus outlives a session switch; a finished instance stays quiet
		void send({ to: request.to, text: request.text, intent: request.intent, replyTo: request.inReplyTo, data: request.data }).then((result) => {
			emitEvent(
				pi.events,
				"lattice:a2a:send-result",
				result.ok ? { requestId: request.requestId, ok: true, envelopeId: result.envelope.id } : { requestId: request.requestId, ok: false, error: result.error },
			);
		});
	});

	// --- model tools -----------------------------------------------------------

	pi.registerTool({
		name: "send_message",
		label: "Send message",
		description:
			"Send a message to another agent session. Recipients are node ids (from list_peers) or, when a lattice host is running, the tree-relative addresses parent, children and root. Delivery is asynchronous: a reply, if any, arrives later as a <lattice-message> block.",
		promptSnippet: "Send a message to another agent session",
		promptGuidelines: [
			"Use send_message to hand information or a request to another agent session; do not expect an immediate reply, and do not poll for one.",
			"When answering a <lattice-message>, call send_message with replyTo set to that message's id so the conversation stays linked.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient: a node id such as nd_..., or parent, children, root" }),
			text: Type.String({ description: "The message body" }),
			intent: Type.Optional(Type.String({ description: "What kind of message this is, for example ask, inform, result. Defaults to inform." })),
			replyTo: Type.Optional(Type.String({ description: "Id of the received message this answers" })),
		}),
		async execute(_toolCallId, params) {
			const result = await send(params);
			if (!result.ok) throw new Error(result.error);
			return {
				content: [{ type: "text", text: `Sent ${result.envelope.id} to ${result.recipients.join(", ") || params.to}.` }],
				details: { envelope: result.envelope, recipients: result.recipients },
			};
		},
	});

	pi.registerTool({
		name: "list_peers",
		label: "List peers",
		description: "List the agent sessions this session can message, with their node ids.",
		promptSnippet: "List agent sessions that can be messaged",
		parameters: Type.Object({}),
		async execute() {
			if (!active) throw new Error("Lattice messaging is not active in this session.");
			const peers = await active.transport.peers();
			const lines = peers.map((peer) => `${peer.id}  ${peer.name}  owner=${peer.owner}${peer.relation && peer.relation !== "other" ? `  ${peer.relation}` : ""}${peer.kind ? `  kind=${peer.kind}` : ""}${peer.status ? `  ${peer.status}` : ""}`);
			const text = [`You are ${active.nodeId} (${active.name}).`, peers.length > 0 ? lines.join("\n") : "No other sessions are reachable."].join("\n");
			return { content: [{ type: "text", text }], details: { self: active.nodeId, peers } };
		},
	});

	// --- human commands --------------------------------------------------------

	pi.registerCommand("inbox", {
		description: "Review agent messages waiting for approval. Usage: /inbox [approve|reject <id|all>] [trust|untrust <node>]",
		handler: async (args, ctx) => {
			const state = active;
			if (!state) {
				ctx.ui.notify("Lattice messaging is not active.", "warning");
				return;
			}
			const [verb, target] = args.trim().split(/\s+/).filter(Boolean);
			if (verb === "approve" || verb === "reject") {
				const ids = target === "all" || target === undefined ? state.store.list("pending").map((e) => e.id) : [target];
				if (ids.length === 0) ctx.ui.notify("Nothing is waiting for approval.", "info");
				for (const id of ids) ctx.ui.notify(decide(id, verb), "info");
				return;
			}
			if (verb === "trust" || verb === "untrust") {
				if (!isId(target)) {
					ctx.ui.notify(`Usage: /inbox ${verb} <node id>`, "warning");
					return;
				}
				state.store.setTrusted(target, verb === "trust");
				ctx.ui.notify(verb === "trust" ? `Messages from ${target} now skip approval.` : `Messages from ${target} need approval again.`, "info");
				return;
			}
			const pending = state.store.list("pending");
			if (pending.length === 0) {
				ctx.ui.notify(`Inbox: nothing waiting. ${state.store.count("delivered")} delivered, ${state.store.count("rejected")} rejected, ${state.store.count("sent")} sent.`, "info");
				return;
			}
			if (!ctx.hasUI) return;
			for (const envelope of pending) {
				const choice = await ctx.ui.select(`${summarize(envelope, 100)}\n\n${envelope.payload.text}`, ["Approve", "Reject", "Decide later"]);
				if (choice === "Approve") ctx.ui.notify(decide(envelope.id, "approve"), "info");
				else if (choice === "Reject") ctx.ui.notify(decide(envelope.id, "reject"), "info");
				else if (choice === undefined) return;
			}
		},
	});

	pi.registerCommand("peers", {
		description: "List agent sessions this session can message",
		handler: async (_args, ctx) => {
			if (!active) {
				ctx.ui.notify("Lattice messaging is not active.", "warning");
				return;
			}
			const peers = await active.transport.peers();
			ctx.ui.notify(peers.length > 0 ? peers.map((p) => `${p.id}  ${p.name}  ${p.status ?? ""}`).join("\n") : "No other sessions are reachable.", "info");
		},
	});

	pi.registerCommand("node", {
		description: "Show this session's lattice identity and mail counts",
		handler: async (_args, ctx) => {
			if (!active) {
				ctx.ui.notify("Lattice messaging is not active.", "warning");
				return;
			}
			const s = active.store;
			ctx.ui.notify(
				`node ${active.nodeId} (${active.name}) owner ${active.owner} · transport ${active.transport.kind} · approval ${policy()} · pending ${s.count("pending")} delivered ${s.count("delivered")} rejected ${s.count("rejected")} sent ${s.count("sent")}`,
				"info",
			);
		},
	});
}
