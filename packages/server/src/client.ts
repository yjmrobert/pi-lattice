/**
 * A host's side of the server: a copy of the team's work kept up to date, and the calls that
 * change it. The copy is what was last heard; when the server cannot be reached it stays, and
 * says so.
 */
import type { Issue, IssueChange, IssueComment, IssueEvent, NextFilter, Note, SaidLine, Scheme, WorkSession, WorkState } from "@pi-lattice/protocol";
import { DEFAULT_SCHEME } from "@pi-lattice/protocol";
import { Agent, request as httpsRequest } from "node:https";
import { connect } from "node:tls";
import { matchesPin } from "./cert.ts";
import type { Changes, Signal } from "./http.ts";

/** What a host that can be connected to says of itself, along with what it runs. */
export interface Peering {
	scope: string;
	addresses: string[];
	/** The public key its person signs with. */
	key: string;
}

/** Where a server is and who this person is on it. */
export interface ServerAccount {
	url: string;
	name: string;
	token: string;
	/** The fingerprint of the server's own certificate, when it encrypts by itself. Every request is made to that certificate and no other. */
	pin?: string;
}

export interface ClientOptions {
	/** How long a request for changes may wait at the server, in seconds. */
	waitSeconds?: number;
	/** How long to wait before asking again after a failure. */
	retryMs?: number;
}

/**
 * A server's address as it is passed around: the URL, with the team's code after `#`. A
 * server that encrypts by itself adds the fingerprint of its certificate after the code and a
 * dot, which is how whoever is given the address knows the server they reach is that one.
 */
export function parseAddress(text: string): { url: string; code: string; pin?: string } {
	const [url = "", secret = ""] = text.trim().split("#");
	const [code = "", pin] = secret.split(".");
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		parsed = undefined;
	}
	if (!parsed || !/^https?:$/.test(parsed.protocol) || code === "") throw new Error("A server's address looks like https://lattice.example.com/#code. Whoever runs the server has it.");
	if (pin !== undefined && (pin === "" || parsed.protocol !== "https:")) throw new Error("That address is not whole: copy all of it, from https:// to the end of the line.");
	return { url: parsed.href.replace(/\/+$/, ""), code, ...(pin !== undefined ? { pin } : {}) };
}

/** A server's address as it is passed around. */
export function formatAddress(url: string, code: string, pin?: string): string {
	return `${url.replace(/\/+$/, "")}/#${code}${pin !== undefined ? `.${pin}` : ""}`;
}

/** The certificate of each pinned server, once it has been seen to be the one its pin was made from. */
const anchors = new Map<string, Promise<string>>();
const pinned = new Agent({ keepAlive: true });

class PinError extends Error {}

/**
 * Reach a pinned server far enough to see its certificate, and take it only if it is the one
 * the pin was made from. Nothing is sent before that: not the code, not a token.
 */
function anchor(url: URL, pin: string): Promise<string> {
	const key = `${url.origin}#${pin}`;
	const known = anchors.get(key);
	if (known) return known;
	const found = new Promise<string>((resolve, reject) => {
		const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 443, rejectUnauthorized: false });
		socket.setTimeout(15_000, () => socket.destroy(new Error("timed out")));
		socket.once("error", reject);
		socket.once("secureConnect", () => {
			const cert = socket.getPeerX509Certificate();
			socket.destroy();
			if (cert && matchesPin(cert, pin)) resolve(cert.toString());
			else reject(new PinError());
		});
	});
	anchors.set(key, found);
	found.catch(() => anchors.delete(key));
	return found;
}

interface Answer {
	status: number;
	text: string;
}

