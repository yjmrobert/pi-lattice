import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { HandshakeError, openChannel, type SecureChannel } from "../src/channel.ts";
import { Identity } from "../src/identity.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-lattice-channel-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const yan = Identity.loadOrCreate(dir, "yan");
const sam = Identity.loadOrCreate(dir, "sam");
const mallory = Identity.loadOrCreate(dir, "mallory");
const fakeYan = Identity.loadOrCreate(join(dir, "fake"), "yan");
const book = (...people: Identity[]) => (name: string) => people.find((p) => p.name === name)?.publicKey;

/** A real TCP connection on localhost, optionally with a wiretap on the bytes in each direction. */
async function tcpPair(): Promise<{ client: Socket; server: Socket; close(): void }> {
	const listener = createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	const accepted = new Promise<Socket>((resolve) => listener.once("connection", resolve));
	const client = connect(port, "127.0.0.1");
	const server = await accepted;
	return { client, server, close: () => { client.destroy(); server.destroy(); listener.close(); } };
}
const next = (channel: SecureChannel) => new Promise<unknown>((resolve) => channel.once("message", resolve));

describe("secure channel", () => {
	it("connects two paired people and carries messages both ways", async () => {
		const { client, server, close } = await tcpPair();
		const [a, b] = await Promise.all([
			openChannel(client, { identity: yan, initiator: true, keyOf: book(sam), expect: "sam" }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		expect([a.peer, b.peer]).toEqual(["sam", "yan"]);
		const got = next(b);
		a.send({ hello: "sam", n: [1, 2, 3], text: "a b\n" });
		expect(await got).toEqual({ hello: "sam", n: [1, 2, 3], text: "a b\n" });
		const back = next(a);
		b.send("hi yan");
		expect(await back).toBe("hi yan");
		close();
	});

	it("holds frames that arrive before anyone is listening", async () => {
		const { client, server, close } = await tcpPair();
		const [a, b] = await Promise.all([
			openChannel(client, { identity: yan, initiator: true, keyOf: book(sam) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		a.send("early one");
		a.send("early two");
		await new Promise((resolve) => setTimeout(resolve, 50)); // b has not attached a listener yet
		const received: unknown[] = [];
		const done = new Promise<void>((resolve) => b.on("message", (m) => { received.push(m); if (received.length === 2) resolve(); }));
		await done;
		expect(received).toEqual(["early one", "early two"]);
		close();
	});

	it("delivers many frames in order, including one large one", async () => {
		const { client, server, close } = await tcpPair();
		const [a, b] = await Promise.all([
			openChannel(client, { identity: yan, initiator: true, keyOf: book(sam) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		const received: unknown[] = [];
		const done = new Promise<void>((resolve) => b.on("message", (m) => { received.push(m); if (received.length === 52) resolve(); }));
		for (let i = 0; i < 50; i++) a.send(i);
		a.send("x".repeat(3_000_000));
		a.send("end");
		await done;
		expect(received.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => i));
		expect((received[50] as string).length).toBe(3_000_000);
		expect(received[51]).toBe("end");
		close();
	});

	it("puts nothing readable on the wire after the greeting", async () => {
		const { client, server, close } = await tcpPair();
		const wire: Buffer[] = [];
		server.on("data", (chunk: Buffer) => wire.push(chunk));
		const [a, b] = await Promise.all([
			openChannel(client, { identity: yan, initiator: true, keyOf: book(sam) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		const got = next(b);
		a.send({ secret: "the password is heliotrope" });
		await got;
		expect(Buffer.concat(wire).toString("latin1")).not.toContain("heliotrope");
		close();
	});

	it("refuses a stranger, and tells the human who knocked", async () => {
		const { client, server, close } = await tcpPair();
		const knocks: string[] = [];
		const results = await Promise.allSettled([
			openChannel(client, { identity: mallory, initiator: true, keyOf: book(sam) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan), onStranger: (name, key) => knocks.push(`${name}:${key === mallory.publicKey}`) }),
		]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(HandshakeError);
		expect(String((results[1] as PromiseRejectedResult).reason)).toContain("not someone you have paired with");
		expect(knocks).toEqual(["mallory:true"]);
		close();
	});

	it("refuses someone using a paired name with a different key", async () => {
		const { client, server, close } = await tcpPair();
		const results = await Promise.allSettled([
			openChannel(client, { identity: fakeYan, initiator: true, keyOf: book(sam) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		expect(String((results[1] as PromiseRejectedResult).reason)).toContain("different key");
		close();
	});

	it("refuses a responder who claims a paired name and key but cannot sign", async () => {
		const { client, server, close } = await tcpPair();
		// The impostor replays sam's public key but signs with their own private key.
		const impostor = Object.create(mallory, { name: { value: "sam" }, publicKey: { value: sam.publicKey } }) as Identity;
		const results = await Promise.allSettled([
			openChannel(client, { identity: yan, initiator: true, keyOf: book(sam), expect: "sam" }),
			openChannel(server, { identity: impostor, initiator: false, keyOf: book(yan) }),
		]);
		expect(results[0]?.status).toBe("rejected");
		expect(String((results[0] as PromiseRejectedResult).reason)).toContain("could not prove who they are");
		close();
	});

	it("refuses an initiator who claims a paired name and key but cannot sign", async () => {
		const { client, server, close } = await tcpPair();
		const impostor = Object.create(mallory, { name: { value: "yan" }, publicKey: { value: yan.publicKey } }) as Identity;
		const results = await Promise.allSettled([
			openChannel(client, { identity: impostor, initiator: true, keyOf: book(sam) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		expect(results[1]?.status).toBe("rejected");
		close();
	});

	it("fails when the initiator reaches someone other than the person it dialled", async () => {
		const { client, server, close } = await tcpPair();
		const results = await Promise.allSettled([
			openChannel(client, { identity: yan, initiator: true, keyOf: book(sam, mallory), expect: "sam" }),
			openChannel(server, { identity: mallory, initiator: false, keyOf: book(yan) }),
		]);
		expect(String((results[0] as PromiseRejectedResult).reason)).toContain("Expected to reach sam, but mallory answered");
		close();
	});

	it("closes when a frame is tampered with in transit, delivering nothing from it", async () => {
		// A man in the middle that flips one bit in a frame after the handshake.
		const toB = new PassThrough();
		const toA = new PassThrough();
		let tamper = false;
		const { Duplex } = await import("node:stream");
		const sideA = new Duplex({ read() {}, write(chunk: Buffer, _enc, cb) { if (tamper) { chunk = Buffer.from(chunk); chunk.writeUInt8(chunk.readUInt8(chunk.length - 1) ^ 1, chunk.length - 1); } toB.write(chunk); cb(); } });
		const sideB = new Duplex({ read() {}, write(chunk, _enc, cb) { toA.write(chunk); cb(); } });
		toB.on("data", (chunk) => sideB.push(chunk));
		toA.on("data", (chunk) => sideA.push(chunk));
		const [a, b] = await Promise.all([
			openChannel(sideA, { identity: yan, initiator: true, keyOf: book(sam) }),
			openChannel(sideB, { identity: sam, initiator: false, keyOf: book(yan) }),
		]);
		const received: unknown[] = [];
		b.on("message", (m) => received.push(m));
		const closed = new Promise<void>((resolve) => b.once("close", resolve));
		tamper = true;
		a.send({ transfer: "session" });
		await closed;
		expect(received).toEqual([]);
		expect(b.isClosed).toBe(true);
	});

	it("rejects junk instead of a greeting, and times out a silent peer", async () => {
		const first = await tcpPair();
		const junk = openChannel(first.server, { identity: sam, initiator: false, keyOf: book(yan) });
		first.client.write("GET / HTTP/1.1\r\n\r\n");
		await expect(junk).rejects.toThrow(/did not speak the pi-lattice protocol/);
		first.close();

		const second = await tcpPair();
		await expect(openChannel(second.server, { identity: sam, initiator: false, keyOf: book(yan), timeoutMs: 50 })).rejects.toThrow(/in time/);
		second.close();
	});
});

describe("secure channel inside a network", () => {
	const secret = Buffer.alloc(32, 7);
	const other = Buffer.alloc(32, 8);
	const nobody = () => undefined;

	it("lets in someone not seen before who holds the network's secret, and reports them once they have proved it", async () => {
		const { client, server, close } = await tcpPair();
		const met: string[] = [];
		const [a, b] = await Promise.all([
			openChannel(client, { identity: yan, initiator: true, keyOf: nobody, network: secret, onMember: (name, key) => met.push(`yan met ${name} ${key === sam.publicKey}`) }),
			openChannel(server, { identity: sam, initiator: false, keyOf: nobody, network: secret, onMember: (name, key) => met.push(`sam met ${name} ${key === yan.publicKey}`) }),
		]);
		expect([a.peer, b.peer]).toEqual(["sam", "yan"]);
		expect(met.sort()).toEqual(["sam met yan true", "yan met sam true"]);
		const got = next(b);
		a.send("hello");
		expect(await got).toBe("hello");
		close();
	});

	it("refuses someone with another network's secret, or none, without pinning them", async () => {
		for (const theirs of [other, undefined]) {
			const { client, server, close } = await tcpPair();
			const met: string[] = [];
			const results = await Promise.allSettled([
				openChannel(client, { identity: mallory, initiator: true, keyOf: book(sam), ...(theirs ? { network: theirs } : {}), timeoutMs: 500 }),
				openChannel(server, { identity: sam, initiator: false, keyOf: nobody, network: secret, onMember: (name) => met.push(name), timeoutMs: 500 }),
			]);
			expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
			expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(HandshakeError);
			expect(met).toEqual([]);
			close();
		}
	});

	it("still refuses a known name with a different key, even with the secret", async () => {
		const { client, server, close } = await tcpPair();
		const changed: string[] = [];
		const results = await Promise.allSettled([
			openChannel(client, { identity: fakeYan, initiator: true, keyOf: nobody, network: secret, timeoutMs: 500 }),
			openChannel(server, { identity: sam, initiator: false, keyOf: book(yan), network: secret, onChangedKey: (name) => changed.push(name), timeoutMs: 500 }),
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(changed).toEqual(["yan"]);
		close();
	});

	it("connects only hosts working on the same thing", async () => {
		const { client, server, close } = await tcpPair();
		const results = await Promise.allSettled([
			openChannel(client, { identity: yan, initiator: true, keyOf: nobody, network: secret, scope: "repo-a", timeoutMs: 500 }),
			openChannel(server, { identity: sam, initiator: false, keyOf: nobody, network: secret, scope: "repo-b", timeoutMs: 500 }),
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(String((results[1] as PromiseRejectedResult).reason)).toContain("working on something else");
		close();
	});
});
