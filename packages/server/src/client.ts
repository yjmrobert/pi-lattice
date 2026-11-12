/**
 * A host's side of the server: a copy of the team's work kept up to date, and the calls that
 * change it. The copy is what was last heard; when the server cannot be reached it stays, and
 * says so.
 */
import type { Issue, IssueChange, IssueComment, IssueEvent, NextFilter, Scheme, WorkSession, WorkState } from "@pi-lattice/protocol";
import { DEFAULT_SCHEME } from "@pi-lattice/protocol";
import type { Changes } from "./http.ts";

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

export class WorkClient {
	readonly account: ServerAccount;
	private readonly options: ClientOptions;
	private readonly issues = new Map<number, Issue>();
	private scheme: Scheme = DEFAULT_SCHEME;
	private people: WorkState["people"] = [];
	private sessions: WorkSession[] = [];
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
			scheme: this.scheme, issues: [...this.issues.values()].sort((a, b) => a.number - b.number), people: this.people, sessions: this.sessions,
		};
	}

	issue(number: number): Issue | undefined {
		return this.issues.get(number);
	}

	private request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		return call<T>(this.account.url, method, path, this.account.token, body, signal);
	}

	private take(changes: Changes): void {
		const before = JSON.stringify([this.rev, this.beat, this.connected, this.people, this.sessions]);
		for (const issue of changes.issues) this.issues.set(issue.number, issue);
		if (changes.scheme) this.scheme = changes.scheme;
		this.people = changes.people;
		this.sessions = changes.sessions;
		this.rev = changes.rev;
		this.beat = changes.beat;
		this.connected = true;
		this.problem = undefined;
		if (changes.issues.length > 0 || changes.scheme || JSON.stringify([this.rev, this.beat, this.connected, this.people, this.sessions]) !== before) this.emit();
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

	async create(change: IssueChange): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("POST", "/issues", change)).issue);
	}

	async update(number: number, change: IssueChange, basedOn?: number): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("PATCH", `/issues/${number}`, { ...change, ...(basedOn !== undefined ? { basedOn } : {}) })).issue);
	}

	async comment(number: number, body: string): Promise<IssueComment> {
		return (await this.request<{ comment: IssueComment }>("POST", `/issues/${number}/comments`, { body })).comment;
	}

	/** An issue with what was said on it and everything done to it. */
	read(number: number): Promise<{ issue: Issue; comments: IssueComment[]; history: IssueEvent[] }> {
		return this.request("GET", `/issues/${number}`);
	}

	/** A session was put on an issue, or reported its result: the server applies the scheme's rules. */
	async session(number: number, event: "start" | "report"): Promise<Issue> {
		return this.wrote((await this.request<{ issue: Issue }>("POST", `/issues/${number}/session`, { event })).issue);
	}

	/** Take the next issue that is ready, started and assigned to this person. None when nothing is ready. */
	async next(filter: NextFilter): Promise<{ issue?: Issue; waiting: number }> {
		const result = await this.request<{ issue?: Issue; waiting: number }>("POST", "/next", filter);
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
	async publish(host: string, repo: string, sessions: Array<Omit<WorkSession, "host" | "owner" | "repo">>): Promise<void> {
		await this.request("PUT", "/sessions", { host, repo, sessions });
	}
}
