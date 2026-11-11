/**
 * The per-user list of session trees, as a contract. Every repository keeps its own tree and
 * its own host; each host adds an entry when it starts, so a person's Pi can find the trees of
 * the other repositories they have work in. One small file per tree, in `<lattice home>/trees/`,
 * so hosts never contend for a file. This module only says where entries go and what they hold;
 * the host writes them and the pane reads them.
 */

/** A tree some host of this user has served. */
export interface KnownTree {
	/** The tree's state directory: where its host can be found. */
	stateDir: string;
	/** The directory the tree was started for, usually a repository's main checkout. */
	root: string;
	/** What identifies the repository to the person's network, the same for every clone of it. */
	scope?: string;
}

type Env = Record<string, string | undefined>;

/** Where lattice keeps state shared by all of a user's sessions: `LATTICE_HOME`, else `<pi agent dir>/lattice`. */
export function latticeHome(env: Env, userHome: string): string {
	if (env.LATTICE_HOME) return env.LATTICE_HOME;
	return `${env.PI_CODING_AGENT_DIR ?? `${userHome}/.pi/agent`}/lattice`;
}

/** The directory holding the entries, inside the lattice home. */
export const TREES_DIR = "trees";

/** The file name of a tree's entry: readable, and distinct for distinct state directories. */
export function treeEntryName(stateDir: string): string {
	// FNV-1a, to tell apart paths that read the same once made safe for a file name.
	let hash = 0x811c9dc5;
	for (let index = 0; index < stateDir.length; index++) {
		hash ^= stateDir.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const readable = stateDir.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-60);
	return `${readable}-${hash.toString(16).padStart(8, "0")}.json`;
}

export function encodeTree(tree: KnownTree): string {
	return JSON.stringify({ stateDir: tree.stateDir, root: tree.root, ...(tree.scope !== undefined ? { scope: tree.scope } : {}) });
}

/** Read an entry. A half-written or damaged one is nothing; its host rewrites it when it next starts. */
export function decodeTree(text: string): KnownTree | undefined {
	try {
		const tree = JSON.parse(text) as Partial<KnownTree> | null;
		if (!tree || typeof tree.stateDir !== "string" || typeof tree.root !== "string") return undefined;
		return { stateDir: tree.stateDir, root: tree.root, ...(typeof tree.scope === "string" ? { scope: tree.scope } : {}) };
	} catch {
		return undefined;
	}
}
