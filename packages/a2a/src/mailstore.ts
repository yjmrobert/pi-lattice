/**
 * Mail state for one node, on disk. The mailbox belongs to the node, not to a Pi session,
 * so it survives resume, /new, /fork and crashes. A message's state is the directory its
 * file is in, and a state change is a rename.
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, InboundState } from "@pi-lattice/protocol";
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

	/** Senders the human has deliberately trusted to skip cross-owner approval. */
	trustedSenders(): string[] {
		const value = readJson(join(this.dir, "trusted.json"));
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	}

	setTrusted(nodeId: string, trusted: boolean): void {
		const current = new Set(this.trustedSenders());
		if (trusted) current.add(nodeId);
		else current.delete(nodeId);
		writeFileAtomic(join(this.dir, "trusted.json"), JSON.stringify([...current].sort()));
	}
}
