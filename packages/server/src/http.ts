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
import type { Issue, IssueChange, Scheme, WorkHost, WorkSession, WorkState } from "@pi-lattice/protocol";
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
	people: WorkState["people"];
	sessions: WorkSession[];
	hosts: WorkHost[];
}

/** Something one host hands the server for another: an offer, a request, an answer. Kept until asked for, and not for long. */
export interface Signal {
	from: string;
	body: unknown;
}

const BODY_MAX = 1024 * 1024;
const SESSIONS_MAX = 500;
const SIGNALS_MAX = 200;
const SIGNAL_TTL_MS = 60_000;

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
	private readonly hosts = new Map<string, { owner: string; at: number; sessions: WorkSession[]; peer?: WorkHost }>();
	/** What is waiting to be handed over, by recipient and scope, and who is waiting for it. */
	private readonly signals = new Map<string, Array<Signal & { at: number }>>();
	private readonly listening = new Map<string, Set<Waiter>>();
	private readonly seen = new Map<string, number>();
	private online = new Set<string>();
	private beat = 1;
	private readonly waiters = new Set<Waiter>();
	private sweep: NodeJS.Timeout | undefined;
	private heard: number;
	/** How many things hosts have handed over for each other since this started. */
	relayed = 0;

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
		return this.waiters.size + this.listening.size > 0 ? 0 : this.now() - this.heard;
	}

	async stop(): Promise<void> {
		if (this.sweep) clearInterval(this.sweep);
		for (const waiter of [...this.waiters, ...[...this.listening.values()].flatMap((set) => [...set])]) waiter.done();
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
			people: tracker.people().map((person) => ({ ...person, online: this.online.has(person.name) })),
			sessions: [...this.hosts.values()].flatMap((host) => host.sessions),
			hosts: [...this.hosts.values()].flatMap((host) => (host.peer ? [host.peer] : [])),
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
		// A host that can be connected to says where, what it is working on, and the key its person signs with.
		const addresses = Array.isArray(body.addresses) ? (body.addresses as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.length <= 100).slice(0, 8) : [];
		const peer: WorkHost | undefined = addresses.length > 0 ? { owner: who, host, repo, scope: text(body.scope, 200), addresses } : undefined;
		const keyed = typeof body.key === "string" && body.key.length <= 500 ? this.tracker.setKey(who, body.key) : false;
		const key = `${who}\n${host}`;
		const held = this.hosts.get(key);
		const before = JSON.stringify([held?.sessions ?? [], held?.peer]);
		this.hosts.set(key, { owner: who, at: this.now(), sessions, ...(peer ? { peer } : {}) });
		if (keyed || JSON.stringify([sessions, peer]) !== before) {
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
				case "GET /team":
					return send(200, this.tracker.team());
				case "POST /signals": {
					const to = typeof body.to === "string" ? this.tracker.members().find((name) => name === body.to) : undefined;
					if (!to || typeof body.scope !== "string") throw new WorkError(400, "Say who it is for, and what they are working on.");
					const slot = `${to}\n${body.scope}`;
					const queue = (this.signals.get(slot) ?? []).filter((signal) => signal.at >= this.now() - SIGNAL_TTL_MS).slice(-SIGNALS_MAX + 1);
					queue.push({ from: who, body: body.body, at: this.now() });
					this.relayed++;
					this.signals.set(slot, queue);
					for (const waiter of [...(this.listening.get(slot) ?? [])]) waiter.done();
					return send(200, {});
				}
				case "GET /signals": {
					const slot = `${who}\n${url.searchParams.get("scope") ?? ""}`;
					const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) * 1000 || 0, this.options.maxWaitMs ?? 30_000);
					if (wait > 0 && !this.signals.has(slot)) await this.waitFor(wait, request, slot);
					const queue = (this.signals.get(slot) ?? []).filter((signal) => signal.at >= this.now() - SIGNAL_TTL_MS);
					this.signals.delete(slot);
					return send(200, { signals: queue.map(({ from, body: sent }) => ({ from, body: sent })) });
				}
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

	/** Wait for news: of the work, or, given a slot, of something handed over for it. */
	private waitFor(ms: number, request: IncomingMessage, slot?: string): Promise<void> {
		return new Promise((resolve) => {
			const set = slot === undefined ? this.waiters : (this.listening.get(slot) ?? new Set<Waiter>());
			if (slot !== undefined) this.listening.set(slot, set);
			const waiter: Waiter = {
				done: () => {
					clearTimeout(timer);
					set.delete(waiter);
					if (slot !== undefined && set.size === 0) this.listening.delete(slot);
					resolve();
				},
			};
			const timer = setTimeout(waiter.done, ms);
			set.add(waiter);
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
