/**
 * The server: the tracker over HTTP, and who has what running.
 *
 * JSON in, JSON out, a personal token on every request but the one that joins. A client keeps
 * up by asking `/changes` for what is new since the revision it has; the request waits when
 * nothing is. Sessions are not stored: each host says what it runs, and what a host stops
 * saying is forgotten.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Issue, IssueChange, Scheme, WorkSession } from "@pi-lattice/protocol";
import { Tracker, WorkError } from "./tracker.ts";

export interface ServerOptions {
	/** The SQLite file. `:memory:` keeps nothing. */
	file: string;
	port?: number;
	/** The address to listen on. Default: every address, so teammates can reach it. */
	host?: string;
	/** How long a host's sessions are kept without word from it. */
	sessionTtlMs?: number;
	/** The longest a `/changes` request waits. */
	maxWaitMs?: number;
	now?: () => number;
	/** Said to anyone who asks what this is, along with the service's name. Nothing secret. */
	info?: Record<string, unknown>;
}

/** What `/changes` answers. */
export interface Changes {
	/** The revision this brings the client to. */
	rev: number;
	/** Counts changes to who is online and what they run; these have no revision. */
	beat: number;
	issues: Issue[];
	/** Present when it changed, or when the client has nothing. */
	scheme?: Scheme;
	people: Array<{ name: string; online: boolean }>;
	sessions: WorkSession[];
}

const BODY_MAX = 1024 * 1024;
const SESSIONS_MAX = 500;

interface Waiter {
	done: () => void;
}

export class WorkServer {
	readonly tracker: Tracker;
	private readonly options: ServerOptions;
	private readonly now: () => number;
	private readonly ttl: number;
	private server: Server | undefined;
	/** What each host last said it runs, by owner and host id. */
	private readonly hosts = new Map<string, { owner: string; at: number; sessions: WorkSession[] }>();
	private readonly seen = new Map<string, number>();
	private online = new Set<string>();
	private beat = 1;
	private readonly waiters = new Set<Waiter>();
	private sweep: NodeJS.Timeout | undefined;
	private heard: number;

	constructor(options: ServerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.ttl = options.sessionTtlMs ?? 45_000;
		this.heard = this.now();
		this.tracker = new Tracker(options.file, { now: this.now });
		this.tracker.onChange = () => this.wake();
	}

