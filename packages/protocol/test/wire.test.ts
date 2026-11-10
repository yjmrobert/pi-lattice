import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, HostClient, type HostFrame } from "../src/index.ts";

describe("FrameDecoder", () => {
	it("reassembles frames split across chunks", () => {
		const decoder = new FrameDecoder();
		expect(decoder.push('{"t":"wel')).toEqual([]);
		expect(decoder.push('come","nodeId":"nd_1"}\n{"t":"x"}\n{"par')).toEqual([{ t: "welcome", nodeId: "nd_1" }, { t: "x" }]);
		expect(decoder.push('tial":1}\n')).toEqual([{ partial: 1 }]);
	});

	it("does not split on unicode line separators inside strings", () => {
		const frame = { t: "deliver", text: "a b c" };
		expect(new FrameDecoder().push(`${JSON.stringify(frame)}\n`)).toEqual([frame]);
	});

	it("skips malformed lines and tolerates CRLF", () => {
		expect(new FrameDecoder().push('not json\n{"ok":1}\r\n\n')).toEqual([{ ok: 1 }]);
	});

	it("refuses an unbounded frame", () => {
		expect(() => new FrameDecoder(16).push("x".repeat(64))).toThrow(/maximum size/);
	});
});

/** An in-memory stream pair standing in for a socket. */
function fakeStream() {
	const emitter = new EventEmitter();
	const written: unknown[] = [];
	const stream = {
		write: (data: string) => void written.push(...new FrameDecoder().push(data)),
		on: (event: string, listener: (...args: never[]) => void) => emitter.on(event, listener as (...args: unknown[]) => void),
		end: () => emitter.emit("close"),
	};
	const receive = (frame: HostFrame) => emitter.emit("data", encodeFrame(frame));
	return { stream, written, receive, emitter };
}
const options = { token: "tok", nodeId: "nd_1", channel: "a2a" as const, pid: 1 };

describe("HostClient", () => {
	it("says hello first, with its token and channel", () => {
		const { stream, written } = fakeStream();
		new HostClient({ ...options, stream, sessionId: "s1" });
		expect(written[0]).toMatchObject({ t: "hello", token: "tok", nodeId: "nd_1", channel: "a2a", protocol: 1, sessionId: "s1" });
	});

	it("becomes ready on welcome", async () => {
		const { stream, receive } = fakeStream();
		const client = new HostClient({ ...options, stream });
		receive({ t: "welcome", nodeId: "nd_1" });
		await expect(client.ready()).resolves.toBeUndefined();
	});

	it("correlates responses with requests, out of order", async () => {
		const { stream, receive, written } = fakeStream();
		const client = new HostClient({ ...options, stream });
		const first = client.request("peers", {});
		const second = client.request("list", {});
		const [, a, b] = written as Array<{ rid: string }>;
		receive({ t: "res", rid: b?.rid ?? "", ok: true, result: { self: "nd_1", nodes: [] } });
		receive({ t: "res", rid: a?.rid ?? "", ok: true, result: { peers: [] } });
		await expect(first).resolves.toEqual({ peers: [] });
		await expect(second).resolves.toEqual({ self: "nd_1", nodes: [] });
	});

	it("rejects a request the host refuses, with the host's message", async () => {
		const { stream, receive, written } = fakeStream();
		const client = new HostClient({ ...options, stream });
		const request = client.request("spawn", { spec: { name: "x", brief: "y" } });
		receive({ t: "res", rid: (written[1] as { rid: string }).rid, ok: false, error: "too many children" });
		await expect(request).rejects.toThrow("too many children");
	});

	it("fails pending requests when the connection drops, and later ones immediately", async () => {
		const { stream, emitter } = fakeStream();
		const client = new HostClient({ ...options, stream });
		const request = client.request("peers", {});
		emitter.emit("close");
		await expect(request).rejects.toThrow(/connection closed/);
		await expect(client.request("peers", {})).rejects.toThrow(/connection closed/);
		await expect(client.ready()).rejects.toThrow(/connection closed/);
	});

	it("times out a request the host never answers", async () => {
		const { stream } = fakeStream();
		const client = new HostClient({ ...options, stream, requestTimeoutMs: 20 });
		await expect(client.request("peers", {})).rejects.toThrow(/did not answer/);
	});

	it("passes deliver and decide frames to listeners", () => {
		const { stream, receive } = fakeStream();
		const client = new HostClient({ ...options, stream });
		const seen: string[] = [];
		client.onFrame((frame) => seen.push(frame.t));
		receive({ t: "decide", envelopeId: "env_1", action: "approve" });
		expect(seen).toEqual(["decide"]);
	});
});
