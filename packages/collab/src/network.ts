/**
 * A network: the people who work together. It is a name and a secret, and whoever holds the
 * secret is a member. A person creates one, passes the join code to their teammates over a
 * channel they trust, and from then on every repository's host of every member finds the
 * others by itself. There is nothing to pair, per person or per repository.
 *
 * The secret never travels. A member proves they hold it with a keyed hash over the
 * handshake of each connection (see channel.ts), and the same secret decides which port a
 * repository's hosts listen on, so knowing a teammate's machine is enough to reach them.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Network {
	name: string;
	/** 32 random bytes, base64url. Holding it is membership. */
	secret: string;
	/** Machines to try first, as `host` or `host:port`: where the person who gave the code was. */
	seeds: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/i;
const CODE = /^([a-z0-9][a-z0-9-]{0,30})\.([A-Za-z0-9_-]{43})(?:@([A-Za-z0-9.,:_-]+))?$/i;

export function isNetworkName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

export function createNetwork(name: string): Network {
	if (!isNetworkName(name)) throw new Error(`"${name}" cannot be used as a network name. Use letters, digits and dashes.`);
	return { name, secret: randomBytes(32).toString("base64url"), seeds: [] };
}

/** Everything a teammate needs to join: the network, and where the person giving it can be reached. */
export function formatJoinCode(network: Network, hosts: readonly string[] = []): string {
	return `${network.name}.${network.secret}${hosts.length > 0 ? `@${hosts.join(",")}` : ""}`;
}

export function parseJoinCode(code: string): Network {
	const match = CODE.exec(code.trim());
	if (!match) throw new Error('That is not a join code. A join code looks like "name.secret@host".');
	return { name: match[1] as string, secret: match[2] as string, seeds: (match[3] ?? "").split(",").filter(Boolean) };
}

/** The secret as key material. */
export function networkKey(network: Pick<Network, "secret">): Buffer {
	return Buffer.from(network.secret, "base64url");
}

const mac = (key: Buffer, ...parts: Array<string | Buffer>): Buffer => {
	const hmac = createHmac("sha256", key);
	for (const part of parts) hmac.update(part).update("|");
	return hmac.digest();
};

/** A public label for the network: the same for every member, and it does not give the secret away. */
export function networkTag(key: Buffer): string {
	return createHash("sha256").update("pi-lattice-network|").update(key).digest("hex").slice(0, 16);
}

/** A label for a repository that only members can compute, so a beacon does not say what is being worked on. */
export function scopeTag(key: Buffer, scope: string): string {
	return mac(key, "scope", scope).toString("hex").slice(0, 16);
}

/** Proof of holding the secret, bound to one handshake. */
export function memberProof(key: Buffer, transcript: Buffer): string {
	return mac(key, "member", transcript).toString("base64");
}

export function checkMemberProof(key: Buffer, transcript: Buffer, proof: unknown): boolean {
	if (typeof proof !== "string") return false;
	const expected = mac(key, "member", transcript);
	const given = Buffer.from(proof, "base64");
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The port every member's host for one repository listens on. Derived from the secret and
 * the repository, so two members need only each other's machine, never a port number.
 */
export function sharedPort(key: Buffer, scope: string): number {
	return 47000 + (mac(key, "port", scope).readUInt16BE(0) % 2000);
}

/** The network this person is in, or undefined. A damaged file is no network. */
export function loadNetwork(path: string): Network | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Network> | null;
		if (!value || !isNetworkName(value.name) || typeof value.secret !== "string" || networkKey({ secret: value.secret }).length !== 32) return undefined;
		return { name: value.name, secret: value.secret, seeds: Array.isArray(value.seeds) ? value.seeds.filter((seed): seed is string => typeof seed === "string") : [] };
	} catch {
		return undefined;
	}
}

/** Write the network file, private to the user: it holds the secret. */
export function saveNetwork(path: string, network: Network): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(`${path}.tmp`, JSON.stringify(network, null, 2), { mode: 0o600 });
	chmodSync(`${path}.tmp`, 0o600);
	renameSync(`${path}.tmp`, path);
}

export function removeNetwork(path: string): void {
	rmSync(path, { force: true });
}
