/**
 * pi-lattice pane: the session tree inside Pi.
 *
 * Shows a left pane listing the tree's sessions with who owns each and which repository it
 * works in, and lets the person open any of them in this terminal. The tree itself lives
 * in a background host that this extension starts on demand; opening a session takes it
 * over from the host, and leaving it hands it back.
 */
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { emitEvent, HANDOVER_NOTE, type HostAssignment, type HostClient, type NodeMeta, type UiState } from "@pi-lattice/protocol";
import { connectHost, hasTree, launchHost, projectRoot, stateDirFor } from "./locate.ts";
import { cursorKeys, interpretKey, type PaneAction } from "./keys.ts";
import { type InboxDetails, inboxItems, nodeKey, type Paint, type PaneView, paneOrder, PLAIN, renderCompact, renderPane } from "./view.ts";

const NODE_ENTRY = "lattice:node";
const PANE_WIDTH = 34;
const MIN_TERMINAL_WIDTH = 90;

type Hooked = TUI & { layoutRoot?: Component; setLayoutRoot?(component: Component | undefined): void };

/**
 * State that must outlive a session switch. Pi builds a new extension instance for every
 * session, but the connection to the host, the pane and what is open here belong to the
 * terminal, so they live once per process.
 */
interface Shared {
	client: HostClient | undefined;
	stateDir: string | undefined;
	state: UiState | undefined;
	/** The questions and messages behind the counts in the state, fetched so they can be shown and answered in place. */
	details: InboxDetails;
	/** The node open in this terminal. */
	current: string | undefined;
	/** What lets the open session speak as that node. Announced to the other extensions at each session start. */
	assignment: HostAssignment | undefined;
	/** What the pane's cursor is on: a key from the view's order. */
	cursor: string | undefined;
	focused: boolean;
	/** Redraws the pane while a session is working, so its spinner turns. */
	ticker: ReturnType<typeof setInterval> | undefined;
	paint: Paint;
	tui: Hooked | undefined;
	wrapped: boolean;
	/** Whether the compact fallback list is currently showing. */
	compact: boolean;
	pi: ExtensionAPI | undefined;
	ctx: ExtensionContext | undefined;
	refreshing: Promise<void> | undefined;
}
const KEY = Symbol.for("pi-lattice.pane");
const globals = globalThis as { [KEY]?: Shared };
const shared: Shared = (globals[KEY] ??= {
	client: undefined, stateDir: undefined, state: undefined, details: {}, current: undefined, assignment: undefined, cursor: undefined, focused: false, ticker: undefined, paint: PLAIN,
	tui: undefined, wrapped: false, compact: false, pi: undefined, ctx: undefined, refreshing: undefined,
});

const SPINNER_MS = 120;

function view(): PaneView {
	const state = shared.state;
	const base: PaneView = {
		repos: state && shared.stateDir ? [{ key: shared.stateDir, name: repoLabel(state, shared.stateDir), state, here: true, inbox: inboxItems(state, shared.details) }] : [],
		current: shared.current,
		cursor: shared.cursor,
		focused: shared.focused,
		hint: shared.client ? "No sessions yet. Your next\nmessage starts one here." : "No sessions in this\nproject yet.\n\n/lattice starts a tree\nfrom this session.",
		frame: Math.floor(Date.now() / SPINNER_MS),
		height: shared.tui?.terminal.rows,
	};
	return { ...base, keys: cursorKeys(base) };
}

/** Where the cursor starts: on what is waiting, if anything is; otherwise on the session open here. */
function restingCursor(): string | undefined {
	const order = paneOrder(view());
	const first = order[0]?.startsWith("i:") ? order[0] : undefined;
	return first ?? (shared.current ? nodeKey(shared.current) : order[0]);
}

/** A repository's name: what its sessions report, else the folder its tree is kept in. */
function repoLabel(state: UiState, stateDir: string): string {
	return state.nodes.find((node) => node.parentId === null && node.repo)?.repo ?? state.nodes.find((node) => node.repo)?.repo ?? basename(dirname(stateDir));
}

