/**
 * The server: the tracker over HTTP, and who has what running.
 *
 * JSON in, JSON out, a personal token on every request but the one that joins. A client keeps
 * up by asking `/changes` for what is new since the revision it has; the request waits when
 * nothing is. Sessions are not stored: each host says what it runs, and what a host stops
 * saying is forgotten.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { type AddressInfo, connect, createServer as createListener, type Server as Listener, type Socket } from "node:net";
import { type Certificate, pinOf } from "./cert.ts";
import type { Issue, IssueChange, IssueEvent, Note, Scheme, WorkHost, WorkSession, WorkState } from "@pi-lattice/protocol";
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
	/** How long an agent with no host keeps an issue after its last word on it. */
	leaseMs?: number;
	/** Said to anyone who asks what this is, along with the service's name. Nothing secret. */
	info?: Record<string, unknown>;
	/**
	 * The certificate to encrypt with. Given one, the server speaks TLS on its port, and still
	 * answers plain HTTP there from this machine only: a board's own host, and a proxy in front.
	 * Anyone else speaking plainly is told to take the server's address again, and nothing they
	 * sent is acted on. Without one it speaks plain HTTP to everyone, for whatever does the
	 * encrypting in front.
	 */
	tls?: Certificate & {
		/** Who may still speak plain HTTP, by the address they connect from. Default: this machine. */
		plainFrom?: (address: string | undefined) => boolean;
	};
}

/** Whether a connection comes from this machine. */
const isLoopback = (address: string | undefined): boolean => address !== undefined && /^(::ffff:)?127\.|^::1$/.test(address);
/** How long a connection may say nothing before it is known what it speaks. */
const FIRST_BYTE_MS = 10_000;

/**
 * Answer someone speaking plain HTTP to a server that encrypts, from another machine. Whatever
 * they sent, a code or a token, has already crossed the network in the clear; it is not read,
 * and they are told how to stop.
 */