/** Ask a pinned server: over TLS, to that certificate and no other. */
async function askPinned(url: URL, pin: string, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal | undefined): Promise<Answer> {
	const ca = await anchor(url, pin);
	return new Promise<Answer>((resolve, reject) => {
		const request = httpsRequest(
			// The certificate names nobody. That it is the pinned one is the whole check, and `ca` makes it.
			{ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || 443, path: `${url.pathname}${url.search}`, method, headers, ca, checkServerIdentity: () => undefined, agent: pinned, ...(signal ? { signal } : {}) },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
				response.on("error", reject);
			},
		);
		request.on("error", (error: NodeJS.ErrnoException) => {
			// It answered with another certificate than a moment ago: look again, and judge it by the pin.
			if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? "")) anchors.delete(`${url.origin}#${pin}`);
			reject(error);
		});
		request.end(body);
	});
}

async function call<T>(target: { url: string; pin?: string }, method: string, path: string, token: string | undefined, body?: unknown, stopping?: AbortSignal): Promise<T> {
	const { url, pin } = target;
	// A request is given a signal of its own that follows the caller's, which lives as long as the
	// client: whatever a request leaves listening is then on a signal that goes when the request does.
	const own = stopping ? new AbortController() : undefined;
	const signal = own?.signal;
	const follow = (): void => own?.abort(stopping?.reason);
	if (stopping?.aborted) follow();
	else stopping?.addEventListener("abort", follow, { once: true });
	const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
	const sent = body !== undefined ? JSON.stringify(body) : undefined;
	let answer: Answer;
	try {
		if (pin !== undefined) {
			const where = new URL(`${url}${path}`);
			if (where.protocol !== "https:") throw new PinError();
			answer = await askPinned(where, pin, method, headers, sent, signal).catch((error: NodeJS.ErrnoException) => {
				// Once more when its certificate changed under us: the pin decides whether that is still the server.
				if (signal?.aborted || error instanceof PinError || !/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? "")) throw error;
				return askPinned(where, pin, method, headers, sent, signal);
			});
		} else {
			const response = await fetch(`${url}${path}`, { method, headers, ...(sent !== undefined ? { body: sent } : {}), ...(signal ? { signal } : {}) });
			answer = { status: response.status, text: await response.text() };
		}
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof PinError) {
			throw new Error(`What answers at ${url} is not the server this address was given for, so nothing was sent to it. If the server was set up again, ask whoever runs it for its address again.`);
		}
		throw new Error(`The server at ${url} cannot be reached.`);
	} finally {
		stopping?.removeEventListener("abort", follow);
	}
	let value: unknown;
	try {
		value = JSON.parse(answer.text);
	} catch {
		throw new Error(`${url} did not answer like a lattice server (HTTP ${answer.status}).`);
	}
	if (answer.status < 200 || answer.status >= 300) throw new Error((value as { error?: string }).error ?? `The server refused (HTTP ${answer.status}).`);
	return value as T;
}

/** Take a name on a server. */
export async function joinServer(address: string, name: string): Promise<ServerAccount> {
	const { url, code, pin } = parseAddress(address);
	const { token, name: taken } = await call<{ name: string; token: string }>({ url, ...(pin !== undefined ? { pin } : {}) }, "POST", "/join", undefined, { code, name });
	return { url, name: taken, token, ...(pin !== undefined ? { pin } : {}) };
}

/** How many of the last things done to the work a host keeps. */
const RECENT_MAX = 300;

/** Wait before trying again, or until stopped. It leaves nothing listening on the signal when it is over. */
function pause(ms: number, stopping: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (stopping.aborted) return resolve();
		const done = (): void => {
			clearTimeout(timer);
			stopping.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		stopping.addEventListener("abort", done);
	});
}

export class WorkClient {
	readonly account: ServerAccount;
	private readonly options: ClientOptions;
	private readonly issues = new Map<number, Issue>();
	private scheme: Scheme = DEFAULT_SCHEME;
	private people: WorkState["people"] = [];
	private sessions: WorkSession[] = [];
	private hosts: WorkState["hosts"] = [];
	private recent: IssueEvent[] = [];
	private seen = 0;
	private rev = 0;
	private beat = 0;
	private connected = false;
	private problem: string | undefined;
	private stopping: AbortController | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(account: ServerAccount, options: ClientOptions = {}) {
		this.account = account;
		this.options = options;
	}

