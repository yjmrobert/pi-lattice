/**
 * Node identity for a session. A node id is separate from the Pi session id, because
 * /new, /fork and /resume replace the session inside one process (ADR 0004).
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isId, newNodeId } from "@pi-lattice/protocol";
import { isProcessAlive } from "./fsutil.ts";
import { nodeDir } from "./paths.ts";

function lockPath(home: string, nodeId: string): string {
	return join(nodeDir(home, nodeId), "lock");
}

/**
 * Claim a node id for this process. Fails when another live process already holds it,
 * which is how two sessions copied from one file are kept from sharing an address.
 */
export function claimNode(home: string, nodeId: string, pid: number = process.pid): boolean {
	const path = lockPath(home, nodeId);
	mkdirSync(nodeDir(home, nodeId), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(pid), { flag: "wx" });
			return true;
		} catch {
			let holder = Number.NaN;
			try {
				holder = Number(readFileSync(path, "utf8").trim());
			} catch {
				continue;
			}
			if (holder === pid) return true;
			if (isProcessAlive(holder)) return false;
			try {
				unlinkSync(path);
			} catch {
				// Someone else cleaned it up; retry.
			}
		}
	}
	return false;
}

/** Release a claim held by this process. Safe to call when nothing is held. */
export function releaseNode(home: string, nodeId: string, pid: number = process.pid): void {
	const path = lockPath(home, nodeId);
	try {
		if (Number(readFileSync(path, "utf8").trim()) === pid) unlinkSync(path);
	} catch {
		// Nothing to release.
	}
}

export interface IdentityInput {
	home: string;
	/** `LATTICE_NODE_ID`, set by a host when it spawns the session. The host is the authority. */
	assigned?: string | undefined;
	/** The id this process already used before the session was replaced. */
	held?: string | undefined;
	/** The id recorded in the session being opened. */
	recorded?: string | undefined;
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	pid?: number;
}

export interface Identity {
	nodeId: string;
	source: "assigned" | "held" | "recorded" | "minted";
}

/** Decide which node id this session speaks as, and claim it. */
export function resolveIdentity(input: IdentityInput): Identity {
	const pid = input.pid ?? process.pid;
	if (isId(input.assigned)) {
		claimNode(input.home, input.assigned, pid);
		return { nodeId: input.assigned, source: "assigned" };
	}
	// /new and /fork keep the worker in place: same process, same position, new conversation.
	const keepHeld = input.reason === "new" || input.reason === "fork" || input.reason === "reload";
	const candidates: Array<[string | undefined, Identity["source"]]> = keepHeld
		? [[input.held, "held"], [input.recorded, "recorded"]]
		: [[input.recorded, "recorded"], [input.held, "held"]];
	for (const [candidate, source] of candidates) {
		if (isId(candidate) && claimNode(input.home, candidate, pid)) return { nodeId: candidate, source };
	}
	for (;;) {
		const minted = newNodeId();
		if (claimNode(input.home, minted, pid)) return { nodeId: minted, source: "minted" };
	}
}