/** Keep the spinner turning while any session is working, and stop when none is. */
function tick(): void {
	const working = shared.state?.nodes.some((node) => node.status === "running" || node.status === "starting") ?? false;
	if (working && !shared.ticker && shared.wrapped) {
		shared.ticker = setInterval(() => shared.tui?.requestRender(), SPINNER_MS);
		shared.ticker.unref?.();
	} else if (!working && shared.ticker) {
		clearInterval(shared.ticker);
		shared.ticker = undefined;
	}
}

function redraw(): void {
	tick();
	shared.tui?.requestRender();
	// Between one session ending and the next starting there is no usable context; a redraw then simply waits.
	try {
		const ctx = shared.ctx;
		if (ctx?.mode !== "tui") return;
		// The compact list is only for terminals where the side pane could not be installed.
		if (!shared.wrapped) {
			ctx.ui.setWidget("lattice", shared.client ? renderCompact(view()) : undefined);
			shared.compact = true;
		} else if (shared.compact) {
			ctx.ui.setWidget("lattice", undefined);
			shared.compact = false;
		}
	} catch {
		shared.ctx = undefined;
	}
}

/** The node id recorded in a session, if it is a lattice node. */
function recordedNode(ctx: ExtensionContext): string | undefined {
	let found: string | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === NODE_ENTRY) {
			const id = (entry.data as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof id === "string") found = id;
		}
	}
	return found;
}

async function refresh(): Promise<void> {
	const client = shared.client;
	if (!client) return;
	shared.refreshing ??= client
		.ui("state", {})
		.then(async (state) => {
			shared.details = await fetchDetails(client, state);
			shared.state = state;
			// What the cursor was on may be gone (an item just answered): move to the next thing waiting, else to the session open here.
			if (shared.cursor && !paneOrder(view()).includes(shared.cursor)) shared.cursor = shared.focused ? restingCursor() : undefined;
		})
		.catch(() => {})
		.finally(() => {
			shared.refreshing = undefined;
			redraw();
		});
	await shared.refreshing;
}

/** Fetch the questions and messages that the state only counts. Whatever cannot be fetched stays a count. */
async function fetchDetails(client: HostClient, state: UiState): Promise<InboxDetails> {
	const asking = state.nodes.filter((node) => (state.attention[node.id]?.dialogs ?? 0) > 0);
	const pending = Object.values(state.attention).some((entry) => entry.pending > 0);
	const [dialogs, mail] = await Promise.all([
		Promise.all(asking.map(async (node) => [node.id, await client.ui("dialogs", { nodeId: node.id }).then((result) => result.dialogs).catch(() => [])] as const)),
		pending ? client.ui("pendingMail", {}).then((result) => result.mail).catch(() => []) : Promise.resolve([]),
	]);
	return { dialogs: Object.fromEntries(dialogs), mail };
}

function adoptClient(client: HostClient, stateDir: string): void {
	shared.client = client;
	shared.stateDir = stateDir;
	client.onFrame((frame) => {
		if (frame.t !== "event") return;
		if (frame.kind === "changed") void refresh();
		else if (frame.kind === "log" && frame.message) {
			try {
				if (shared.ctx?.hasUI) shared.ctx.ui.notify(frame.message, "info");
			} catch {
				shared.ctx = undefined; // the session that context belonged to has ended
			}
		}
	});
}

