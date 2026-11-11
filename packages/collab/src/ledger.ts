/**
 * The shared record of a node: who created it, its descriptive metadata, and the signed
 * log of ownership events. Ownership is never stored as a field anyone can overwrite; it
 * is recomputed by replaying the log through the lease state machine, believing only
 * events signed by people whose keys the reader trusts. Pure functions.
 */
import { initialOwnership, type LeaseEvent, type NodeMeta, type Ownership, transitionLease } from "@pi-lattice/protocol";
import { type Signed, verifySigned } from "./identity.ts";

/** The part of a node that collaborators see. Local details such as paths and session files stay local. */
export type SharedMeta = Pick<NodeMeta, "id" | "parentId" | "rootId" | "kind" | "name" | "brief" | "fragments" | "workspace" | "branch" | "status" | "createdAt" | "repo">;

export interface Genesis {
	nodeId: string;
	owner: string;
	at: string;
}

export interface NodeRecord {
	genesis: Signed<Genesis>;
	meta: Signed<SharedMeta>;
	events: Array<Signed<LeaseEvent>>;
}

/** Returns the public key of a person the reader trusts, or undefined. */
export type KeyLookup = (person: string) => string | undefined;

export interface Folded {
	/** False when the record's creator cannot be verified; nothing about it should be believed. */
	valid: boolean;
	ownership: Ownership;
	/** Events from the log that were applied. Later events are ignored once one fails. */
	applied: number;
	/** People whose signatures are needed but whose keys are not trusted. */
	unverified: string[];
	/** Whether the metadata was signed by someone who has owned the node. */
	metaTrusted: boolean;
}

function signerOf(event: LeaseEvent): string | undefined {
	return event.type === "expire" ? undefined : event.by;
}

/** Replay a record. `now` is used only to void an expired handoff at the end. */
export function foldRecord(record: NodeRecord, keys: KeyLookup, now: number): Folded {
	const creator = record.genesis.body.owner;
	const unverified: string[] = [];
	const creatorKey = keys(creator);
	if (record.genesis.by !== creator || !creatorKey || !verifySigned(record.genesis, creatorKey)) {
		if (!creatorKey) unverified.push(creator);
		return { valid: false, ownership: initialOwnership(creator), applied: 0, unverified, metaTrusted: false };
	}
	let ownership = initialOwnership(creator);
	const owners = new Set([creator]);
	let applied = 0;
	for (const signed of record.events) {
		const signer = signerOf(signed.body);
		if (!signer || signed.by !== signer) break;
		const key = keys(signer);
		if (!key) {
			unverified.push(signer);
			break;
		}
		if (!verifySigned(signed, key)) break;
		const result = transitionLease(ownership, signed.body);
		if (!result.ok) break;
		ownership = result.ownership;
		owners.add(ownership.owner);
		applied++;
	}
	const expired = transitionLease(ownership, { type: "expire", now });
	if (expired.ok) ownership = expired.ownership;
	const metaKey = keys(record.meta.by);
	const metaTrusted = owners.has(record.meta.by) && metaKey !== undefined && verifySigned(record.meta, metaKey);
	return { valid: true, ownership, applied, unverified, metaTrusted };
}

export type AppendResult = { ok: true; record: NodeRecord; changed: boolean; ownership: Ownership } | { ok: false; error: string };

/**
 * Append an ownership event if the state machine accepts it on top of the verified log.
 * Any unverifiable tail is dropped, so a forged event can never be built upon.
 */
export function appendEvent(record: NodeRecord, signed: Signed<LeaseEvent>, keys: KeyLookup, now: number): AppendResult {
	const folded = foldRecord(record, keys, now);
	if (!folded.valid) return { ok: false, error: `The creator of this node (${record.genesis.body.owner}) is not someone you trust yet.` };
	if (folded.unverified.length > 0) return { ok: false, error: `Ownership of this node depends on ${folded.unverified.join(", ")}, whom you do not trust yet.` };
	const result = transitionLease(folded.ownership, signed.body);
	if (!result.ok) return { ok: false, error: result.error };
	if (!result.changed) return { ok: true, record, changed: false, ownership: result.ownership };
	return { ok: true, record: { ...record, events: [...record.events.slice(0, folded.applied), signed] }, changed: true, ownership: result.ownership };
}

export function parseRecord(text: string | undefined): NodeRecord | undefined {
	if (!text) return undefined;
	try {
		const value = JSON.parse(text) as Partial<NodeRecord>;
		if (!value.genesis?.body || !value.meta?.body || !Array.isArray(value.events)) return undefined;
		return value as NodeRecord;
	} catch {
		return undefined;
	}
}

export function toSharedMeta(node: NodeMeta): SharedMeta {
	return {
		id: node.id, parentId: node.parentId, rootId: node.rootId, kind: node.kind, name: node.name, brief: node.brief,
		fragments: node.fragments, workspace: node.workspace, branch: node.branch, status: node.status, createdAt: node.createdAt,
		...(node.repo !== undefined ? { repo: node.repo } : {}),
	};
}
