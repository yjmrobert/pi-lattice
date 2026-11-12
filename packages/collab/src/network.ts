/**
 * A team: the people who work together. To the hosts it is a name and a secret, and whoever
 * holds the secret is a member. The team's server keeps the secret and gives it to those who
 * have joined it; hosts never make one up.
 *
 * The secret never travels between hosts. A member proves they hold it with a keyed hash
 * over the handshake of each connection (see channel.ts).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface Network {
	name: string;
	/** 32 random bytes, base64url. Holding it is membership. */
	secret: string;
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
