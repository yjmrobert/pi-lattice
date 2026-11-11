/**
 * The people in this person's network: a pinned public key each, and the machines they have
 * been seen at. The first key seen under a name is pinned; a different key later is never
 * taken silently.
 *
 * One file per person, used by the host of every repository they have open, so the hosts
 * read it again whenever it has changed and merge before they write.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPersonName } from "./identity.ts";

export interface Peer {
	name: string;
	publicKey: string;
	/** Host names or addresses they were reached at, most recent first. No ports: see `sharedPort`. */
	hosts?: string[];
}

const MAX_HOSTS = 4;

export class PeerBook {
	private readonly path: string;
	private peers = new Map<string, Peer>();
	private stamp = "";

	constructor(path: string) {
		this.path = path;
		this.fresh();
	}

	/** Read the file again when another host has written it. */
	private fresh(): Map<string, Peer> {
		let stamp = "";
		try {
			const stat = statSync(this.path);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			// No book yet.
		}
		if (stamp === this.stamp) return this.peers;
		this.stamp = stamp;
		this.peers = new Map();
		try {
			const loaded = JSON.parse(readFileSync(this.path, "utf8")) as Peer[];
			for (const peer of Array.isArray(loaded) ? loaded : []) {
				if (!isPersonName(peer?.name) || typeof peer.publicKey !== "string") continue;
				const hosts = Array.isArray(peer.hosts) ? peer.hosts.filter((host): host is string => typeof host === "string").slice(0, MAX_HOSTS) : [];
				this.peers.set(peer.name, { name: peer.name, publicKey: peer.publicKey, ...(hosts.length > 0 ? { hosts } : {}) });
			}
		} catch {
			// Missing or damaged: an empty book.
		}
		return this.peers;
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.peers.values()], null, 2));
		renameSync(`${this.path}.tmp`, this.path);
		this.stamp = "";
		this.fresh();
	}

	get(name: string): Peer | undefined {
		return this.fresh().get(name);
	}

	keyOf(name: string): string | undefined {
		return this.fresh().get(name)?.publicKey;
	}

	list(): Peer[] {
		return [...this.fresh().values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Pin a person's key the first time they are seen. Returns true when they are new; never replaces a key. */
	learn(name: string, publicKey: string): boolean {
		if (!isPersonName(name)) return false;
		if (this.fresh().has(name)) return false;
		this.peers.set(name, { name, publicKey });
		this.save();
		return true;
	}

	/** Pin a person's key, replacing any earlier one. Only for a human's deliberate choice. */
	pin(name: string, publicKey: string): void {
		if (!isPersonName(name)) throw new Error(`"${name}" cannot be used as a person name.`);
		const hosts = this.fresh().get(name)?.hosts;
		this.peers.set(name, { name, publicKey, ...(hosts ? { hosts } : {}) });
		this.save();
	}

	/** Remember machines a person was reached at. `latest` puts them first; otherwise they are only added. */
	sawAt(name: string, hosts: readonly string[], latest = false): void {
		const peer = this.fresh().get(name);
		const given = hosts.filter((host) => /^[A-Za-z0-9._-]+$/.test(host));
		if (!peer || given.length === 0) return;
		const known = peer.hosts ?? [];
		const merged = (latest ? [...given, ...known] : [...known, ...given]).filter((host, index, all) => all.indexOf(host) === index).slice(0, MAX_HOSTS);
		if (merged.join(",") === known.join(",")) return;
		this.peers.set(name, { ...peer, hosts: merged });
		this.save();
	}

	remove(name: string): void {
		if (this.fresh().delete(name)) this.save();
	}
}
