/**
 * A host's side of the server: a copy of the team's work kept up to date, and the calls that
 * change it. The copy is what was last heard; when the server cannot be reached it stays, and
 * says so.
 */
import type { Issue, IssueChange, IssueComment, IssueEvent, NextFilter, Note, SaidLine, Scheme, WorkSession, WorkState } from "@pi-lattice/protocol";
import { DEFAULT_SCHEME } from "@pi-lattice/protocol";
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
}

export interface ClientOptions {
	/** How long a request for changes may wait at the server, in seconds. */
	waitSeconds?: number;
	/** How long to wait before asking again after a failure. */
	retryMs?: number;
}

/** A server's address as it is passed around: the URL, with the team's code after `#`. */
export function parseAddress(text: string): { url: string; code: string } {
	const [url = "", code = ""] = text.trim().split("#");
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		parsed = undefined;
	}
	if (!parsed || !/^https?:$/.test(parsed.protocol) || code === "") throw new Error("A server's address looks like https://lattice.example.com/#code. Whoever runs the server has it.");
	return { url: parsed.href.replace(/\/+$/, ""), code };
}

async function call<T>(url: string, method: string, path: string, token: string | undefined, body?: unknown, signal?: AbortSignal): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${url}${path}`, {
			method,
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error(`The server at ${url} cannot be reached.`);
	}
	const text = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${url} did not answer like a lattice server (HTTP ${response.status}).`);
	}
	if (!response.ok) throw new Error((value as { error?: string }).error ?? `The server refused (HTTP ${response.status}).`);
	return value as T;
}

/** Take a name on a server. */
export async function joinServer(address: string, name: string): Promise<ServerAccount> {
	const { url, code } = parseAddress(address);
	const { token, name: taken } = await call<{ name: string; token: string }>(url, "POST", "/join", undefined, { code, name });
	return { url, name: taken, token };
}

/** How many of the last things done to the work a host keeps. */
const RECENT_MAX = 300;

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
		return call<T>(this.account.url, method, path, this.account.token, body, signal);
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
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, this.options.retryMs ?? 5000);
						stopping.signal.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						});
					});
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
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, this.options.retryMs ?? 5000);
						stopping.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						});
					});
				}
			}
		})();
	}
}
