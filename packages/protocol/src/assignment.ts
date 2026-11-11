/**
 * A host assignment: everything a session needs to speak as a node of a host's tree.
 *
 * It reaches a session in one of two ways, and the lattice extensions treat both alike:
 * through the environment, when the host started the session itself; or through the
 * `lattice:host:assigned` event, when a person's own Pi opens a node. Extensions accept
 * an assignment at any time, so they do not depend on each other's load order.
 */
import { isId } from "./ids.ts";

export interface HostAssignment {
	/** Path of the host's local socket. */
	socket: string;
	/** Proves to the host that this session is the node it claims to be. */
	token: string;
	nodeId: string;
	parentId: string | null;
	rootId: string;
	kind: string;
	name: string;
	/** Role fragments the node was given when it was created. */
	fragments: string[];
	owner: string;
	/** Directory holding the node's mailbox, shared by every session that speaks as it. */
	home: string;
}

/** Environment variables a host sets on the sessions it starts. */
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

export function assignmentToEnv(assignment: HostAssignment): Record<string, string> {
	return {
		[HOST_ENV.socket]: assignment.socket,
		[HOST_ENV.token]: assignment.token,
		[HOST_ENV.nodeId]: assignment.nodeId,
		[HOST_ENV.parentId]: assignment.parentId ?? "",
		[HOST_ENV.rootId]: assignment.rootId,
		[HOST_ENV.kind]: assignment.kind,
		[HOST_ENV.name]: assignment.name,
		[HOST_ENV.fragments]: assignment.fragments.join(","),
		[HOST_ENV.owner]: assignment.owner,
		[HOST_ENV.home]: assignment.home,
	};
}

/** Read an assignment from an environment. Undefined unless a host put a complete one there. */
export function assignmentFromEnv(env: Record<string, string | undefined>): HostAssignment | undefined {
	const socket = env[HOST_ENV.socket];
	const token = env[HOST_ENV.token];
	const nodeId = env[HOST_ENV.nodeId];
	const home = env[HOST_ENV.home];
	const owner = env[HOST_ENV.owner];
	if (!socket || !token || !isId(nodeId) || !home || !owner) return undefined;
	return {
		socket, token, nodeId, home, owner,
		parentId: env[HOST_ENV.parentId] || null,
		rootId: env[HOST_ENV.rootId] || nodeId,
		kind: env[HOST_ENV.kind] || "session",
		name: env[HOST_ENV.name] || nodeId,
		fragments: (env[HOST_ENV.fragments] ?? "").split(",").map((name) => name.trim()).filter(Boolean),
	};
}

/** Whether two assignments make a session the same node of the same host. */
export function sameAssignment(a: HostAssignment | undefined | null, b: HostAssignment | undefined | null): boolean {
	if (!a || !b) return !a && !b;
	return a.socket === b.socket && a.token === b.token && a.nodeId === b.nodeId;
}