	/** Start listening. Returns the port, which is chosen by the system when none was asked for. */
	async start(): Promise<number> {
		const server = createServer((request, response) => void this.handle(request, response));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port ?? 0, this.options.host, resolve);
		});
		this.sweep = setInterval(() => this.expire(), Math.max(250, Math.min(5000, this.ttl / 3)));
		this.sweep.unref();
		return (server.address() as AddressInfo).port;
	}

	/** How long it has been since anyone who has joined asked anything. */
	get quietMs(): number {
		// Someone waiting for news is here, however long ago they asked.
		return this.waiters.size > 0 ? 0 : this.now() - this.heard;
	}

	async stop(): Promise<void> {
		if (this.sweep) clearInterval(this.sweep);
		for (const waiter of [...this.waiters]) waiter.done();
		const server = this.server;
		this.server = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		this.tracker.close();
	}

	private wake(): void {
		for (const waiter of [...this.waiters]) waiter.done();
	}

	/** Forget hosts that have gone quiet, and tell whoever is waiting when that changes what they see. */
	private expire(): void {
		const cutoff = this.now() - this.ttl;
		let changed = false;
		for (const [key, host] of this.hosts) {
			if (host.at < cutoff) {
				this.hosts.delete(key);
				changed = true;
			}
		}
		const online = new Set([...this.seen].filter(([, at]) => at >= cutoff).map(([name]) => name));
		if (online.size !== this.online.size || [...online].some((name) => !this.online.has(name))) changed = true;
		this.online = online;
		if (changed) {
			this.beat++;
			this.wake();
		}
	}

	private touch(who: string): void {
		this.seen.set(who, this.now());
		if (!this.online.has(who)) {
			this.online.add(who);
			this.beat++;
			this.wake();
		}
	}

	private changes(after: number): Changes {
		const tracker = this.tracker;
		return {
			rev: tracker.rev,
			beat: this.beat,
			issues: tracker.issuesAfter(after),
			...(after === 0 || tracker.schemeRev > after ? { scheme: tracker.scheme } : {}),
			people: tracker.members().map((name) => ({ name, online: this.online.has(name) })),
			sessions: [...this.hosts.values()].flatMap((host) => host.sessions),
		};
	}

	private putSessions(who: string, body: Record<string, unknown>): void {
		const host = typeof body.host === "string" && body.host.length <= 100 ? body.host : undefined;
		if (!host || !Array.isArray(body.sessions) || body.sessions.length > SESSIONS_MAX) throw new WorkError(400, "Say which host this is and the sessions it runs.");
		const repo = typeof body.repo === "string" ? body.repo.slice(0, 200) : "";
		const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");
		const states = ["working", "asking", "waiting", "idle", "failed"];
		const sessions: WorkSession[] = (body.sessions as Array<Record<string, unknown>>).map((entry) => ({
			host, owner: who, repo, id: text(entry.id, 100), name: text(entry.name, 200), role: text(entry.role, 100),
			state: (states.includes(entry.state as string) ? entry.state : "idle") as WorkSession["state"],
			...(Number.isInteger(entry.issue) ? { issue: entry.issue as number } : {}),
			...(typeof entry.activity === "string" && entry.activity ? { activity: entry.activity.slice(0, 300) } : {}),
			asks: Number.isInteger(entry.asks) ? (entry.asks as number) : 0,
		}));
		const key = `${who}\n${host}`;
		const before = JSON.stringify(this.hosts.get(key)?.sessions ?? []);
		this.hosts.set(key, { owner: who, at: this.now(), sessions });
		if (JSON.stringify(sessions) !== before) {
			this.beat++;
			this.wake();
		}
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const send = (status: number, body: unknown): void => {
			if (response.writableEnded) return;
			const text = JSON.stringify(body);
			response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
			response.end(text);
		};
		try {
			const url = new URL(request.url ?? "/", "http://server");
			const parts = url.pathname.split("/").filter(Boolean);
			const method = request.method ?? "GET";
			const route = `${method} /${parts[0] ?? ""}${parts.length > 1 ? "/:n" : ""}${parts[2] ? `/${parts[2]}` : ""}`;
			if (route === "GET /") return send(200, { service: "pi-lattice", rev: this.tracker.rev, ...this.options.info });
			const body = method === "GET" ? {} : await readBody(request);
			if (route === "POST /join") return send(200, this.tracker.join(String(body.code ?? ""), body.name as string));

			const who = this.tracker.who(/^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1]);
			if (!who) throw new WorkError(401, "This server does not know you. Join it with its address and code.");
			this.touch(who);
			this.heard = this.now();
			const number = Number(parts[1]);
			switch (route) {
				case "GET /changes": {
					const after = Number(url.searchParams.get("after") ?? 0) || 0;
					const beat = Number(url.searchParams.get("beat") ?? 0) || 0;
					const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) * 1000 || 0, this.options.maxWaitMs ?? 30_000);
					if (wait > 0 && this.tracker.rev <= after && this.beat <= beat) await this.waitFor(wait, request);
					// Still here: being asked is being online.
					this.seen.set(who, this.now());
					return send(200, this.changes(after));
				}
				case "GET /issues/:n":
					return send(200, { issue: this.found(number), comments: this.tracker.comments(number), history: this.tracker.history(number) });
				case "POST /issues":
					return send(201, { issue: this.tracker.create(who, body as IssueChange) });
				case "PATCH /issues/:n": {
					const { basedOn, ...change } = body as IssueChange & { basedOn?: number };
					return send(200, { issue: this.tracker.update(who, number, change, typeof basedOn === "number" ? basedOn : undefined) });
				}
				case "POST /issues/:n/comments":
					return send(201, { comment: this.tracker.comment(who, number, body.body) });
				case "POST /issues/:n/session":
					if (body.event !== "start" && body.event !== "report") throw new WorkError(400, 'The event is "start" or "report".');
					return send(200, { issue: this.tracker.session(who, number, body.event) });
				case "POST /next": {
					const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
					const [repo, type, label] = [text(body.repo), text(body.type), text(body.label)];
					return send(200, this.tracker.next(who, { ...(repo ? { repo } : {}), ...(type ? { type } : {}), ...(label ? { label } : {}), ...(Number.isInteger(body.under) ? { under: body.under as number } : {}) }));
				}
				case "PUT /scheme":
					return send(200, { scheme: this.tracker.setScheme(who, body) });
				case "PUT /sessions":
					this.putSessions(who, body);
					return send(200, {});
				default:
					throw new WorkError(404, `This server has no ${method} ${url.pathname}.`);
			}
		} catch (error) {
			if (error instanceof WorkError) return send(error.status, { error: error.message });
			send(500, { error: "The server failed to do that." });
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		}
	}

	private found(number: number): Issue {
		const issue = Number.isInteger(number) ? this.tracker.issue(number) : undefined;
		if (!issue) throw new WorkError(404, `There is no issue #${number}.`);
		return issue;
	}

	private waitFor(ms: number, request: IncomingMessage): Promise<void> {
		return new Promise((resolve) => {
			const waiter: Waiter = {
				done: () => {
					clearTimeout(timer);
					this.waiters.delete(waiter);
					resolve();
				},
			};
			const timer = setTimeout(waiter.done, ms);
			this.waiters.add(waiter);
			request.once("close", waiter.done);
		});
	}
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > BODY_MAX) throw new WorkError(413, "That is more than the server takes in one request (1 MB).");
		chunks.push(chunk as Buffer);
	}
	if (size === 0) return {};
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
		return value as Record<string, unknown>;
	} catch {
		throw new WorkError(400, "The request is not a JSON object.");
	}
}