	/** Call the listener whenever the copy changes, or the server is lost or found. */
	onChanged(listener: () => void): void {
		this.listeners.add(listener);
	}

	state(): WorkState {
		return {
			url: this.account.url, me: this.account.name, connected: this.connected, ...(this.problem ? { problem: this.problem } : {}),
			scheme: this.scheme, issues: [...this.issues.values()].sort((a, b) => a.number - b.number), people: this.people, sessions: this.sessions, hosts: this.hosts, recent: this.recent, seen: this.seen,
		};
	}

	issue(number: number): Issue | undefined {
		return this.issues.get(number);
	}

	private request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		return call<T>(this.account, method, path, this.account.token, body, signal);
	}

	private take(changes: Changes): void {
		const before = JSON.stringify([this.rev, this.beat, this.connected, this.people, this.sessions, this.hosts]);
		for (const issue of changes.issues) this.issues.set(issue.number, issue);
		if (changes.scheme) this.scheme = changes.scheme;
		this.people = changes.people;
		this.sessions = changes.sessions;
		this.hosts = changes.hosts ?? [];
		// The feed gives what is new; what is kept is the last of everything heard, each event once.
		const known = new Set(this.recent.map((event) => `${event.rev}:${event.issue}:${event.what}`));
		this.recent = [...this.recent, ...(changes.events ?? []).filter((event) => !known.has(`${event.rev}:${event.issue}:${event.what}`))].slice(-RECENT_MAX);
		const seen = Math.max(this.seen, changes.seen ?? 0);
		const looked = seen !== this.seen;
		this.seen = seen;
		this.rev = changes.rev;
		this.beat = changes.beat;
		this.connected = true;
		this.problem = undefined;
		if (looked || changes.issues.length > 0 || changes.scheme || JSON.stringify([this.rev, this.beat, this.connected, this.people, this.sessions, this.hosts]) !== before) this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	/** Ask once for what is new. Throws when the server cannot be reached or refuses. */
	async refresh(): Promise<void> {
		this.take(await this.request<Changes>("GET", `/changes?after=${this.rev}`));
	}

	/** Keep the copy up to date until `stop`. Never throws: a server that is gone is a state, not an error. */
	start(): void {
		if (this.stopping) return;
		const stopping = new AbortController();
		this.stopping = stopping;
		const wait = this.options.waitSeconds ?? 25;
		void (async () => {
			let first = true;
			while (!stopping.signal.aborted) {
				try {
					this.take(await this.request<Changes>("GET", `/changes?after=${this.rev}&beat=${this.beat}&wait=${first ? 0 : wait}`, undefined, stopping.signal));
					first = false;
				} catch (error) {
					if (stopping.signal.aborted) return;
					const problem = error instanceof Error ? error.message : String(error);
					if (this.connected || this.problem !== problem) {
						this.connected = false;
						this.problem = problem;
						this.emit();
					}
					first = true;
					await pause(this.options.retryMs ?? 5000, stopping.signal);
				}
			}
		})();
	}

	stop(): void {
		this.stopping?.abort();
		this.stopping = undefined;
	}

	private async wrote(issue: Issue): Promise<Issue> {
		// The answer to a write is news too: show it without waiting for the feed.
		if ((this.issues.get(issue.number)?.rev ?? -1) < issue.rev) {
			this.issues.set(issue.number, issue);
			this.emit();
		}
		return issue;
	}

	/** `note` on any of these says which session or agent is making the change, and why: both are kept with it. */
	async create(change: IssueChange, note: Note = {}): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("POST", "/issues", { ...change, ...note })).issue);
	}

	async update(number: number, change: IssueChange, basedOn?: number, note: Note = {}): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("PATCH", `/issues/${number}`, { ...change, ...(basedOn !== undefined ? { basedOn } : {}), ...note })).issue);
	}

	async comment(number: number, body: string, note: Note = {}): Promise<IssueComment> {
		return (await this.request<{ comment: IssueComment }>("POST", `/issues/${number}/comments`, { body, ...note })).comment;
	}

	/** An issue with what was said on it and everything done to it. `as` is the agent looking, when it holds the issue from a shell. */
	read(number: number, as?: string): Promise<{ issue: Issue; comments: IssueComment[]; history: IssueEvent[]; said: SaidLine[] }> {
		return this.request("GET", `/issues/${number}${as ? `?as=${encodeURIComponent(as)}` : ""}`);
	}

	/** A session was put on an issue, or reported its result: the server applies the scheme's rules. */
	async session(number: number, event: "start" | "report", note: Note = {}): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("POST", `/issues/${number}/session`, { event, ...note })).issue);
	}

	/** The work on an issue is finished: what was done, how it was checked, where to look. */
	async done(number: number, result: { summary: string; checks?: string; url?: string }, note: Note = {}): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("POST", `/issues/${number}/done`, { ...result, ...note })).issue);
	}

	/** Give an issue back, saying why. */
	async drop(number: number, why: string, as?: string): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("POST", `/issues/${number}/drop`, { why, ...(as ? { as } : {}) })).issue);
	}

	/** This person says something about an issue. */
	async say(number: number, text: string): Promise<SaidLine> {
		const { line, issue } = await this.request<{ line: SaidLine; issue: Issue }>("POST", `/issues/${number}/said`, { text });
		await this.wrote(issue);
		return line;
	}

	/** Keep a line a person said as a direction that stands, or lift it. */
	async stand(line: number, stands: boolean, note: Note = {}): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("PATCH", `/said/${line}`, { stands, ...note })).issue);
	}

	/** This person has looked at what changed. */
	async looked(): Promise<void> {
		const { seen } = await this.request<{ seen: number }>("POST", "/seen", {});
		if (seen !== this.seen) {
			this.seen = seen;
			this.emit();
		}
	}

	/** Take the next issue that is ready, started and assigned to this person. None when nothing is ready. */
	async next(filter: NextFilter, note: Note = {}): Promise<{ issue?: Issue; waiting: number }> {
		const result = await this.request<{ issue?: Issue; waiting: number }>("POST", "/next", { ...filter, ...note });
		if (result.issue) await this.wrote(result.issue);
		return result;
	}

	async setScheme(scheme: Scheme): Promise<Scheme> {
		const saved = (await this.request<{ scheme: Scheme }>("PUT", "/scheme", scheme)).scheme;
		this.scheme = saved;
		this.emit();
		return saved;
	}

	/** Say what this host runs. Repeated while it runs, because the server forgets a host that goes quiet. */
	async publish(host: string, repo: string, sessions: Array<Omit<WorkSession, "host" | "owner" | "repo">>, peering?: Peering): Promise<void> {
		await this.request("PUT", "/sessions", { host, repo, sessions, ...peering });
	}

	/** What lets this team's hosts connect to each other directly. */
	team(): Promise<{ name: string; secret: string }> {
		return this.request("GET", "/team");
	}

	/** Hand the server something for a teammate's host that works on `scope`. It is kept a minute: they must be there. */
	async signal(to: string, scope: string, body: unknown): Promise<void> {
		await this.request("POST", "/signals", { to, scope, body });
	}

	/** Take what teammates hand over for this host, until `stop`. */
	listen(scope: string, handler: (from: string, body: unknown) => void): void {
		const stopping = this.stopping?.signal;
		if (!stopping) throw new Error("Start the client first.");
		void (async () => {
			while (!stopping.aborted) {
				try {
					const { signals } = await this.request<{ signals: Signal[] }>("GET", `/signals?scope=${encodeURIComponent(scope)}&wait=${this.options.waitSeconds ?? 25}`, undefined, stopping);
					for (const signal of signals) handler(signal.from, signal.body);
				} catch {
					if (stopping.aborted) return;
					await pause(this.options.retryMs ?? 5000, stopping);
				}
			}
		})();
	}
}
