/**
 * Host-less transport: a maildir-style spool on the local filesystem.
 *
 *   <home>/nodes/<id>/node.json      registration, read by peers()
 *   <home>/nodes/<id>/inbox/tmp/     senders write here first
 *   <home>/nodes/<id>/inbox/new/     then rename into here (atomic on one filesystem)
 *   <home>/nodes/<id>/inbox/failed/  items the handler could not process
 *
 * A message to a node that is not running waits in its inbox until it starts again.
 */
import { existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Envelope, isId, isRelativeAddress, type PeerInfo } from "@pi-lattice/protocol";
import { isProcessAlive, readJson, writeFileAtomic } from "./fsutil.ts";
import { nodeDir, nodesDir } from "./paths.ts";
import { type InboundHandler, type SelfInfo, type Transport, TransportError } from "./transport.ts";

export interface FileTransportOptions {
	home: string;
	self: SelfInfo;
	/** Poll interval in milliseconds, a fallback for filesystems where watch is unreliable. */
	pollMs?: number;
}

export class FileTransport implements Transport {
	readonly kind = "file";
	private readonly home: string;
	private readonly self: SelfInfo;
	private readonly pollMs: number;
	private handler: InboundHandler | undefined;
	private watcher: FSWatcher | undefined;
	private timer: NodeJS.Timeout | undefined;
	private draining = false;
	private drainAgain = false;
	private closed = false;

	constructor(options: FileTransportOptions) {
		this.home = options.home;
		this.self = options.self;
		this.pollMs = options.pollMs ?? 1000;
	}

	private inbox(nodeId: string, part: "tmp" | "new" | "failed"): string {
		return join(nodeDir(this.home, nodeId), "inbox", part);
	}

	async send(envelope: Envelope): Promise<string[]> {
		const to = envelope.to;
		if (isRelativeAddress(to)) {
			throw new TransportError(`"${to}" is a tree-relative address and needs a lattice host. Without a host, address a node id (see list_peers).`);
		}
		if (!isId(to)) throw new TransportError(`"${to}" is not a node id.`);
		if (to === this.self.id) throw new TransportError("Cannot send a message to yourself.");
		if (!existsSync(join(nodeDir(this.home, to), "node.json"))) {
			throw new TransportError(`No node ${to} is known here. Use list_peers to see reachable nodes.`);
		}
		const name = `${envelope.id}.json`;
		const tmp = join(this.inbox(to, "tmp"), name);
		mkdirSync(this.inbox(to, "tmp"), { recursive: true });
		mkdirSync(this.inbox(to, "new"), { recursive: true });
		writeFileSync(tmp, JSON.stringify(envelope));
		renameSync(tmp, join(this.inbox(to, "new"), name));
		return [to];
	}

	async subscribe(handler: InboundHandler): Promise<void> {
		this.handler = handler;
		for (const part of ["tmp", "new", "failed"] as const) mkdirSync(this.inbox(this.self.id, part), { recursive: true });
		this.register();
		try {
			this.watcher = watch(this.inbox(this.self.id, "new"), () => this.drain());
			this.watcher.on("error", () => {});
		} catch {
			// Polling alone still works.
		}
		this.timer = setInterval(() => this.drain(), this.pollMs);
		this.timer.unref();
		this.drain();
	}

	private register(): void {
		writeFileAtomic(
			join(nodeDir(this.home, this.self.id), "node.json"),
			JSON.stringify({ ...this.self, pid: process.pid, updatedAt: new Date().toISOString() }),
		);
	}

	/** Process everything in the inbox, oldest first. Runs are serialized. */
	private drain(): void {
		if (this.closed || !this.handler) return;
		if (this.draining) {
			this.drainAgain = true;
			return;
		}
		this.draining = true;
		void this.drainOnce().finally(() => {
			this.draining = false;
			if (this.drainAgain) {
				this.drainAgain = false;
				this.drain();
			}
		});
	}

	private async drainOnce(): Promise<void> {
		const dir = this.inbox(this.self.id, "new");
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (this.closed || !this.handler) return;
			const path = join(dir, name);
			let value: unknown;
			try {
				value = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				value = undefined;
			}
			try {
				await this.handler(value);
				unlinkSync(path);
			} catch {
				try {
					renameSync(path, join(this.inbox(this.self.id, "failed"), name));
				} catch {
					// Leave it; the next drain retries.
				}
			}
		}
	}

	async peers(): Promise<PeerInfo[]> {
		const out: PeerInfo[] = [];
		let ids: string[];
		try {
			ids = readdirSync(nodesDir(this.home));
		} catch {
			return out;
		}
		for (const id of ids.sort()) {
			if (!isId(id) || id === this.self.id) continue;
			const info = readJson(join(nodeDir(this.home, id), "node.json")) as (Partial<SelfInfo> & { pid?: number }) | undefined;
			if (!info) continue;
			out.push({
				id,
				name: info.name ?? id,
				owner: info.owner ?? "unknown",
				...(info.cwd ? { cwd: info.cwd } : {}),
				relation: "other",
				status: info.pid !== undefined && isProcessAlive(info.pid) ? "online" : "offline",
			});
		}
		return out;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.watcher?.close();
		this.watcher = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.handler = undefined;
	}
}
