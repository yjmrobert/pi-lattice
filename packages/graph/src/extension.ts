/**
 * pi-lattice graph: where this session sits in a session tree, and tools to grow the tree.
 *
 * The tree belongs to a lattice host. Without one, the tools say so and do nothing.
 */
import { connect, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assignmentFromEnv, childrenOf, describeScheme, emitEvent, formatTree, formatWork, type HostAssignment, HostClient, type IssueChange, isHeld, issueLine, onEvent, PROTOCOL_VERSION, sameAssignment, WORKSPACE_MODES, type WorkspaceMode, waitingFor } from "@pi-lattice/protocol";
import { Type } from "typebox";

const GRAPH_ENTRY = "lattice:graph";
const NO_HOST = "No lattice host is reachable, so nothing was done. Session trees need a host: start one with `pi-lattice` and work inside it.";

export default function graphExtension(pi: ExtensionAPI): void {
	let client: HostClient | undefined;
	let socket: Socket | undefined;
	let nodeId: string | undefined;

	const host = (): HostClient => {
		if (!client || client.isClosed) throw new Error(NO_HOST);
		return client;
	};

	let context: ExtensionContext | undefined;
	let assigned: HostAssignment | null | undefined;
	let current: HostAssignment | undefined;
	let linking: Promise<void> = Promise.resolve();

	const disconnect = (): void => {
		client?.close();
		client = undefined;
		socket?.destroy();
		socket = undefined;
		nodeId = undefined;
		current = undefined;
	};

	/** Join the tree of the host that assigned this session a node. */
	const connectTo = async (assignment: HostAssignment | undefined): Promise<void> => {
		disconnect();
		const ctx = context;
		if (!assignment || !ctx) return;
		nodeId = assignment.nodeId;
		current = assignment;
		const recorded = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === GRAPH_ENTRY);
		if (!recorded) pi.appendEntry(GRAPH_ENTRY, { nodeId: assignment.nodeId, parentId: assignment.parentId, rootId: assignment.rootId, kind: assignment.kind });

		const stream = connect(assignment.socket);
		stream.setEncoding("utf8");
		socket = stream;
		const connecting = new HostClient({
			stream, token: assignment.token, nodeId: assignment.nodeId, channel: "graph", pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
		});
		try {
			await Promise.race([
				connecting.ready(),
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 3000).unref()),
			]);
			if (context !== ctx) throw new Error("session ended"); // connected too late: this session is gone
			client = connecting;
		} catch {
			connecting.close();
			stream.destroy();
			socket = undefined;
		}
	};

	const queue = (work: () => Promise<void>): Promise<void> => {
		linking = linking.then(work, work).catch(() => {});
		return linking;
	};

	pi.on("session_start", async (_event, ctx) => {
		emitEvent(pi.events, "lattice:hello", { package: "graph", protocol: PROTOCOL_VERSION });
		context = ctx;
		await queue(() => connectTo(assigned !== undefined ? (assigned ?? undefined) : assignmentFromEnv(process.env)));
	});

	// Whoever opens a node in this session says so here, before or after our own start.
	onEvent(pi.events, "lattice:host:assigned", ({ assignment }) => {
		assigned = assignment;
		if (!context) return;
		void queue(async () => {
			if (sameAssignment(current, assignment)) return;
			await connectTo(assignment ?? undefined);
		});
	});

	pi.on("session_shutdown", async () => {
		context = undefined;
		await queue(async () => disconnect());
	});

	pi.registerTool({
		name: "spawn_session",
		label: "Spawn session",
		description:
			"Create a child agent session under this one and give it a brief. The child starts working on the brief at once, in its own context, and reports back with messages. The user can see it in the session tree and talk to it directly.",
		promptSnippet: "Create a child agent session with a brief",
		promptGuidelines: [
			"Use spawn_session to delegate a piece of work that can be done and checked independently; write a brief that stands on its own, because the child sees none of this conversation.",
			'When calling spawn_session for a child that will edit code while other sessions are also editing, set workspace to "worktree" so it gets its own git worktree and branch.',
			"When a child needs the finished work of other children, spawn it now with waits_on naming them instead of waiting to spawn it: it starts by itself once each of them has sent its result.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short name for the child, shown in the tree" }),
			brief: Type.String({ description: "What the child should do: goal, context, constraints, and what to send back" }),
			kind: Type.Optional(Type.String({ description: "Free-form label for the kind of work, for example grilling, planning, task" })),
			fragments: Type.Optional(Type.Array(Type.String(), { description: "Role fragments to apply to the child, in order" })),
			workspace: Type.Optional(Type.String({ description: 'Where the child works: "shared" (this directory, the default) or "worktree" (its own git worktree and branch)' })),
			model: Type.Optional(Type.String({ description: "Model for the child, for example a cheaper one for routine work. Leave out to use the default" })),
			waits_on: Type.Optional(Type.Array(Type.String(), { description: "Sessions in this tree, by id or name, whose result the child needs first. It starts when each has sent its result" })),
			under: Type.Optional(Type.String({ description: "An item below this session, by id or name, to put the child under instead of directly under this session. Its report still comes to the nearest session above it" })),
			issue: Type.Optional(Type.Number({ description: "The number of the issue on the team's server that the child is to work on. Leave out and it is on the same issue as this session" })),
		}),
		async execute(_toolCallId, params) {
			const workspace = params.workspace ?? "shared";
			if (!(WORKSPACE_MODES as readonly string[]).includes(workspace)) throw new Error(`Unknown workspace "${workspace}". Use shared or worktree.`);
			const { node } = await host().request("spawn", {
				spec: {
					name: params.name,
					brief: params.brief,
					workspace: workspace as WorkspaceMode,
					...(params.kind !== undefined ? { kind: params.kind } : {}),
					...(params.fragments !== undefined ? { fragments: params.fragments } : {}),
					...(params.model !== undefined ? { model: params.model } : {}),
					...(params.waits_on !== undefined ? { waitsOn: params.waits_on } : {}),
					...(params.under !== undefined ? { under: params.under } : {}),
					...(params.issue !== undefined ? { issue: params.issue } : {}),
				},
			});
			const made = `Spawned "${node.name}" as ${node.id} (kind ${node.kind}${node.fragments.length > 0 ? `, roles ${node.fragments.join(" + ")}` : ""}${node.issue !== undefined ? `, on issue #${node.issue}` : ""}).`;
			if (isHeld(node)) {
				// Not started yet: say what it waits on, and that nothing more is needed for it to start.
				const { nodes } = await host().request("list", {});
				const names = waitingFor(nodes, node).map((other) => `"${other.name}" (${other.id})`).join(", ");
				const text = [
					`${made} It has not started: it waits on ${names}.`,
					`It is given its brief and starts by itself when ${waitingFor(nodes, node).length === 1 ? "that session has" : "each of those has"} sent its result${node.workspace === "worktree" ? ", in its own worktree made then" : ""}. Do not start it yourself; its report will arrive as a message. A message sent to ${node.id} starts it at once, without waiting.`,
				].join("\n");
				return { content: [{ type: "text", text }], details: { node } };
			}
			const where = node.branch ? `its own worktree on branch ${node.branch} (${node.cwd})` : "this working directory";
			const text = [
				`${made} It works in ${where}.`,
				`It has its brief and has started. Its report will arrive as a message; do not poll. To reach it, send_message to ${node.id}.`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { node } };
		},
	});

	pi.registerTool({
		name: "plan_item",
		label: "Plan item",
		description:
			"Put a piece of planned work in the tree without starting anything: an epic, a feature, a story or a task with nobody on it yet. It costs nothing until it is started. The user sees the plan and can put a session on any item.",
		promptSnippet: "Add a planned item to the tree, with nobody on it yet",
		promptGuidelines: [
			"Use plan_item to lay out work before starting it: the larger pieces first, then what each breaks into, with under naming the item each belongs to.",
			"Give each planned item a kind that says its level, for example epic, feature, story or task, and a brief that would let someone start on it cold.",
			"A planned item starts when you send_message to its id, or when the user seats a session on it. Plan first, then start only what can be worked on now.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short name for the item, shown in the tree" }),
			brief: Type.String({ description: "What the item is: goal, context, constraints, and what done means. Whoever starts on it is given this" }),
			kind: Type.Optional(Type.String({ description: "The level of the work, for example epic, feature, story or task" })),
			under: Type.Optional(Type.String({ description: "The item it belongs to, by id or name: one below this session. Leave out to put it directly under this session" })),
			waits_on: Type.Optional(Type.Array(Type.String(), { description: "Sessions in this tree, by id or name, whose result it needs first" })),
		}),
		async execute(_toolCallId, params) {
			const { node } = await host().request("spawn", {
				spec: {
					name: params.name,
					brief: params.brief,
					planned: true,
					...(params.kind !== undefined ? { kind: params.kind } : {}),
					...(params.under !== undefined ? { under: params.under } : {}),
					...(params.waits_on !== undefined ? { waitsOn: params.waits_on } : {}),
				},
			});
			const { nodes } = await host().request("list", {});
			const parent = nodes.find((other) => other.id === node.parentId);
			const text = [
				`Planned "${node.name}" as ${node.id} (kind ${node.kind})${parent ? ` under "${parent.name}"` : ""}. Nobody is on it and nothing has started.`,
				`To start it, send_message to ${node.id}: it is given its brief first and your message after. The user can also put a session on it from the tree.`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { node } };
		},
	});

	// The team's work, on its server. Without a server the host says so, and the tools do nothing.

	pi.registerTool({
		name: "work_list",
		label: "List work",
		description:
			"Show the team's work: its issues as a tree, each with its number, type, state, who it is assigned to and which sessions are on it, and the rules for what may go under what. The work lives on the team's server and is shared by everyone.",
		promptSnippet: "Show the team's issues and how they are structured",
		promptGuidelines: ["Call work_list before adding to the team's work or changing it: the types, states and fields are the team's own and may not be what you expect."],
		parameters: Type.Object({
			under: Type.Optional(Type.Number({ description: "Show only this issue and what is under it" })),
			all: Type.Optional(Type.Boolean({ description: "Include finished work. By default only unfinished work is shown" })),
		}),
		async execute(_toolCallId, params) {
			const { work } = await host().request("work", { request: { do: "look" } });
			if (!work) throw new Error("The host has no copy of the work.");
			const mine = work.issues.find((issue) => work.sessions.some((session) => session.id === nodeId && session.issue === issue.number));
			const text = [
				describeScheme(work.scheme),
				"",
				formatWork(work, { ...(params.under !== undefined ? { under: params.under } : {}), open: params.all !== true }),
				"",
				mine ? `This session is on #${mine.number}.` : "This session is on no issue.",
				...(work.connected ? [] : [`The server cannot be reached (${work.problem ?? "not connected"}): this is what was last heard, and nothing can be changed until it is back.`]),
			].join("\n");
			return { content: [{ type: "text", text }], details: { issues: work.issues.length } };
		},
	});

	pi.registerTool({
		name: "work_add",
		label: "Add work",
		description:
			"Add an issue to the team's work: an epic, a feature, a story, a task, a bug, or whatever types the team has. Nothing is started; it is work written down, for people and sessions to pick up. Everyone on the team sees it at once.",
		promptSnippet: "Add an issue to the team's work",
		promptGuidelines: [
			"Use work_add to write work down before anyone starts on it: the larger pieces first, then what each breaks into, with parent naming the issue each belongs to.",
			"Write a body that would let someone start on the issue cold: the goal, what is known, and what done means.",
			"To have a session work on an issue, spawn_session with its number as issue. Adding an issue starts nothing.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "A short title" }),
			body: Type.Optional(Type.String({ description: "What it is: goal, context, and what done means" })),
			type: Type.Optional(Type.String({ description: "Its type, one the team has. Leave out and it is whatever goes under its parent" })),
			parent: Type.Optional(Type.Number({ description: "The number of the issue it belongs to. Leave out to put it at the top" })),
			assignee: Type.Optional(Type.String({ description: "The person it is for, by their name in the team" })),
			labels: Type.Optional(Type.Array(Type.String(), { description: "Labels" })),
			fields: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), { description: "Values for the team's own fields, by name" })),
		}),
		async execute(_toolCallId, params) {
			const change: IssueChange = {
				title: params.title,
				...(params.body !== undefined ? { body: params.body } : {}),
				...(params.type !== undefined ? { type: params.type } : {}),
				...(params.parent !== undefined ? { parent: params.parent } : {}),
				...(params.assignee !== undefined ? { assignee: params.assignee } : {}),
				...(params.labels !== undefined ? { labels: params.labels } : {}),
				...(params.fields !== undefined ? { fields: params.fields } : {}),
			};
			const { issue } = await host().request("work", { request: { do: "add", change } });
			if (!issue) throw new Error("The server did not say what it made.");
			return { content: [{ type: "text", text: `Added ${issueLine(issue)}${issue.parent !== undefined ? `, under #${issue.parent}` : ""}. Nobody is on it and nothing has started.` }], details: { issue } };
		},
	});

	pi.registerTool({
		name: "work_update",
		label: "Update work",
		description:
			"Change an issue in the team's work: its title, body, type, state, parent, assignee, labels or fields, or add a comment to it. Give only what changes. Use null for parent, assignee or a field to clear it.",
		promptSnippet: "Change an issue, or comment on it",
		promptGuidelines: [
			"Use work_update with a comment to record on an issue what was decided or found, so that the people and sessions who come to it later have it.",
			"You do not need work_update to mark the issue you are on as started or done: that follows from being on it and from sending your result.",
		],
		parameters: Type.Object({
			number: Type.Number({ description: "The issue's number" }),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			type: Type.Optional(Type.String()),
			state: Type.Optional(Type.String({ description: "One of the team's states" })),
			parent: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "The issue to move it under, or null for the top" })),
			assignee: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			labels: Type.Optional(Type.Array(Type.String(), { description: "All its labels: this replaces the ones it has" })),
			fields: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()]), { description: "Fields to set, by name; null clears one. Fields not named are kept" })),
			comment: Type.Optional(Type.String({ description: "A comment to add" })),
		}),
		async execute(_toolCallId, params) {
			const { number, comment, ...rest } = params;
			const change = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as IssueChange;
			if (Object.keys(change).length === 0 && comment === undefined) throw new Error("Say what to change, or give a comment.");
			let issue = Object.keys(change).length > 0 ? (await host().request("work", { request: { do: "update", number, change } })).issue : undefined;
			if (comment !== undefined) issue = (await host().request("work", { request: { do: "comment", number, body: comment } })).issue ?? issue;
			const did = [Object.keys(change).length > 0 ? `Changed ${Object.keys(change).join(", ")}` : "", comment !== undefined ? "commented" : ""].filter(Boolean).join(" and ");
			return { content: [{ type: "text", text: `${did.charAt(0).toUpperCase()}${did.slice(1)}.${issue ? ` It is now: ${issueLine(issue)}` : ""}` }], details: { issue } };
		},
	});

	pi.registerTool({
		name: "work_on",
		label: "Work on",
		description:
			"Say which issue this session is working on. The team sees this session on that issue, and the issue is marked as started. Sending your result to your parent finishes it, unless something under it is unfinished.",
		promptSnippet: "Say which issue this session is on",
		promptGuidelines: ["When you move on to a different issue from the one you were given, call work_on with its number, so the team sees where you are."],
		parameters: Type.Object({ number: Type.Union([Type.Number(), Type.Null()], { description: "The issue's number, or null when this session is on no issue" }) }),
		async execute(_toolCallId, params) {
			const { issue } = await host().request("work", { request: { do: "on", number: params.number } });
			return { content: [{ type: "text", text: issue ? `This session is on ${issueLine(issue)}.` : "This session is on no issue." }], details: { issue } };
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "List sessions",
		description: "Show the session tree this session belongs to, with each session's id, kind, status and roles.",
		promptSnippet: "Show the session tree",
		parameters: Type.Object({}),
		async execute() {
			const { self, nodes } = await host().request("list", {});
			return { content: [{ type: "text", text: formatTree(nodes, { self }) }], details: { self, nodes } };
		},
	});

	pi.registerCommand("children", {
		description: "List this session's child sessions",
		handler: async (_args, ctx) => {
			if (!client || client.isClosed || !nodeId) {
				ctx.ui.notify(NO_HOST, "warning");
				return;
			}
			const { nodes } = await client.request("list", {});
			const children = childrenOf(nodes, nodeId);
			ctx.ui.notify(
				children.length > 0 ? children.map((child) => `${child.name}  [${child.kind}]  ${child.id}  ${child.status}`).join("\n") : "This session has no children.",
				"info",
			);
		},
	});
}
