import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * Where lattice keeps state that outlives a single session: `LATTICE_HOME`, else
 * `<pi agent dir>/lattice`. Sessions that share this directory can message each other.
 */
export function latticeHome(env: Env = process.env): string {
	if (env.LATTICE_HOME) return env.LATTICE_HOME;
	return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "lattice");
}

export function nodesDir(home: string): string {
	return join(home, "nodes");
}

/** Everything belonging to one node: registration, lock, transport inbox and mail state. */
export function nodeDir(home: string, nodeId: string): string {
	return join(nodesDir(home), nodeId);
}