/** Put the pane to the left of everything Pi draws. Falls back to a compact widget when that is not possible. */
function installPane(tui: Hooked): void {
	shared.tui = tui;
	if (shared.wrapped || !tui.layoutRoot || !tui.setLayoutRoot) return;
	const pane: Component = {
		render: (width) => {
			// The last column is the divider between the pane and Pi; it lights up while the pane has the keyboard.
			const divider = shared.focused ? shared.paint.accent("│") : shared.paint.dim("│");
			return renderPane(view(), width, shared.paint).map((line) => {
				const text = truncateToWidth(line, width - 1);
				return `${text}${" ".repeat(Math.max(0, width - 1 - visibleWidth(text)))}${divider}`;
			});
		},
		invalidate() {},
	};
	const wrap = (inner: Component): Component =>
		new HStack([
			// Always there, so opening pi shows the sessions without typing anything.
			{ component: pane, basis: PANE_WIDTH, shrink: 0, visible: (viewport) => viewport.width >= MIN_TERMINAL_WIDTH },
			{ component: inner, basis: 0, grow: 1, minSize: 20 },
		]);
	const set = tui.setLayoutRoot.bind(tui);
	tui.setLayoutRoot = (component) => set(component ? wrap(component) : undefined);
	tui.setLayoutRoot(tui.layoutRoot);
	shared.wrapped = true;
	// Keys go to the pane only while it is focused; otherwise Pi behaves exactly as usual.
	tui.addInputListener((data) => {
		if (!shared.focused) return undefined;
		onPaneKey(data);
		return { consume: true };
	});
}

/** Run a /lattice command from a key press. Keys have no command context; the input path provides one. */
function dispatch(command: string): void {
	const pi = shared.pi;
	const ctx = shared.ctx;
	if (!pi || !ctx) return;
	try {
		// While the agent is working the input path needs to be told how to take this; a command runs at once either way.
		pi.sendUserMessage(command, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "steer" });
	} catch {
		// The session ended between the key press and now; the next session's pane will be current.
	}
}

function onPaneKey(data: string): void {
	const key = matchesKey(data, "up") ? "up" : matchesKey(data, "down") ? "down" : matchesKey(data, "enter") ? "enter" : matchesKey(data, "escape") || matchesKey(data, "alt+l") ? "escape" : data;
	for (const action of interpretKey(view(), key)) perform(action);
	redraw();
}

/** Carry out what a key press meant. Answers go straight to the host; anything needing Pi's dialogs goes through a command. */
function perform(action: PaneAction): void {
	const client = shared.client;
	const settle = (request: Promise<unknown>): void => {
		request
			.catch((error: unknown) => {
				try {
					shared.ctx?.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} catch {
					shared.ctx = undefined;
				}
			})
			.finally(() => void refresh());
	};
	if (action.do === "move") shared.cursor = action.cursor;
	else if (action.do === "leave") {
		shared.focused = false;
		shared.cursor = undefined;
	} else if (action.do === "command") dispatch(action.text);
	else if (!client) return;
	else if (action.do === "answer") settle(client.ui("answerDialog", { nodeId: action.nodeId, dialogId: action.dialogId, answer: { confirmed: action.confirmed } }));
	else if (action.do === "decide") settle(client.ui("decideMail", { nodeId: action.nodeId, envelopeId: action.envelopeId, action: action.action }));
	else if (action.do === "sharing") settle(client.ui("sharing", { action: action.action, args: [action.nodeId] }));
}

