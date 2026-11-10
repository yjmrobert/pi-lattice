/**
 * A Pi session running as a child process in RPC mode. A thin client for Pi's LF-delimited
 * JSON protocol; the host owns this instead of using Pi's RpcClient because it must answer
 * extension dialogs and handle exits itself (ADR 0005).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { FrameDecoder } from "@pi-lattice/protocol";

// biome-ignore lint/suspicious/noExplicitAny: RPC records are loosely typed JSON
export type RpcRecord = Record<string, any>;

export interface PiProcessOptions {
	/** Executable and leading arguments, for example ["pi"] or ["node", "/path/to/cli.js"]. */
	command: string[];
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
}

export interface ExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Set when the process could not be started at all. */
	error?: string;
}

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void };

/** Events: `event` (RpcRecord) for every session event and UI request; `exit` (ExitInfo) once. */
export class PiProcess extends EventEmitter {
	private readonly options: PiProcessOptions;
	private child: ChildProcess | undefined;
	private readonly pending = new Map<string, Pending>();
	private counter = 0;
	private stderr = "";
	private exitInfo: ExitInfo | undefined;
	private stopping = false;

	constructor(options: PiProcessOptions) {
		super();
		this.options = options;
	}

	start(): void {
		const [executable, ...leading] = this.options.command;
		if (!executable) throw new Error("no Pi command configured");
		const child = spawn(executable, [...leading, "--mode", "rpc", ...this.options.args], {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		const decoder = new FrameDecoder(64 * 1024 * 1024);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			let records: unknown[];
			try {
				records = decoder.push(chunk);
			} catch {
				return;
			}
			for (const record of records) this.handle(record as RpcRecord);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-8192);
		});
		child.stdin?.on("error", () => {});
		child.on("error", (error) => this.finish({ code: null, signal: null, error: error.message }));
		child.on("exit", (code, signal) => this.finish({ code, signal }));
	}

	private handle(record: RpcRecord): void {
		if (record.type === "response" && typeof record.id === "string") {
			const entry = this.pending.get(record.id);
			if (entry) {
				this.pending.delete(record.id);
				if (record.success) entry.resolve(record.data);
				else entry.reject(new Error(String(record.error ?? "command failed")));
				return;
			}
		}
		this.emit("event", record);
	}

	private finish(info: ExitInfo): void {
		if (this.exitInfo) return;
		this.exitInfo = info;
		for (const entry of this.pending.values()) entry.reject(new Error("Pi process exited"));
		this.pending.clear();
		this.emit("exit", info);
	}

	get exited(): ExitInfo | undefined {
		return this.exitInfo;
	}

	/** True when {@link stop} was called, so the exit is expected. */
	get stopRequested(): boolean {
		return this.stopping;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** The last few kilobytes of stderr, for diagnostics. Never parsed as protocol. */
	get stderrTail(): string {
		return this.stderr;
	}

	/** Send an RPC command and resolve with its `data`. Rejects when Pi reports failure or exits. */
	request<T = unknown>(command: RpcRecord): Promise<T> {
		if (this.exitInfo || !this.child?.stdin?.writable) return Promise.reject(new Error("Pi process is not running"));
		const id = `h${++this.counter}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
			this.child?.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	/** Answer an extension dialog. */
	respondUI(id: string, payload: RpcRecord): void {
		if (!this.exitInfo) this.child?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, ...payload })}\n`);
	}

	/** Ask for an orderly shutdown (stdin EOF), then escalate if the process lingers. */
	async stop(graceMs = 5000): Promise<void> {
		this.stopping = true;
		if (this.exitInfo || !this.child) return;
		const child = this.child;
		const exited = new Promise<void>((resolve) => this.once("exit", () => resolve()));
		child.stdin?.end();
		const term = setTimeout(() => child.kill("SIGTERM"), graceMs);
		const kill = setTimeout(() => child.kill("SIGKILL"), graceMs * 2);
		await exited;
		clearTimeout(term);
		clearTimeout(kill);
	}
}
