/** The host's local socket: authenticates lattice extensions and turns frames into calls. */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type Channel, type ClientFrame, type Envelope, encodeFrame, FrameDecoder, type HostFrame, INBOUND_STATES, MAX_HOST_FRAME, type InboundState, type RequestOp, validateEnvelope } from "@pi-lattice/protocol";

export interface Connection {
	/** Unique per connection. */
	readonly id: string;
	readonly nodeId: string;
	readonly channel: Channel;
	send(frame: HostFrame): void;
	close(): void;
}

export type Hello = Extract<ClientFrame, { t: "hello" }>;

export interface SocketHandlers {
	/** Whether this hello carries a valid token for what it claims to be. Anything else is dropped without a reply. */
	authenticate(hello: Hello): boolean;
	onHello(connection: Connection, hello: Hello): void;
	onRequest(connection: Connection, op: RequestOp, params: unknown): Promise<unknown>;
	onAck(connection: Connection, envelopeId: string): void;
	onMail(connection: Connection, envelope: Envelope, state: InboundState): void;
	onClose(connection: Connection): void;
}

const HELLO_TIMEOUT_MS = 5000;
const CHANNELS: readonly string[] = ["a2a", "graph", "collab", "ui"] satisfies Channel[];
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

/** Whether a first frame is a hello in every part the host goes on to use. */
function isHello(frame: unknown): frame is Hello {
	if (frame === null || typeof frame !== "object") return false;
	const hello = frame as Partial<Record<keyof Hello, unknown>>;
	return hello.t === "hello" && typeof hello.token === "string" && typeof hello.nodeId === "string" && typeof hello.channel === "string" && CHANNELS.includes(hello.channel) &&
		optionalString(hello.sessionId) && optionalString(hello.sessionFile);
}

export class SocketServer {
	private readonly path: string;
	private readonly handlers: SocketHandlers;
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();
	private counter = 0;

	constructor(path: string, handlers: SocketHandlers) {
		this.path = path;
		this.handlers = handlers;
	}

	async listen(): Promise<void> {
		if (existsSync(this.path)) unlinkSync(this.path);
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.path, () => resolve());
		});
		chmodSync(this.path, 0o600);
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		const decoder = new FrameDecoder(MAX_HOST_FRAME);
		let connection: Connection | undefined;
		const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);

		socket.on("data", (chunk: string) => {
			let frames: unknown[];
			try {
				frames = decoder.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (!connection) {
					if (!isHello(frame) || !this.handlers.authenticate(frame)) {
						socket.destroy();
						return;
					}
					clearTimeout(helloTimer);
					const established: Connection = {
						id: `c${++this.counter}`,
						nodeId: frame.nodeId,
						channel: frame.channel,
						send: (out) => {
							if (!socket.destroyed) socket.write(encodeFrame(out));
						},
						close: () => socket.end(),
					};
					connection = established;
					established.send({ t: "welcome", nodeId: frame.nodeId });
					this.handlers.onHello(established, frame);
					continue;
				}
				// A frame is whatever the other end wrote. One that is not a frame, or that the host
				// cannot take, ends that connection: it must never end the host and every session with it.
				let taken = false;
				try {
					taken = this.dispatch(connection, frame);
				} catch {
					taken = false;
				}
				if (!taken) {
					socket.destroy();
					return;
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(helloTimer);
			this.sockets.delete(socket);
			if (connection) this.handlers.onClose(connection);
		});
	}

	/** Hand a frame to the host. False when it is not one: the shape of each is checked here, once, for everything behind it. */
	private dispatch(connection: Connection, raw: unknown): boolean {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
		const frame = raw as { t?: unknown; rid?: unknown; op?: unknown; params?: unknown; envelopeId?: unknown; envelope?: unknown; state?: unknown };
		if (frame.t === "req") {
			const { rid, op } = frame;
			if (typeof rid !== "string" || typeof op !== "string") return false;
			const refuse = (error: unknown): void => connection.send({ t: "res", rid, ok: false, error: error instanceof Error ? error.message : String(error) });
			let asked: Promise<unknown>;
			try {
				asked = this.handlers.onRequest(connection, op as RequestOp, frame.params);
			} catch (error) {
				refuse(error);
				return true;
			}
			asked.then((result) => connection.send({ t: "res", rid, ok: true, result })).catch(refuse);
		} else if (frame.t === "ack") {
			if (typeof frame.envelopeId !== "string") return false;
			this.handlers.onAck(connection, frame.envelopeId);
		} else if (frame.t === "mail") {
			// Its shape is what is checked. How large a message may be was decided when it was taken.
			const checked = validateEnvelope(frame.envelope, { maxPayloadBytes: Number.POSITIVE_INFINITY, maxHops: Number.POSITIVE_INFINITY });
			if (!checked.ok || typeof frame.state !== "string" || !(INBOUND_STATES as readonly string[]).includes(frame.state)) return false;
			this.handlers.onMail(connection, checked.envelope, frame.state as InboundState);
		}
		// A kind of frame not known here is from a newer session: it is left alone.
		return true;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (existsSync(this.path)) unlinkSync(this.path);
	}
}
