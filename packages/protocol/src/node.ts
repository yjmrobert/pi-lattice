/** A node is a place in the session tree. A Pi session is the conversation currently occupying it. */

export const NODE_STATUSES = ["dormant", "starting", "idle", "running", "blocked", "exited", "failed"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const WORKSPACE_MODES = ["shared", "worktree"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface NodeMeta {
	id: string;
	parentId: string | null;
	rootId: string;
	/** Free-form label such as "feature", "grilling" or "task". Never an enum. */
	kind: string;
	/** Short human-readable name. */
	name: string;
	/** The brief the node was spawned with. */
	brief: string;
	/** Applied role fragment names, in order. */
	fragments: string[];
	owner: string;
	/** Ownership epoch; see lease.ts. */
	version: number;
	status: NodeStatus;
	sessionId: string | null;
	sessionFile: string | null;
	cwd: string;
	workspace: WorkspaceMode;
	/** Git branch for worktree nodes. */
	branch: string | null;
	createdAt: string;
	updatedAt: string;
}

/** What a session without a host knows about a peer. */
export interface PeerInfo {
	id: string;
	name: string;
	owner: string;
	kind?: string;
	cwd?: string;
	/** Relationship to the asking node, when a tree is known. */
	relation?: "parent" | "child" | "sibling" | "root" | "self" | "other";
	status?: string;
}