function turnAway(socket: Socket): void {
	const body = JSON.stringify({ error: "This server encrypts its connections now, and this one is not. Ask whoever runs it for its address again and give it to /lattice server: your name there is kept." });
	socket.on("data", () => {}); // let them finish saying it, so the answer is not lost to a reset
	socket.end(`HTTP/1.1 426 Upgrade Required\r\nupgrade: TLS/1.2\r\nconnection: close\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	setTimeout(() => socket.destroy(), 2000).unref();
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
	/** What was done to issues since the revision asked from, oldest first; the last of it when there is much. */
	events: IssueEvent[];
	/** The revision the asker last looked at the work at. */
	seen: number;
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
/** What someone is working on is a short name; each one a signal names is a queue kept here. */
const SCOPE_MAX = 300;

interface Waiter {
	done: () => void;
}

export class WorkServer {
	readonly tracker: Tracker;
	private readonly options: ServerOptions;
	private readonly now: () => number;
	private readonly ttl: number;
	private server: Server | undefined;
	private secure: Server | undefined;
	/** With TLS, what listens on the port: it passes each connection to the server for what it speaks. */
	private front: Listener | undefined;
	private readonly passing = new Set<Socket>();
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
		this.tracker = new Tracker(options.file, { now: this.now, ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}) });
		this.tracker.onChange = () => this.wake();
	}

	/** Start listening. Returns the port, which is chosen by the system when none was asked for. */
	async start(): Promise<number> {
		const answer = (request: IncomingMessage, response: ServerResponse): void => void this.handle(request, response);
		const server = createServer(answer);
		this.server = server;
		const listen = (listener: Listener, port: number, host: string | undefined): Promise<number> =>
			new Promise<number>((resolve, reject) => {
				listener.once("error", reject);
				listener.listen(port, host, () => resolve((listener.address() as AddressInfo).port));
			});
		const tls = this.options.tls;
		let port: number;
		if (!tls) port = await listen(server, this.options.port ?? 0, this.options.host);
		else {
			// One port for both, so there is one address. The two servers listen to this machine
			// only, and what listens on the port passes each connection to the one for what it
			// speaks: a TLS connection opens with a handshake record (0x16), which no HTTP request
			// starts with.
			const secure = createSecureServer({ key: tls.key, cert: tls.cert }, answer);
			this.secure = secure;
			const [plainPort, securePort] = [await listen(server, 0, "127.0.0.1"), await listen(secure, 0, "127.0.0.1")];
			const plainFrom = tls.plainFrom ?? isLoopback;
			const pass = (socket: Socket): void => {
				const first = socket.read(1) as Buffer | null;
				if (first === null) {
					if (!socket.destroyed && !socket.readableEnded) socket.once("readable", () => pass(socket));
					return;
				}
				socket.setTimeout(0);
				const encrypted = first[0] === 0x16;
				if (!encrypted && !plainFrom(socket.remoteAddress)) return turnAway(socket);
				socket.unshift(first);
				const inner = connect(encrypted ? securePort : plainPort, "127.0.0.1");
				this.passing.add(inner);
				inner.once("close", () => {
					this.passing.delete(inner);
					socket.destroy();
				});
				inner.on("error", () => socket.destroy());
				socket.once("close", () => inner.destroy());
				socket.pipe(inner);
				inner.pipe(socket);
			};
			const front = createListener((socket) => {
				this.passing.add(socket);
				socket.once("close", () => this.passing.delete(socket));
				socket.on("error", () => {});
				socket.setTimeout(FIRST_BYTE_MS, () => socket.destroy());
				pass(socket);
			});
			this.front = front;
			port = await listen(front, this.options.port ?? 0, this.options.host);
		}
		this.sweep = setInterval(() => this.expire(), Math.max(250, Math.min(5000, this.ttl / 3)));
		this.sweep.unref();
		return port;
	}

	/** The fingerprint of the certificate this server proves itself with, as it goes in its address. Undefined when it speaks plain HTTP. */
	get pin(): string | undefined {
		return this.options.tls ? pinOf(this.options.tls.cert) : undefined;
	}

	/** How long it has been since anyone who has joined asked anything. */
	get quietMs(): number {
		// Someone waiting for news is here, however long ago they asked.
		return this.waiters.size + this.listening.size > 0 ? 0 : this.now() - this.heard;
	}

	async stop(): Promise<void> {
		if (this.sweep) clearInterval(this.sweep);
		for (const waiter of [...this.waiters, ...[...this.listening.values()].flatMap((set) => [...set])]) waiter.done();
		const [server, secure, front] = [this.server, this.secure, this.front];
		this.server = this.secure = this.front = undefined;
		for (const socket of this.passing) socket.destroy();
		for (const listener of [front, secure, server]) {
			if (!listener) continue;
			if ("closeAllConnections" in listener) (listener as Server).closeAllConnections();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
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
		// An agent that took an issue from a shell and went quiet loses it. The change wakes whoever is waiting.
		this.tracker.expire();
		for (const [key, host] of this.hosts) {
			if (host.at < cutoff) {
				this.hosts.delete(key);
				changed = true;
			}
		}
		// What was sent to someone who never came for it is not kept past its time.
		for (const [slot, queue] of this.signals) {
			const fresh = queue.filter((signal) => signal.at >= this.now() - SIGNAL_TTL_MS);
			if (fresh.length === 0) this.signals.delete(slot);
			else if (fresh.length !== queue.length) this.signals.set(slot, fresh);
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

	private changes(after: number, who: string): Changes {
		const tracker = this.tracker;
		return {
			rev: tracker.rev,
			beat: this.beat,
			issues: tracker.issuesAfter(after),
			...(after === 0 || tracker.schemeRev > after ? { scheme: tracker.scheme } : {}),
			people: tracker.people().map((person) => ({ ...person, online: this.online.has(person.name) })),
			sessions: [...this.hosts.values()].flatMap((host) => host.sessions),
			hosts: [...this.hosts.values()].flatMap((host) => (host.peer ? [host.peer] : [])),
			events: tracker.eventsAfter(after, 200),
			seen: tracker.seenOf(who),
		};
	}

	private putSessions(who: string, body: Record<string, unknown>): void {
		const host = typeof body.host === "string" && body.host.length <= 100 ? body.host : undefined;
		if (!host || !Array.isArray(body.sessions) || body.sessions.length > SESSIONS_MAX) throw new WorkError(400, "Say which host this is and the sessions it runs.");
		if (!body.sessions.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))) throw new WorkError(400, "Each session is an object: its id, name, role and state.");
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
			// Who made a change besides the person, and why: said with the change, kept with it.
			const short = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined);
			const { why: saidWhy, as: saidAs, ...rest } = body as Record<string, unknown>;
			const [why, as] = [short(saidWhy, 500), short(saidAs, 100)];
			const note: Note = { ...(why ? { why } : {}), ...(as ? { as } : {}) };
			switch (route) {
				case "GET /changes": {
					const after = Number(url.searchParams.get("after") ?? 0) || 0;
					const beat = Number(url.searchParams.get("beat") ?? 0) || 0;
					const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) * 1000 || 0, this.options.maxWaitMs ?? 30_000);
					if (wait > 0 && this.tracker.rev <= after && this.beat <= beat) await this.waitFor(wait, request);
					// Still here: being asked is being online.
					this.seen.set(who, this.now());
					return send(200, this.changes(after, who));
				}
				case "GET /issues/:n": {
					// An agent that holds it on a lease is still there when it looks.
					const looking = short(url.searchParams.get("as"), 100);
					if (looking && Number.isInteger(number)) this.tracker.touch(number, looking);
					return send(200, { issue: this.found(number), comments: this.tracker.comments(number), history: this.tracker.history(number), said: this.tracker.said(number) });
				}
				case "POST /issues":
					return send(201, { issue: this.tracker.create(who, rest as IssueChange, note) });
				case "PATCH /issues/:n": {
					const { basedOn, ...change } = rest as IssueChange & { basedOn?: number };
					return send(200, { issue: this.tracker.update(who, number, change, typeof basedOn === "number" ? basedOn : undefined, note) });
				}
				case "POST /issues/:n/comments":
					return send(201, { comment: this.tracker.comment(who, number, body.body, note) });
				case "POST /issues/:n/session":
					if (body.event !== "start" && body.event !== "report") throw new WorkError(400, 'The event is "start" or "report".');
					return send(200, { issue: this.tracker.session(who, number, body.event, note) });
				case "POST /issues/:n/done":
					return send(200, { issue: this.tracker.done(who, number, rest, note) });
				case "POST /issues/:n/drop":
					return send(200, { issue: this.tracker.drop(who, number, saidWhy, as ? { as } : {}) });
				case "POST /issues/:n/said":
					return send(201, { line: this.tracker.say(who, number, body.text), issue: this.found(number) });
				case "PATCH /said/:n":
					if (typeof body.stands !== "boolean") throw new WorkError(400, 'Say whether it stands: "stands" is true or false.');
					return send(200, { issue: this.tracker.stand(who, number, body.stands, note) });
				case "POST /seen":
					return send(200, { seen: this.tracker.seen(who) });
				case "POST /next": {
					const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
					const [repo, type, label] = [text(body.repo), text(body.type), text(body.label)];
					return send(200, this.tracker.next(who, { ...(repo ? { repo } : {}), ...(type ? { type } : {}), ...(label ? { label } : {}), ...(Number.isInteger(body.under) ? { under: body.under as number } : {}), ...(body.lease === true ? { lease: true } : {}) }, note));
				}
				case "PUT /scheme":
					return send(200, { scheme: this.tracker.setScheme(who, body) });
				case "GET /team":
					return send(200, this.tracker.team());
				case "POST /signals": {
					const to = typeof body.to === "string" ? this.tracker.members().find((name) => name === body.to) : undefined;
					if (!to || typeof body.scope !== "string" || body.scope.length > SCOPE_MAX) throw new WorkError(400, "Say who it is for, and what they are working on.");
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
