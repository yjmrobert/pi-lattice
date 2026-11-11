/**
 * The people this human has paired with: a pinned public key each, and where to reach
 * them. Pairing is always a deliberate act, either by accepting an invite or by trusting
 * someone who knocked.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPersonName } from "./identity.ts";

export interface Peer {
	name: string;
	publicKey: string;
	/** `host:port`, when known. Without it the peer can still reach us. */
	address?: string;
}

export class PeerBook {
	private readonly path: string;
	private peers = new Map<string, Peer>();

	constructor(path: string) {
		this.path = path;
		try {
			const loaded = JSON.parse(readFileSync(path, "utf8")) as Peer[];
			for (const peer of Array.isArray(loaded) ? loaded : []) {
				if (isPersonName(peer?.name) && typeof peer.publicKey === "string") this.peers.set(peer.name, peer);
			}
		} catch {
			// No book yet.
		}
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify([...this.peers.values()], null, 2));
	}

	get(name: string): Peer | undefined {
		return this.peers.get(name);
	}

	keyOf(name: string): string | undefined {
		return this.peers.get(name)?.publicKey;
	}

	list(): Peer[] {
		return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Pin a person's key, replacing any earlier one. Keeps a known address unless a new one is given. */
	pin(name: string, publicKey: string, address?: string): void {
		if (!isPersonName(name)) throw new Error(`"${name}" cannot be used as a person name.`);
		const known = this.peers.get(name)?.address;
		const reach = address ?? known;
		this.peers.set(name, { name, publicKey, ...(reach !== undefined ? { address: reach } : {}) });
		this.save();
	}

	remove(name: string): void {
		this.peers.delete(name);
		this.save();
	}
}

/** Ed25519 public keys are stored as DER; an invite carries only the 32 raw key bytes, to stay short enough to read out or paste. */
const DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const toRaw = (publicKey: string): string => {
	const der = Buffer.from(publicKey, "base64");
	return (der.length === 44 && der.subarray(0, 12).equals(DER_PREFIX) ? der.subarray(12) : der).toString("base64");
};
const fromRaw = (key: string): string => {
	const bytes = Buffer.from(key, "base64");
	return (bytes.length === 32 ? Buffer.concat([DER_PREFIX, bytes]) : bytes).toString("base64");
};

const toUrlSafe = (base64: string): string => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrlSafe = (text: string): string => text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");

/** An invite is everything needed to pair: who, where, and their key. Pass it over a channel you trust. */
export function formatInvite(peer: Required<Peer>): string {
	return `${peer.name}@${peer.address}#${toUrlSafe(toRaw(peer.publicKey))}`;
}

export function parseInvite(invite: string): Required<Peer> {
	const match = /^([^@\s]+)@([^#\s]+:\d{1,5})#([A-Za-z0-9_-]+)$/.exec(invite.trim());
	if (!match || !isPersonName(match[1])) throw new Error('That is not an invite. An invite looks like "name@host:port#key".');
	return { name: match[1], address: match[2] as string, publicKey: fromRaw(fromUrlSafe(match[3] as string)) };
}
