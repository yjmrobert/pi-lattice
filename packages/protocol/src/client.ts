/**
 * Client side of the host socket, shared by the lattice extensions. It takes a duplex
 * stream instead of opening one, so this package stays free of I/O and Pi dependencies.
 */
import { PROTOCOL_VERSION } from "./envelope.ts";
import { type Channel, type ClientFrame, encodeFrame, FrameDecoder, type HostFrame, type RequestMap, type RequestOp, type UiApi, type UiMethod } from "./wire.ts";

/** The part of a socket the client needs. `node:net` sockets satisfy it. */
export interface DuplexLike {
	write(data: string): unknown;
	on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	end(): unknown;
}

export interface HostClientOptions {
	stream: DuplexLike;
	token: string;
	nodeId: string;
	channel: Channel;
	pid: number;
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
	requestTimeoutMs?: number;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class HostClient {
	private readonly stream: DuplexLike;
	private readonly decoder = new FrameDecoder();
	private readonly pending = new Map<string, Pending>();
	private readonly listeners: Array<(frame: HostFrame) => void> = [];
	private readonly timeoutMs: number;
	private counter = 0;
	private closed = false;
	private welcomed: Promise<void>;

	constructor(options: HostClientOptions) {
		this.stream = options.stream;
		this.timeoutMs = options.requestTimeoutMs ?? 30_000;
		let welcome!: () => void;
		let refuse!: (error: Error) => void;
		this.welcomed = new Promise<void>((resolve, reject) => {
			welcome = resolve;
			refuse = reject;
		});
		this.welcomed.catch(() => {});

		this.stream.on("data", (chunk) => {
			let frames: unknown[];
			try {
				frames = this.decoder.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			} catch {
				this.close();
				return;
			}
			for (const raw of frames) {
				const frame = raw as HostFrame;
				if (frame.t === "welcome") welcome();
				else if (frame.t === "res") this.settle(frame);
				for (const listener of [...this.listeners]) listener(frame);
			}
		});
		const down = (): void => {
			this.closed = true;
			refuse(new Error("lattice host connection closed"));
			for (const [rid, entry] of this.pending) {
				clearTimeout(entry.timer);
				entry.reject(new Error("lattice host connection closed"));
				this.pending.delete(rid);
			}
		};
		this.stream.on("close", down);
		this.stream.on("error", down);

		const hello: ClientFrame = {
			t: "hello", token: options.token, nodeId: options.nodeId, channel: options.channel, protocol: PROTOCOL_VERSION, pid: options.pid,
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options.sessionFile !== undefined ? { sessionFile: options.sessionFile } : {}),
		};
		this.stream.write(encodeFrame(hello));
	}

	private settle(frame: Extract<HostFrame, { t: "res" }>): void {
		const entry = this.pending.get(frame.rid);
		if (!entry) return;
		this.pending.delete(frame.rid);
		clearTimeout(entry.timer);
		if (frame.ok) entry.resolve(frame.result);
		else entry.reject(new Error(frame.error));
	}

	/** Resolves once the host has accepted the hello. Rejects if the connection drops first. */
	ready(): Promise<void> {
		return this.welcomed;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	request<K extends RequestOp>(op: K, params: RequestMap[K]["params"]): Promise<RequestMap[K]["result"]> {
		if (this.closed) return Promise.reject(new Error("lattice host connection closed"));
		const rid = `r${++this.counter}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(rid);
				reject(new Error(`lattice host did not answer "${op}" in time`));
			}, this.timeoutMs);
			this.pending.set(rid, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.stream.write(encodeFrame({ t: "req", rid, op, params } as ClientFrame));
		});
	}

	/** Call the host's control API. Only valid on a `ui` connection. */
	ui<K extends UiMethod>(method: K, params: UiApi[K]["params"]): Promise<UiApi[K]["result"]> {
		return this.request("ui", { method, params }) as Promise<UiApi[K]["result"]>;
	}

	/** Send a frame that expects no response. */
	notify(frame: Extract<ClientFrame, { t: "ack" | "mail" }>): void {
		if (!this.closed) this.stream.write(encodeFrame(frame));
	}

	onFrame(listener: (frame: HostFrame) => void): void {
		this.listeners.push(listener);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stream.end();
	}
}
