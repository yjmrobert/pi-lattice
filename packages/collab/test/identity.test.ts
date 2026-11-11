import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.ts";
import { fingerprint, Identity, isPersonName, verifySigned } from "../src/identity.ts";
import { PeerBook } from "../src/peers.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-lattice-identity-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("canonicalJson", () => {
	it("is independent of key order and drops undefined", () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});
});

describe("Identity", () => {
	it("creates a private key readable only by the user, and reloads the same key", () => {
		const first = Identity.loadOrCreate(dir, "yan");
		expect(statSync(join(dir, "yan.key")).mode & 0o777).toBe(0o600);
		expect(Identity.loadOrCreate(dir, "yan").publicKey).toBe(first.publicKey);
		expect(readFileSync(join(dir, "yan.key"), "utf8")).toContain("PRIVATE KEY");
	});

	it("signs so that only the matching key verifies, whatever the key order", () => {
		const yan = Identity.loadOrCreate(dir, "yan");
		const sam = Identity.loadOrCreate(dir, "sam");
		const signed = yan.sign({ type: "offer", to: "sam", version: 1 });
		expect(verifySigned(signed, yan.publicKey)).toBe(true);
		expect(verifySigned({ ...signed, body: { version: 1, to: "sam", type: "offer" } }, yan.publicKey)).toBe(true);
		expect(verifySigned(signed, sam.publicKey)).toBe(false);
	});

	it("rejects a tampered body, a tampered signature and garbage keys", () => {
		const yan = Identity.loadOrCreate(dir, "yan");
		const signed = yan.sign({ to: "sam" });
		expect(verifySigned({ ...signed, body: { to: "mallory" } }, yan.publicKey)).toBe(false);
		expect(verifySigned({ ...signed, sig: Buffer.from("nope").toString("base64") }, yan.publicKey)).toBe(false);
		expect(verifySigned(signed, "not a key")).toBe(false);
	});

	it("refuses names that could be mistaken for paths", () => {
		for (const bad of ["../x", "a/b", "", "a..b", ".hidden"]) expect(isPersonName(bad)).toBe(false);
		expect(() => Identity.loadOrCreate(dir, "../evil")).toThrow(/person name/);
		expect(isPersonName("yan.robert-1")).toBe(true);
	});

	it("gives a stable, readable fingerprint", () => {
		const yan = Identity.loadOrCreate(dir, "yan");
		expect(yan.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
		expect(fingerprint(yan.publicKey)).toBe(yan.fingerprint);
	});
});

describe("PeerBook", () => {
	it("pins a key per person, keeps a known address, and persists", () => {
		const yan = Identity.loadOrCreate(dir, "yan");
		const other = Identity.loadOrCreate(join(dir, "other"), "yan");
		const book = new PeerBook(join(dir, "peers.json"));
		expect(book.keyOf("yan")).toBeUndefined();
		book.pin("yan", yan.publicKey, "10.0.0.5:47610");
		book.pin("yan", other.publicKey); // a deliberate re-pin keeps where to reach them
		expect(new PeerBook(join(dir, "peers.json")).get("yan")).toEqual({ name: "yan", publicKey: other.publicKey, address: "10.0.0.5:47610" });
		book.remove("yan");
		expect(new PeerBook(join(dir, "peers.json")).list()).toEqual([]);
		expect(() => book.pin("../x", yan.publicKey)).toThrow(/person name/);
	});
});
