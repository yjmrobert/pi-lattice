/**
 * Identifiers. Time-sortable, lowercase, safe as file names and XML attribute values.
 * Sortability gives stable ordering for spool files and journals without a central counter.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

function encodeTime(ms: number, length: number): string {
	let out = "";
	let rest = Math.floor(ms);
	for (let i = 0; i < length; i++) {
		out = ALPHABET.charAt(rest % 32) + out;
		rest = Math.floor(rest / 32);
	}
	return out;
}

function randomChars(length: number): string {
	const bytes = new Uint8Array(length);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += ALPHABET.charAt(byte % 32);
	return out;
}

/** A new identifier with the given prefix, for example `nd_01jc...` or `env_01jc...`. */
export function newId(prefix: string, now: number = Date.now()): string {
	return `${prefix}_${encodeTime(now, 10)}${randomChars(10)}`;
}

export const newNodeId = (now?: number): string => newId("nd", now);
export const newEnvelopeId = (now?: number): string => newId("env", now);
export const newHandoffId = (now?: number): string => newId("ho", now);

const ID_PATTERN = /^[a-z]{2,8}_[0-9a-z]{8,40}$/;

/** True when the value is shaped like an identifier minted by {@link newId}. Ids are also used as path segments, so this is a safety check. */
export function isId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value);
}
