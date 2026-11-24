import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvelope, FrameDecoder, newNodeId } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Connection, type SocketHandlers, SocketServer } from "../src/socket-server.ts";

let dir: string;
let server: SocketServer;
let seen: string[];
let failing: boolean;
const handlers: SocketHandlers = {
	authenticate: (hello) => hello.token === "secret",
	onHello: (_connection, hello) => void seen.push(`hello ${hello.channel}`),
	onRequest: async (_connection, op, params) => {
		if (failing) throw new Error("no");
		return { op, params };
	},
	onAck: (_connection: Connection, envelopeId) => {
		// What the store does with a value that is not text: the host must never be handed one.
		if (typeof envelopeId !== "string") throw new TypeError("not a string");
		seen.push(`ack ${envelopeId}`);
	},
	onMail: (_connection, envelope, state) => void seen.push(`mail ${envelope.id} ${state}`),
	onClose: () => void seen.push("close"),
};
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pi-lattice-socket-"));
	seen = [];
	failing = false;
	server = new SocketServer(join(dir, "host.sock"), handlers);
	await server.listen();
});
afterEach(async () => {
	await server.close();
	rmSync(dir, { recursive: true, force: true });
});

const HELLO = { t: "hello", token: "secret", nodeId: "nd_1", channel: "a2a", protocol: 1, pid: 1 };
/** A connection that says what it is given, as lines, and collects what comes back. */
async function dial(...first: unknown[]): Promise<{ socket: Socket; frames: unknown[]; say(...lines: unknown[]): void; closed: Promise<void> }> {
	const socket = connect(join(dir, "host.sock"));
	const decoder = new FrameDecoder();
	const frames: unknown[] = [];
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => frames.push(...decoder.push(chunk)));
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	const say = (...lines: unknown[]): void => void socket.write(lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
	say(...first);
	return { socket, frames, say, closed };
}
const until = async (probe: () => unknown, what: string) => {
	const end = Date.now() + 3000;
	while (!probe()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

describe("the host's socket", () => {
	it("answers requests, and takes acks and mail, from a session that said who it is", async () => {
		const envelope = createEnvelope({ from: newNodeId(), fromOwner: "yan", to: newNodeId(), text: "hi", seq: 1 });
		const client = await dial(HELLO, { t: "req", rid: "1", op: "peers", params: {} }, { t: "ack", envelopeId: "env_1" }, { t: "mail", envelope, state: "pending" });
		await until(() => client.frames.length === 2 && seen.length === 3, "the answer");
		expect(client.frames).toEqual([{ t: "welcome", nodeId: "nd_1" }, { t: "res", rid: "1", ok: true, result: { op: "peers", params: {} } }]);
		expect(seen).toEqual(["hello a2a", "ack env_1", `mail ${envelope.id} pending`]);
		failing = true;
		client.say({ t: "req", rid: "2", op: "peers", params: {} });
		await until(() => client.frames.length === 3, "the refusal");
		expect(client.frames[2]).toEqual({ t: "res", rid: "2", ok: false, error: "no" });
		client.socket.destroy();
	});

	it("drops a connection without the token, or whose hello is not one, and tells it nothing", async () => {
		for (const hello of [{ ...HELLO, token: "wrong" }, { ...HELLO, channel: "root" }, { ...HELLO, sessionFile: { a: 1 } }, { ...HELLO, nodeId: 7 }, null, "null", [HELLO]]) {
			const client = await dial(hello);
			await client.closed;
			expect(client.frames, JSON.stringify(hello)).toEqual([]);
		}
		expect(seen.filter((entry) => entry.startsWith("hello"))).toEqual([]);
	});

	it("ends the connection that sends what is not a frame, and goes on serving the others", async () => {
		const envelope = createEnvelope({ from: newNodeId(), fromOwner: "yan", to: newNodeId(), text: "hi", seq: 1 });
		const good = await dial(HELLO);
		const malformed: unknown[] = [
			"null", "7", '"text"', "[]",
			{ t: "ack", envelopeId: { a: 1 } }, { t: "ack" },
			{ t: "req", op: "peers" }, { t: "req", rid: 1, op: "peers" }, { t: "req", rid: "1", op: { a: 1 } },
			{ t: "mail", envelope: null, state: "pending" }, { t: "mail", envelope: { id: { a: 1 } }, state: "pending" }, { t: "mail", envelope, state: "nonsense" }, { t: "mail", envelope, state: { a: 1 } },
		];
		for (const frame of malformed) {
			const client = await dial(HELLO, frame);
			await client.closed; // closed by the host, which is still there to close it
		}
		expect(seen.filter((entry) => entry.startsWith("ack") || entry.startsWith("mail"))).toEqual([]);
		good.say({ t: "req", rid: "after", op: "peers", params: {} });
		await until(() => good.frames.length === 2, "an answer on the connection that behaved");
		expect(good.frames[1]).toMatchObject({ rid: "after", ok: true });
		good.socket.destroy();
	});

	it("leaves alone a kind of frame it does not know", async () => {
		const client = await dial(HELLO, { t: "something-newer", with: 1 }, { t: "req", rid: "1", op: "peers", params: {} });
		await until(() => client.frames.length === 2, "the answer after it");
		client.socket.destroy();
	});
});
