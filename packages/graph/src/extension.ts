/**
 * pi-lattice graph: where this session sits in a session tree, and tools to grow the tree.
 *
 * The tree belongs to a lattice host. Without one, the tools say so and do nothing.
 */
import { connect, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assignmentFromEnv, childrenOf, emitEvent, formatTree, type HostAssignment, HostClient, onEvent, PROTOCOL_VERSION, sameAssignment, WORKSPACE_MODES, type WorkspaceMode } from "@pi-lattice/protocol";
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
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short name for the child, shown in the tree" }),
			brief: Type.String({ description: "What the child should do: goal, context, constraints, and what to send back" }),
			kind: Type.Optional(Type.String({ description: "Free-form label for the kind of work, for example grilling, planning, task" })),
			fragments: Type.Optional(Type.Array(Type.String(), { description: "Role fragments to apply to the child, in order" })),
			workspace: Type.Optional(Type.String({ description: 'Where the child works: "shared" (this directory, the default) or "worktree" (its own git worktree and branch)' })),
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
				},
			});
			const where = node.branch ? `its own worktree on branch ${node.branch} (${node.cwd})` : "this working directory";
			const text = [
				`Spawned "${node.name}" as ${node.id} (kind ${node.kind}${node.fragments.length > 0 ? `, roles ${node.fragments.join(" + ")}` : ""}). It works in ${where}.`,
				`It has its brief and has started. Its report will arrive as a message; do not poll. To reach it, send_message to ${node.id}.`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { node } };
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
