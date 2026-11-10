/** The host's local socket: authenticates lattice extensions and turns frames into calls. */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { type Channel, type ClientFrame, type Envelope, encodeFrame, FrameDecoder, type HostFrame, type InboundState, type RequestOp } from "@pi-lattice/protocol";

export interface Connection {
	readonly nodeId: string;
	readonly channel: Channel;
	send(frame: HostFrame): void;
	close(): void;
}

export type Hello = Extract<ClientFrame, { t: "hello" }>;

export interface SocketHandlers {
	/** Whether this token belongs to this node. Anything else is dropped without a reply. */
	authenticate(token: string, nodeId: string): boolean;
	onHello(connection: Connection, hello: Hello): void;
	onRequest(connection: Connection, op: RequestOp, params: unknown): Promise<unknown>;
	onAck(connection: Connection, envelopeId: string): void;
	onMail(connection: Connection, envelope: Envelope, state: InboundState): void;
	onClose(connection: Connection): void;
}

const HELLO_TIMEOUT_MS = 5000;

export class SocketServer {
	private readonly path: string;
	private readonly handlers: SocketHandlers;
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();

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
		const decoder = new FrameDecoder();
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
			for (const raw of frames) {
				const frame = raw as ClientFrame;
				if (!connection) {
					if (frame?.t !== "hello" || typeof frame.token !== "string" || typeof frame.nodeId !== "string" || !this.handlers.authenticate(frame.token, frame.nodeId)) {
						socket.destroy();
						return;
					}
					clearTimeout(helloTimer);
					const established: Connection = {
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
				this.dispatch(connection, frame);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(helloTimer);
			this.sockets.delete(socket);
			if (connection) this.handlers.onClose(connection);
		});
	}

	private dispatch(connection: Connection, frame: ClientFrame): void {
		if (frame.t === "req") {
			const rid = frame.rid;
			this.handlers.onRequest(connection, frame.op, frame.params).then(
				(result) => connection.send({ t: "res", rid, ok: true, result }),
				(error: unknown) => connection.send({ t: "res", rid, ok: false, error: error instanceof Error ? error.message : String(error) }),
			);
		} else if (frame.t === "ack") {
			this.handlers.onAck(connection, frame.envelopeId);
		} else if (frame.t === "mail") {
			this.handlers.onMail(connection, frame.envelope, frame.state);
		}
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (existsSync(this.path)) unlinkSync(this.path);
	}
}
