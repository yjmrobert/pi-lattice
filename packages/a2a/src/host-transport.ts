/** Transport through a lattice host: every envelope goes via the host's broker, which journals it. */
import { connect } from "node:net";
import { type Envelope, HostClient, type InboundState, type PeerInfo } from "@pi-lattice/protocol";
import { type InboundHandler, type SelfInfo, type Transport, TransportError } from "./transport.ts";

export interface HostTransportOptions {
	socketPath: string;
	token: string;
	self: SelfInfo;
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
	connectTimeoutMs?: number;
}

export class HostTransport implements Transport {
	readonly kind = "host";
	private readonly client: HostClient;
	private handler: InboundHandler | undefined;
	private backlog: Envelope[] = [];
	private chain: Promise<void> = Promise.resolve();
	private decisionHandler: ((envelopeId: string, action: "approve" | "reject") => void) | undefined;

	private constructor(client: HostClient) {
		this.client = client;
		client.onFrame((frame) => {
			if (frame.t === "deliver") {
				if (this.handler) this.dispatch(frame.envelope);
				else this.backlog.push(frame.envelope);
			} else if (frame.t === "decide") {
				this.decisionHandler?.(frame.envelopeId, frame.action);
			}
		});
	}

	/** Connect and authenticate. Rejects when the host is unreachable or refuses the token. */
	static async connect(options: HostTransportOptions): Promise<HostTransport> {
		const socket = connect(options.socketPath);
		socket.setEncoding("utf8");
		const client = new HostClient({
			stream: socket, token: options.token, nodeId: options.self.id, channel: "a2a", pid: process.pid,
			sessionId: options.sessionId, sessionFile: options.sessionFile,
		});
		const transport = new HostTransport(client);
		const timeout = new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("lattice host did not respond")), options.connectTimeoutMs ?? 3000);
			timer.unref();
		});
		try {
			await Promise.race([client.ready(), timeout]);
		} catch (error) {
			client.close();
			socket.destroy();
			throw error;
		}
		return transport;
	}

	/** Deliver one at a time, in arrival order, and acknowledge only after the handler stored it. */
	private dispatch(envelope: Envelope): void {
		this.chain = this.chain.then(async () => {
			try {
				await this.handler?.(envelope);
				this.client.notify({ t: "ack", envelopeId: envelope.id });
			} catch {
				// Not acknowledged: the host redelivers on the next connection.
			}
		});
	}

	async send(envelope: Envelope): Promise<string[]> {
		try {
			return (await this.client.request("send", { envelope })).recipients;
		} catch (error) {
			throw new TransportError(error instanceof Error ? error.message : String(error));
		}
	}

	async subscribe(handler: InboundHandler): Promise<void> {
		this.handler = handler;
		for (const envelope of this.backlog.splice(0)) this.dispatch(envelope);
	}

	async peers(): Promise<PeerInfo[]> {
		return (await this.client.request("peers", {})).peers;
	}

	reportMail(envelope: Envelope, state: InboundState): void {
		this.client.notify({ t: "mail", envelope, state });
	}

	onDecision(handler: (envelopeId: string, action: "approve" | "reject") => void): void {
		this.decisionHandler = handler;
	}

	async close(): Promise<void> {
		this.handler = undefined;
		this.client.close();
	}
}
