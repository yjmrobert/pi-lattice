/**
 * The certificate a server proves itself with. Nobody issues it: the server makes its own the
 * first time it starts, and the address teammates are given carries its fingerprint (the
 * "pin"), so a client knows the server it reaches is the one the address was given for
 * without a certificate authority, a domain name or anything to set up.
 *
 * Node can sign and verify but not write a certificate, so the few fields one needs are
 * encoded here (X.509 in DER, RFC 5280). It names nobody and never expires: the pin is what
 * is checked, not the name or the dates.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Certificate {
	/** The private key, PEM. It never leaves the server's machine. */
	key: string;
	/** The certificate, PEM. */
	cert: string;
}

const length = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const oid = (hex: string): Buffer => tlv(0x06, Buffer.from(hex, "hex"));
const pem = (label: string, der: Buffer): string => `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;

/** ecdsa-with-SHA256, 1.2.840.10045.4.3.2. */
const ECDSA_SHA256 = sequence(oid("2a8648ce3d040302"));
/** CN=pi-lattice. */
const NAME = sequence(tlv(0x31, sequence(oid("550403"), tlv(0x0c, Buffer.from("pi-lattice")))));
const utcTime = (text: string): Buffer => tlv(0x17, Buffer.from(text));

/** Make a key and a certificate for it, signed by itself. */
export function createCertificate(): Certificate {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const serial = randomBytes(16);
	serial[0] = ((serial[0] as number) & 0x7f) | 0x40; // positive, and no leading zero
	const body = sequence(
		tlv(0xa0, tlv(0x02, Buffer.from([2]))), // version 3
		tlv(0x02, serial),
		ECDSA_SHA256,
		NAME,
		sequence(utcTime("250101000000Z"), utcTime("491231235959Z")),
		NAME,
		publicKey.export({ type: "spki", format: "der" }),
	);
	const signature = sign("sha256", body, privateKey);
	const der = sequence(body, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));
	return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: pem("CERTIFICATE", der) };
}

/** The fingerprint of a certificate as it goes in an address: SHA-256 of it, in base64url. */
export function pinOf(cert: string | Buffer | X509Certificate): string {
	const raw = cert instanceof X509Certificate ? cert.raw : new X509Certificate(cert).raw;
	return createHash("sha256").update(raw).digest("base64url");
}

/** Whether a certificate is the one a pin was made from. */
export function matchesPin(cert: X509Certificate, pin: string): boolean {
	const [given, actual] = [Buffer.from(pin), Buffer.from(pinOf(cert))];
	return given.length === actual.length && timingSafeEqual(given, actual);
}

/**
 * The certificate kept in `dir`, made the first time. It stays the same from then on, so the
 * address teammates joined with keeps working. The key is private to the user.
 */
export function loadOrCreateCertificate(dir: string): Certificate {
	const [keyPath, certPath] = [join(dir, "tls.key"), join(dir, "tls.crt")];
	if (existsSync(keyPath) && existsSync(certPath)) {
		const kept = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
		try {
			pinOf(kept.cert);
			return kept;
		} catch {
			// Unreadable: a new one is made, and the address changes with it.
		}
	}
	mkdirSync(dir, { recursive: true });
	const made = createCertificate();
	writeFileSync(keyPath, made.key, { mode: 0o600 });
	chmodSync(keyPath, 0o600);
	writeFileSync(certPath, made.cert);
	return made;
}
