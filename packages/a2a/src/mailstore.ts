/**
 * Mail state for one node, on disk. The mailbox belongs to the node, not to a Pi session,
 * so it survives resume, /new, /fork and crashes. A message's state is the directory its
 * file is in, and a state change is a rename.
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, InboundState, TrustedSender } from "@pi-lattice/protocol";
import { readJson, writeFileAtomic } from "./fsutil.ts";

/** `received` is transient and never stored. `sent` is the outbox. */
export type StoredState = Exclude<InboundState, "received"> | "sent";

export type StoredInboundState = Exclude<StoredState, "sent">;

const INBOUND: readonly StoredInboundState[] = ["pending", "approved", "rejected", "delivered"];
const STATES: readonly StoredState[] = [...INBOUND, "sent"];

export interface StoredMail {
	envelope: Envelope;
	state: StoredState;
}

export class MailStore {
	private readonly dir: string;

	constructor(nodeDirectory: string) {
		this.dir = join(nodeDirectory, "mail");
		for (const state of STATES) mkdirSync(join(this.dir, state), { recursive: true });
	}

	private file(state: StoredState, id: string): string {
		return join(this.dir, state, `${id}.json`);
	}

	/** Find an inbound message by envelope id. */
	findInbound(id: string): { envelope: Envelope; state: StoredInboundState } | undefined {
		for (const state of INBOUND) {
			const envelope = readJson(this.file(state, id));
			if (envelope) return { envelope: envelope as Envelope, state };
		}
		return undefined;
	}

	/** Find any message this node has seen or sent. */
	find(id: string): StoredMail | undefined {
		const inbound = this.findInbound(id);
		if (inbound) return inbound;
		const sent = readJson(this.file("sent", id));
		return sent ? { envelope: sent as Envelope, state: "sent" } : undefined;
	}

	/** Store an envelope in a state. An inbound envelope lives in exactly one inbound state. */
	put(envelope: Envelope, state: StoredState): void {
		if (state !== "sent") {
			const existing = this.findInbound(envelope.id);
			if (existing) {
				if (existing.state !== state) renameSync(this.file(existing.state, envelope.id), this.file(state, envelope.id));
				return;
			}
		}
		writeFileAtomic(this.file(state, envelope.id), JSON.stringify(envelope));
	}

	/** Envelopes in a state, oldest first (ids sort by creation time). */
	list(state: StoredState): Envelope[] {
		const out: Envelope[] = [];
		for (const name of readdirSync(join(this.dir, state)).sort()) {
			if (!name.endsWith(".json")) continue;
			const envelope = readJson(join(this.dir, state, name));
			if (envelope) out.push(envelope as Envelope);
		}
		return out;
	}

	count(state: StoredState): number {
		return readdirSync(join(this.dir, state)).filter((name) => name.endsWith(".json")).length;
	}

	/** Next per-recipient sequence number, persisted so ordering survives restarts. */
	nextSeq(to: string): number {
		const path = join(this.dir, "seq.json");
		const table = (existsSync(path) ? (readJson(path) as Record<string, number> | undefined) : undefined) ?? {};
		const seq = (table[to] ?? 0) + 1;
		table[to] = seq;
		writeFileAtomic(path, JSON.stringify(table));
		return seq;
	}

	/**
	 * Senders the human has deliberately trusted to skip cross-owner approval, each with the
	 * person it belonged to then. An entry without an owner is from before trust was tied to
	 * one: nothing says whose session it was, so it is not kept.
	 */
	trustedSenders(): TrustedSender[] {
		const value = readJson(join(this.dir, "trusted.json"));
		if (!Array.isArray(value)) return [];
		return value.flatMap((entry: unknown) => {
			const { node, owner } = (entry ?? {}) as Partial<TrustedSender>;
			return typeof node === "string" && typeof owner === "string" ? [{ node, owner }] : [];
		});
	}

	/** Trust a session while it is `owner`'s. Trusting it again under someone else replaces that. */
	trust(nodeId: string, owner: string): void {
		this.writeTrusted([...this.trustedSenders().filter((entry) => entry.node !== nodeId), { node: nodeId, owner }]);
	}

	untrust(nodeId: string): void {
		this.writeTrusted(this.trustedSenders().filter((entry) => entry.node !== nodeId));
	}

	private writeTrusted(entries: TrustedSender[]): void {
		writeFileAtomic(join(this.dir, "trusted.json"), JSON.stringify(entries.sort((a, b) => a.node.localeCompare(b.node))));
	}

	/** The newest inbound message from a session, whatever became of it. */
	lastFrom(nodeId: string): Envelope | undefined {
		let last: Envelope | undefined;
		for (const state of INBOUND) for (const envelope of this.list(state)) if (envelope.from === nodeId && (!last || envelope.id > last.id)) last = envelope;
		return last;
	}
}
