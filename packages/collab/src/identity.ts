/**
 * Who a person is, cryptographically. Each person has an Ed25519 key pair; the private key
 * never leaves their machine. Ownership events are signed with it, and peer connections
 * are authenticated with it. Whose key goes with which name is pinned the first time they are seen (see peers.ts).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

/** Person names are used as path segments in the shared store. */
export function isPersonName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value) && !value.includes("..");
}

/** A short, human-comparable digest of a public key, for confirming it out of band. */
export function fingerprint(publicKey: string): string {
	const hex = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 32);
	return hex.match(/.{4}/g)?.join(" ") ?? hex;
}

export interface Signed<T> {
	body: T;
	by: string;
	sig: string;
}

export class Identity {
	readonly name: string;
	/** Base64 DER (SPKI) public key. */
	readonly publicKey: string;
	private readonly privateKey: KeyObject;

	private constructor(name: string, privateKey: KeyObject) {
		this.name = name;
		this.privateKey = privateKey;
		this.publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
	}

	/** Load this person's key from `dir`, creating it on first use. The key file is private to the user. */
	static loadOrCreate(dir: string, name: string): Identity {
		if (!isPersonName(name)) throw new Error(`"${name}" cannot be used as a person name. Use letters, digits, dot, dash or underscore.`);
		const path = join(dir, `${name}.key`);
		if (existsSync(path)) return new Identity(name, createPrivateKey(readFileSync(path, "utf8")));
		const { privateKey } = generateKeyPairSync("ed25519");
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
		chmodSync(path, 0o600);
		return new Identity(name, privateKey);
	}

	get fingerprint(): string {
		return fingerprint(this.publicKey);
	}

	/** Sign raw bytes; returns a base64 signature. */
	signBytes(bytes: Buffer): string {
		return sign(null, bytes, this.privateKey).toString("base64");
	}

	sign<T>(body: T): Signed<T> {
		return { body, by: this.name, sig: sign(null, Buffer.from(canonicalJson(body)), this.privateKey).toString("base64") };
	}
}

/** True when `signature` over `bytes` was made by the holder of `publicKey`. Never throws. */
export function verifyBytes(bytes: Buffer, signature: string, publicKey: string): boolean {
	try {
		const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
		return verify(null, bytes, key, Buffer.from(signature, "base64"));
	} catch {
		return false;
	}
}

/** True when `signed` was signed by the holder of `publicKey`. Never throws. */
export function verifySigned(signed: Signed<unknown>, publicKey: string): boolean {
	try {
		const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
		return verify(null, Buffer.from(canonicalJson(signed.body)), key, Buffer.from(signed.sig, "base64"));
	} catch {
		return false;
	}
}
