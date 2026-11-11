import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.ts";
import { fingerprint, Identity, isPersonName, TrustStore, verifySigned } from "../src/identity.ts";
import { GitSharedStore } from "../src/shared-store.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-lattice-collab-"));
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

	it("refuses names that could escape the shared tree", () => {
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

describe("TrustStore", () => {
	it("believes nobody until told to, pins the key, and notices a changed key", () => {
		const yan = Identity.loadOrCreate(dir, "yan");
		const impostor = Identity.loadOrCreate(join(dir, "other"), "yan");
		const trust = new TrustStore(join(dir, "trusted.json"));
		expect(trust.state("yan", yan.publicKey)).toBe("unknown");
		trust.trust("yan", yan.publicKey);
		expect(trust.state("yan", yan.publicKey)).toBe("trusted");
		expect(trust.state("yan", impostor.publicKey)).toBe("changed");
		expect(new TrustStore(join(dir, "trusted.json")).keyOf("yan")).toBe(yan.publicKey);
	});
});

describe("GitSharedStore", () => {
	const make = (name: string, remote: string) => new GitSharedStore({ remote, dir: join(dir, name), author: name });
	const bare = () => {
		const remote = join(dir, "shared.git");
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
		return remote;
	};

	it("starts from an empty shared repository and shares a first commit", async () => {
		const remote = bare();
		const a = make("a", remote);
		expect(await a.read((tx) => tx.list(""))).toEqual([]);
		expect(await a.commit("first", (tx) => tx.write("people/a.json", "{}"))).toBe(true);
		const b = make("b", remote);
		expect(await b.read((tx) => tx.read("people/a.json"))).toBe("{}");
	});

	it("reports no commit when nothing changed or the change was abandoned", async () => {
		const a = make("a", bare());
		await a.commit("first", (tx) => tx.write("x", "1"));
		expect(await a.commit("same", (tx) => tx.write("x", "1"))).toBe(false);
		expect(await a.commit("abandon", (tx) => {
			tx.write("x", "2");
			return false;
		})).toBe(false);
		expect(await a.read((tx) => tx.read("x"))).toBe("1");
	});

	it("re-runs a change against the other person's commit instead of overwriting it", async () => {
		const remote = bare();
		const a = make("a", remote);
		const b = make("b", remote);
		await a.commit("init", (tx) => tx.write("counter", "0"));
		await b.read(() => undefined); // b has seen counter=0

		let runs = 0;
		const bump = (who: string) => (tx: { read(p: string): string | undefined; write(p: string, c: string): void }) => {
			if (who === "b") runs++;
			tx.write("counter", String(Number(tx.read("counter")) + 1));
		};
		// Make b lose the race: a commits while b's working copy is stale.
		await a.commit("a bumps", bump("a"));
		execFileSync("git", ["-C", join(dir, "b"), "reset", "-q", "--hard", "HEAD"]);
		await b.commit("b bumps", bump("b"));
		expect(await a.read((tx) => tx.read("counter"))).toBe("2");
		expect(runs).toBeGreaterThanOrEqual(1);
	});

	it("lets exactly one of two conflicting compare-and-swap writers win", async () => {
		const remote = bare();
		const a = make("a", remote);
		const b = make("b", remote);
		await a.commit("init", (tx) => tx.write("owner", "nobody"));
		const claim = (who: string) => (tx: { read(p: string): string | undefined; write(p: string, c: string): void }) => {
			if (tx.read("owner") !== "nobody") return false;
			tx.write("owner", who);
			return true;
		};
		const results = await Promise.all([a.commit("a claims", claim("a")), b.commit("b claims", claim("b"))]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const owner = await a.read((tx) => tx.read("owner"));
		expect(owner).toBe(results[0] ? "a" : "b");
	});

	it("refuses paths outside the shared tree", async () => {
		const a = make("a", bare());
		await expect(a.commit("escape", (tx) => tx.write("../outside", "x"))).rejects.toThrow(/unsafe shared path/);
		await expect(a.commit("gitdir", (tx) => tx.write(".git/config", "x"))).rejects.toThrow(/unsafe shared path/);
	});

	it("removes files and lists directories", async () => {
		const a = make("a", bare());
		await a.commit("add", (tx) => {
			tx.write("mail/yan/1.json", "1");
			tx.write("mail/yan/2.json", "2");
		});
		await a.commit("remove", (tx) => tx.remove("mail/yan/1.json"));
		expect(await a.read((tx) => [tx.list("mail/yan"), tx.exists("mail/yan/1.json"), tx.list("nowhere")])).toEqual([["2.json"], false, []]);
	});
});
