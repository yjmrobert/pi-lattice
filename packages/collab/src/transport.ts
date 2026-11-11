/**
 * How two hosts open a byte stream to each other. The channel on top authenticates and
 * encrypts, so a transport only has to move bytes. TCP is the one shipped: it covers a
 * LAN, a VPN and an SSH tunnel. A hole-punching transport would implement the same interface.
 */
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface PeerTransport {
	/** Start accepting connections. Resolves with the `host:port` actually bound. */
	listen(onConnection: (stream: Duplex) => void): Promise<string>;
	/** Open a stream to an address. Rejects when it cannot be reached. */
	connect(address: string): Promise<Duplex>;
	close(): Promise<void>;
}

export interface TcpTransportOptions {
	/** Interface to listen on. Defaults to all interfaces. */
	host?: string;
	/** Port to listen on. 0 picks a free one. */
	port?: number;
	connectTimeoutMs?: number;
}

export function splitAddress(address: string): { host: string; port: number } {
	const at = address.lastIndexOf(":");
	const port = Number(address.slice(at + 1));
	if (at <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${address}" is not a host:port address.`);
	return { host: address.slice(0, at).replace(/^\[|\]$/g, ""), port };
}

export class TcpTransport implements PeerTransport {
	private readonly options: TcpTransportOptions;
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();

	constructor(options: TcpTransportOptions = {}) {
		this.options = options;
	}

	private track(socket: Socket): Socket {
		this.sockets.add(socket);
		socket.setNoDelay(true);
		socket.on("close", () => this.sockets.delete(socket));
		socket.on("error", () => {});
		return socket;
	}

	async listen(onConnection: (stream: Duplex) => void): Promise<string> {
		const server = createServer((socket) => onConnection(this.track(socket)));
		this.server = server;
		const host = this.options.host ?? "0.0.0.0";
		await new Promise<void>((resolve, reject) => {
			server.once("error", (error: NodeJS.ErrnoException) => {
				reject(new Error(error.code === "EADDRINUSE" ? `Port ${this.options.port} is already in use. Choose another with --listen.` : error.message));
			});
			server.listen(this.options.port ?? 0, host, () => resolve());
		});
		return `${host}:${(server.address() as { port: number }).port}`;
	}

	connect(address: string): Promise<Duplex> {
		const { host, port } = splitAddress(address);
		return new Promise<Duplex>((resolve, reject) => {
			const socket = connect({ host, port });
			const timer = setTimeout(() => socket.destroy(new Error("timed out")), this.options.connectTimeoutMs ?? 5000);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve(this.track(socket));
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(new Error(`Could not reach ${address}: ${error.message}`));
			});
		});
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