export default function paneExtension(pi: ExtensionAPI): void {
	// Inside a session the host runs headless there is no person and no pane.
	if (process.env.LATTICE_HEADLESS) return;

	const name = (id: string): string => shared.state?.nodes.find((node) => node.id === id)?.name ?? id;
	const find = (text: string): NodeMeta | undefined => shared.state?.nodes.find((node) => node.id === text) ?? shared.state?.nodes.find((node) => node.name === text);
	const mine = (node: NodeMeta | undefined): node is NodeMeta => node !== undefined && node.owner === shared.state?.owner;

	/** Tell the host which node this terminal has open, taking it over or giving back the previous one. */
	const attach = async (nodeId: string | undefined, leaveWorking = false): Promise<{ sessionFile: string; wasWorking: boolean } | undefined> => {
		const client = shared.client;
		if (!client) return undefined;
		if (shared.current && shared.current !== nodeId) {
			await client.ui("detach", { nodeId: shared.current, resume: leaveWorking }).catch(() => {});
			shared.current = undefined;
			shared.assignment = undefined;
		}
		if (!nodeId) return undefined;
		const result = await client.ui("attach", { nodeId });
		shared.current = nodeId;
		shared.assignment = result.assignment;
		return { sessionFile: result.sessionFile, wasWorking: result.wasWorking };
	};

	pi.on("session_start", async (_event, ctx) => {
		shared.pi = pi;
		shared.ctx = ctx;
		const stateDir = stateDirFor(ctx.cwd);
		try {
			if (!shared.client || shared.client.isClosed) {
				shared.client = undefined;
				const client = (await connectHost(stateDir)) ?? (hasTree(stateDir) ? await launchHost(pi.events, stateDir, ctx.cwd) : undefined);
				if (client) adoptClient(client, stateDir);
			}
			if (shared.client) {
				await refresh();
				// If this session is a node of the tree, this terminal now has it open. A session is
				// matched by the node id recorded in it, or by its file for one that was just adopted.
				const file = ctx.sessionManager.getSessionFile();
				const recorded = recordedNode(ctx);
				const node = (recorded ? find(recorded) : undefined) ?? (file ? shared.state?.nodes.find((candidate) => candidate.sessionFile === file) : undefined);
				const here = mine(node) ? node.id : undefined;
				if (here !== shared.current) await attach(here);
			}
			// Tell the messaging, roles and tree extensions which node this session is, if any.
			// They rebind whenever they hear this, so it does not matter which of us started first.
			emitEvent(pi.events, "lattice:host:assigned", { assignment: shared.current ? (shared.assignment ?? null) : null });
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`pi-lattice: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("lattice-pane-anchor", (tui, theme) => {
				shared.paint = {
					dim: (text) => theme.fg("dim", text),
					bold: (text) => theme.bold(text),
					accent: (text) => theme.fg("accent", text),
					ok: (text) => theme.fg("success", text),
					warn: (text) => theme.fg("warning", text),
					error: (text) => theme.fg("error", text),
					select: (text) => theme.bg("selectedBg", text),
				};
				installPane(tui as Hooked);
				queueMicrotask(redraw); // the side pane is in place: drop the compact list if it was shown meanwhile
				return { render: () => [], invalidate() {} };
			});
		}
		redraw();
	});

	// In a project that has a tree, a new session joins it with its first message, named after
	// that message, so every real session shows in the pane without anyone asking.
	pi.on("before_agent_start", async (event, ctx) => {
		const client = shared.client;
		if (!client || shared.current || event.messageType !== "user" || process.env.LATTICE_AUTO_JOIN === "0") return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		try {
			const title = pi.getSessionName() ?? (event.prompt.replace(/\s+/g, " ").trim().slice(0, 40) || basename(ctx.cwd));
			const { node, assignment } = await client.ui("adopt", { sessionFile, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: title });
			shared.current = node.id;
			shared.assignment = assignment;
			emitEvent(pi.events, "lattice:host:assigned", { assignment });
			void refresh();
		} catch {
			// Joining is a convenience; the session works without it.
		}
	});

	pi.on("agent_start", async () => {
		if (shared.current) await shared.client?.ui("status", { nodeId: shared.current, streaming: true }).catch(() => {});
	});
	pi.on("agent_settled", async () => {
		if (shared.current) await shared.client?.ui("status", { nodeId: shared.current, streaming: false }).catch(() => {});
	});

	pi.on("session_shutdown", async (event) => {
		// This session's objects are about to go stale. The next session's start supplies fresh ones.
		if (shared.pi === pi) {
			shared.pi = undefined;
			shared.ctx = undefined;
		}
		if (event.reason !== "quit") return; // a session switch keeps the terminal's connection
		if (shared.current) await shared.client?.ui("detach", { nodeId: shared.current }).catch(() => {});
		shared.current = undefined;
		shared.client?.close();
		shared.client = undefined;
	});

	pi.registerShortcut("alt+l", {
		description: "Focus the lattice session pane",
		handler: async (ctx) => {
			if (!shared.client) {
				ctx.ui.notify("No session tree here yet. Run /lattice to start one.", "info");
				return;
			}
			shared.focused = !shared.focused;
			shared.cursor = shared.focused ? restingCursor() : undefined;
			redraw();
		},
	});

	// --- flows, built from Pi's own dialogs --------------------------------------

	const need = (ctx: ExtensionCommandContext): HostClient | undefined => {
		if (!shared.client) ctx.ui.notify("No session tree here yet. Run /lattice to start one.", "warning");
		return shared.client;
	};
	const fail = (ctx: ExtensionCommandContext, error: unknown): void => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");

	/** Start a tree with the current session as its root. */
	const begin = async (ctx: ExtensionCommandContext): Promise<void> => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("This session is not saved to a file (--no-session), so it cannot join a tree.", "warning");
			return;
		}
		const stateDir = stateDirFor(ctx.cwd);
		adoptClient(await launchHost(pi.events, stateDir, ctx.cwd), stateDir);
		await refresh();
		const existing = recordedNode(ctx);
		if (existing && mine(find(existing))) {
			await attach(existing);
		} else {
			const client = shared.client as HostClient;
			const { node, assignment } = await client.ui("adopt", {
				sessionFile, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: pi.getSessionName() ?? basename(ctx.cwd),
			});
			shared.current = node.id;
			shared.assignment = assignment;
		}
		// The messaging, roles and tree extensions take up the node's identity as soon as they hear of it.
		emitEvent(pi.events, "lattice:host:assigned", { assignment: shared.assignment ?? null });
		await refresh();
		ctx.ui.notify("This session is now part of a lattice tree. alt+l moves to the session pane; /lattice new creates a child.", "info");
	};

	const open = async (ctx: ExtensionCommandContext, text: string): Promise<void> => {
		const client = need(ctx);
		if (!client) return;
		await refresh();
		const node = find(text);
		if (!node) {
			ctx.ui.notify(`No session "${text}" in this tree.`, "warning");
			return;
		}
		if (node.id === shared.current) return;
		if (!mine(node)) {
			await read(ctx, node);
			return;
		}
		const waiting = shared.state?.attention[node.id]?.dialogs ?? 0;
		if (waiting > 0 && !shared.state?.foreground.includes(node.id)) {
			const choice = await ctx.ui.select(`"${node.name}" is waiting on a question.`, ["Answer it here", "Open the session (the question is dropped)"]);
			if (choice === undefined) return;
			if (choice === "Answer it here") {
				await answer(ctx, node);
				return;
			}
		}
		const previous = shared.current;
		try {
			// A turn cannot move between processes. If the agent here is mid-turn, stop it on this
			// side; the host picks the session up in the background and tells it to carry on.
			const working = !ctx.isIdle();
			if (working) {
				ctx.abort();
				await ctx.waitForIdle();
			}
			const result = await attach(node.id, working);
			if (!result) return;
			const switched = await ctx.switchSession(result.sessionFile, {
				// The same in the other direction: a session that was working in the background carries on here.
				withSession: async (next) => {
					if (result.wasWorking) await next.sendUserMessage(HANDOVER_NOTE);
				},
			});
			if (switched.cancelled) await attach(previous);
		} catch (error) {
			await attach(previous).catch(() => {});
			fail(ctx, error);
		}
	};

	/** Show another person's session, read-only. */
	const read = async (ctx: ExtensionCommandContext, node: NodeMeta): Promise<void> => {
		const client = shared.client;
		if (!client) return;
		let messages: unknown[];
		try {
			messages = (await client.ui("messages", { nodeId: node.id })).messages;
		} catch (error) {
			ctx.ui.notify(`"${node.name}" belongs to ${node.owner}. ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		const text = transcriptText(messages);
		await ctx.ui.editor(`${node.name} (owned by ${node.owner}, read-only; changes here are not saved)`, text || "(no conversation yet)");
	};

	const answer = async (ctx: ExtensionCommandContext, node: NodeMeta): Promise<void> => {
		const client = shared.client;
		if (!client) return;
		const { dialogs } = await client.ui("dialogs", { nodeId: node.id });
		for (const dialog of dialogs) {
			const title = `${node.name} asks: ${dialog.title}${dialog.message ? `\n${dialog.message}` : ""}`;
			let reply: { value?: string; confirmed?: boolean; cancelled?: boolean };
			if (dialog.method === "confirm") reply = { confirmed: await ctx.ui.confirm(`${node.name} asks: ${dialog.title}`, dialog.message ?? "") };
			else if (dialog.method === "select") {
				const choice = await ctx.ui.select(title, dialog.options ?? []);
				reply = choice === undefined ? { cancelled: true } : { value: choice };
			} else {
				const value = await ctx.ui.input(title, dialog.placeholder ?? "");
				reply = value === undefined ? { cancelled: true } : { value };
			}
			await client.ui("answerDialog", { nodeId: node.id, dialogId: dialog.id, answer: reply });
		}
	};

	const create = async (ctx: ExtensionCommandContext, parentText: string): Promise<void> => {
		const client = need(ctx);
		if (!client) return;
		await refresh();
		const parent = find(parentText) ?? (shared.current ? find(shared.current) : undefined);
		if (!mine(parent)) {
			ctx.ui.notify("Choose one of your own sessions to add a child under.", "warning");
			return;
		}
		const childName = (await ctx.ui.input(`New session under "${parent.name}"`, "name"))?.trim();
		if (!childName) return;
		const kind = (await ctx.ui.input("Kind (a free-form label: task, grilling, planning...)", "task"))?.trim() || "task";
		const roles = (await ctx.ui.input("Roles, in order, separated by spaces (optional)", "worker implementation"))?.trim() ?? "";
		const workspace = await ctx.ui.select("Where should it work?", ["shared: this directory", "worktree: its own git worktree and branch"]);
		if (workspace === undefined) return;
		const brief = (await ctx.ui.editor("Brief: what should it do? It sees only this text.", ""))?.trim();
		if (!brief) return;
		try {
			const { node } = await client.ui("spawn", {
				parentId: parent.id,
				spec: { name: childName, brief, kind, fragments: roles.split(/[\s,+]+/).filter(Boolean), workspace: workspace.startsWith("worktree") ? "worktree" : "shared" },
			});
			ctx.ui.notify(`Created "${node.name}". It is working in the background; open it from the pane (alt+l).`, "info");
		} catch (error) {
			fail(ctx, error);
		}
	};

	const approvals = async (ctx: ExtensionCommandContext): Promise<void> => {
		const client = need(ctx);
		if (!client) return;
		for (;;) {
			const { mail } = await client.ui("pendingMail", {});
			if (mail.length === 0) {
				ctx.ui.notify("Nothing is waiting for approval.", "info");
				return;
			}
			await refresh();
			const labels = mail.map((item) => `${name(item.envelope.from)} (${item.envelope.fromOwner}) → ${name(item.nodeId)}: ${item.envelope.payload.text.replace(/\s+/g, " ").slice(0, 70)}`);
			const picked = await ctx.ui.select("Messages waiting for approval. Nothing here reaches an agent until you approve it.", labels);
			const item = picked === undefined ? undefined : mail[labels.indexOf(picked)];
			if (!item) return;
			const action = await ctx.ui.select(`${name(item.envelope.from)} (${item.envelope.fromOwner}) → ${name(item.nodeId)}\n\n${item.envelope.payload.text}`, ["Approve", "Reject", "Decide later"]);
			if (action !== "Approve" && action !== "Reject") return;
			await client.ui("decideMail", { nodeId: item.nodeId, envelopeId: item.envelope.id, action: action === "Approve" ? "approve" : "reject" }).catch((error: unknown) => fail(ctx, error));
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};

	const share = async (ctx: ExtensionCommandContext, targetText: string): Promise<void> => {
		const client = need(ctx);
		if (!client) return;
		await refresh();
		const run = async (action: string, args: string[]): Promise<void> => {
			try {
				const { text } = await client.ui("sharing", { action, args });
				if (text) ctx.ui.notify(text, "info");
			} catch (error) {
				fail(ctx, error);
			}
			await refresh();
		};
		const sharing = shared.state?.sharing;
		if (!sharing) {
			const port = await ctx.ui.input("Sharing is direct between machines, with no server. Port to accept your collaborators on:", "47610");
			if (port === undefined) return;
			await run("start", [port.trim() || "47610"]);
			return;
		}
		const options: Array<{ label: string; act: () => Promise<void> }> = [];
		for (const handoff of sharing.handoffs) {
			const node = `"${handoff.nodeName}"`;
			if (handoff.role === "recipient" && handoff.state === "offered") {
				options.push({ label: `Accept ${node} from ${handoff.from}`, act: () => run("accept", [handoff.nodeId]) });
				options.push({ label: `Decline ${node}`, act: () => run("cancel", [handoff.nodeId]) });
			} else if (handoff.role === "owner" && handoff.state === "accepted") {
				options.push({
					label: `Confirm release of ${node} to ${handoff.to}`,
					act: async () => {
						const sure = await ctx.ui.confirm(
							`Release ${node} to ${handoff.to}?`,
							"This stops the session here and sends its whole conversation, including any file contents and command output in it, directly to them, with its branch if it has one. After this you can no longer run it.",
						);
						if (!sure) return;
						if (handoff.nodeId === shared.current) {
							await attach(undefined);
							emitEvent(pi.events, "lattice:host:assigned", { assignment: null });
						}
						await run("confirm", [handoff.nodeId]);
					},
				});
				options.push({ label: `Cancel the handoff of ${node}`, act: () => run("cancel", [handoff.nodeId]) });
			} else options.push({ label: `Cancel the handoff of ${node}`, act: () => run("cancel", [handoff.nodeId]) });
		}
		for (const person of sharing.people) {
			if (person.trust === "trusted") continue;
			options.push({
				label: person.trust === "changed" ? `Accept ${person.name}'s new key` : `Pair with ${person.name}`,
				act: async () => {
					const sure = await ctx.ui.confirm(
						`Pair with ${person.name}?`,
						`Key fingerprint: ${person.fingerprint}\n\nCompare it with ${person.name} over a channel you already trust. Once paired, their sessions appear in your pane and their agents can send your agents mail, which still waits for your approval.${person.trust === "changed" ? "\n\nThis key is DIFFERENT from the one you paired with before." : ""}`,
					);
					if (sure) await run("trust", [person.name]);
				},
			});
		}
		const target = find(targetText) ?? (shared.current ? find(shared.current) : undefined);
		const paired = sharing.people.filter((person) => !person.self && person.trust === "trusted");
		if (mine(target) && paired.length > 0) {
			options.push({
				label: `Offer "${target.name}" to someone`,
				act: async () => {
					const to = await ctx.ui.select("Offer to whom? They must accept, then you confirm; both of you need to be online.", paired.map((person) => `${person.name} (${person.online ? "online" : "offline"})`));
					if (to !== undefined) await run("offer", [target.id, to.split(" ")[0] ?? ""]);
				},
			});
		}
		options.push({ label: "Show my invite", act: () => run("invite", []) });
		options.push({
			label: "Pair using someone's invite",
			act: async () => {
				const invite = await ctx.ui.input("Paste the invite they gave you", "name@host:port#key");
				if (invite) await run("add", [invite.trim()]);
			},
		});
		options.push({
			label: "Who is here",
			act: async () => ctx.ui.notify(sharing.people.map((person) => `${person.name}${person.self ? " (you)" : person.online ? "  online" : "  offline"}  ${person.fingerprint}`).join("\n"), "info"),
		});
		options.push({ label: "Refresh from everyone online", act: () => run("refresh", []) });
		const picked = await ctx.ui.select(`Sharing as ${shared.state?.owner ?? "you"}`, options.map((option) => option.label));
		await options.find((option) => option.label === picked)?.act();
	};

	const SUBCOMMANDS = ["open", "new", "answer", "approvals", "share", "sleep", "status", "stop"];

	pi.registerCommand("lattice", {
		description: "Session tree: /lattice [open <session> | new | answer <session> | approvals | share | sleep <session> | status | stop]",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			if (words.length <= 1) {
				const matches = SUBCOMMANDS.filter((sub) => sub.startsWith(words[0] ?? ""));
				return matches.length > 0 ? matches.map((sub) => ({ value: sub, label: sub })) : null;
			}
			const matches = (shared.state?.nodes ?? []).filter((node) => node.name.startsWith(words[1] ?? ""));
			return matches.length > 0 ? matches.map((node) => ({ value: `${words[0]} ${node.id}`, label: node.name, description: `${node.owner} · ${node.kind}` })) : null;
		},
		handler: async (args, ctx) => {
			shared.pi = pi;
			shared.ctx = ctx;
			const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			try {
				// With no argument: bring this session into the tree if it is not in it yet; otherwise show the tree.
				if (sub === "" && !shared.current) await begin(ctx);
				else if (sub === "" || sub === "status") {
					await refresh();
					const state = shared.state;
					ctx.ui.notify(
						state
							? [`Tree of ${state.nodes.length} session${state.nodes.length === 1 ? "" : "s"}, as ${state.owner}. Open here: ${shared.current ? name(shared.current) : "none"}.`, ...renderCompact(view(), 30), "alt+l focuses the pane · /lattice new · /lattice approvals · /lattice share"].join("\n")
							: "No session tree here yet. Run /lattice to start one.",
						"info",
					);
				} else if (sub === "open") await open(ctx, arg);
				else if (sub === "new") await create(ctx, arg);
				else if (sub === "answer") {
					await refresh();
					const node = find(arg);
					if (node) await answer(ctx, node);
				}
				else if (sub === "approvals") await approvals(ctx);
				else if (sub === "share") await share(ctx, arg);
				else if (sub === "sleep") {
					const node = find(arg);
					if (node) await need(ctx)?.ui("sleep", { nodeId: node.id });
				} else if (sub === "stop") {
					const client = need(ctx);
					if (!client) return;
					await attach(undefined);
					emitEvent(pi.events, "lattice:host:assigned", { assignment: null });
					await client.ui("shutdown", {}).catch(() => {});
					client.close();
					shared.client = undefined;
					shared.state = undefined;
					redraw();
					ctx.ui.notify("The lattice host is stopping. Sessions are saved and come back with /lattice.", "info");
				} else ctx.ui.notify("Usage: /lattice [open <session> | new | answer <session> | approvals | share | sleep <session> | status | stop]", "warning");
			} catch (error) {
				fail(ctx, error);
			}
			redraw();
		},
	});
}

/** A conversation as plain text, for reading another person's session. */
function transcriptText(messages: unknown[]): string {
	const out: string[] = [];
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolName?: string };
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("")
				: "";
		if (message.role === "user" || message.role === "custom") out.push(`> ${text}`);
		else if (message.role === "assistant" && text.trim() !== "") out.push(text);
		else if (message.role === "toolResult") out.push(`[${message.toolName ?? "tool"}] ${text.split("\n")[0] ?? ""}`);
	}
	return out.join("\n\n");
}

