/**
 * Shared state between collaborators: a file tree with atomic compare-and-swap commits.
 * The implementation here is a git repository (ADR 0011): a rejected non-fast-forward push
 * is the compare-and-swap, so two people can never both win a conflicting write.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A view of the shared tree inside one transaction. Paths are relative, with forward slashes. */
export interface Tx {
	read(path: string): string | undefined;
	write(path: string, content: string | Buffer): void;
	remove(path: string): void;
	/** Entries directly under a directory, sorted. Empty when it does not exist. */
	list(dir: string): string[];
	exists(path: string): boolean;
	/** Absolute path of a file in the working copy, for tools that need a real path. */
	resolve(path: string): string;
}

export interface SharedStore {
	/** Bring the local copy up to date and read from it. */
	read<T>(reader: (tx: Tx) => T): Promise<T>;
	/**
	 * Apply a change atomically. `mutate` runs against the latest state; if someone else
	 * commits first it runs again against theirs, so it must re-validate every time.
	 * Returning false abandons the change. Resolves with whether a change was committed.
	 */
	commit(message: string, mutate: (tx: Tx) => boolean | void): Promise<boolean>;
	close(): Promise<void>;
}

export interface GitSharedStoreOptions {
	/** URL or path of the shared repository. */
	remote: string;
	/** Local working copy, private to this host. */
	dir: string;
	/** Commit author. */
	author: string;
	branch?: string;
	maxAttempts?: number;
}

export class GitSharedStore implements SharedStore {
	private readonly options: GitSharedStoreOptions;
	private readonly branch: string;
	private queue: Promise<unknown> = Promise.resolve();
	private ready = false;

	constructor(options: GitSharedStoreOptions) {
		this.options = options;
		this.branch = options.branch ?? "main";
	}

	private git(...args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				"git",
				["-c", `user.name=${this.options.author}`, "-c", `user.email=${this.options.author}@pi-lattice.invalid`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
				{ cwd: this.options.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
				(error, stdout, stderr) => {
					if (error) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
					else resolve(stdout.trim());
				},
			);
		});
	}

	private async ensure(): Promise<void> {
		if (this.ready) return;
		mkdirSync(this.options.dir, { recursive: true });
		if (!existsSync(join(this.options.dir, ".git"))) {
			await this.git("init", "-q", "-b", this.branch);
			await this.git("remote", "add", "origin", this.options.remote);
		}
		this.ready = true;
	}

	/** Reset the working copy to the shared branch. An empty shared repository is a valid starting point. */
	private async pull(): Promise<void> {
		await this.ensure();
		try {
			await this.git("fetch", "-q", "origin", this.branch);
		} catch (error) {
			const message = String(error);
			if (/couldn't find remote ref|no such ref/i.test(message)) {
				// Nothing has been shared yet.
				await this.git("checkout", "-q", "-B", this.branch).catch(() => {});
				return;
			}
			throw error;
		}
		await this.git("checkout", "-q", "-B", this.branch, `origin/${this.branch}`);
		await this.git("reset", "-q", "--hard", `origin/${this.branch}`);
		await this.git("clean", "-q", "-fd");
	}

	private tx(): Tx {
		const root = this.options.dir;
		const abs = (path: string): string => {
			if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".git")) throw new Error(`unsafe shared path "${path}"`);
			return join(root, path);
		};
		return {
			read: (path) => {
				try {
					return readFileSync(abs(path), "utf8");
				} catch {
					return undefined;
				}
			},
			write: (path, content) => {
				mkdirSync(dirname(abs(path)), { recursive: true });
				writeFileSync(abs(path), content);
			},
			remove: (path) => rmSync(abs(path), { recursive: true, force: true }),
			list: (dir) => {
				try {
					return readdirSync(abs(dir)).filter((name) => name !== ".git").sort();
				} catch {
					return [];
				}
			},
			exists: (path) => {
				try {
					statSync(abs(path));
					return true;
				} catch {
					return false;
				}
			},
			resolve: abs,
		};
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => {});
		return run;
	}

	read<T>(reader: (tx: Tx) => T): Promise<T> {
		return this.enqueue(async () => {
			await this.pull();
			return reader(this.tx());
		});
	}

	commit(message: string, mutate: (tx: Tx) => boolean | void): Promise<boolean> {
		return this.enqueue(async () => {
			const attempts = this.options.maxAttempts ?? 6;
			for (let attempt = 0; attempt < attempts; attempt++) {
				await this.pull();
				if (mutate(this.tx()) === false) {
					await this.git("reset", "-q", "--hard").catch(() => {});
					await this.git("clean", "-q", "-fd").catch(() => {});
					return false;
				}
				await this.git("add", "-A");
				if ((await this.git("status", "--porcelain")) === "") return false; // nothing changed
				await this.git("commit", "-q", "-m", message);
				try {
					await this.git("push", "-q", "origin", `HEAD:${this.branch}`);
					return true;
				} catch (error) {
					if (!/rejected|non-fast-forward|fetch first|failed to push/i.test(String(error))) throw error;
					// Someone else committed first. Start again from their state.
				}
			}
			throw new Error("The shared repository kept changing; the update was not applied. Try again.");
		});
	}

	async close(): Promise<void> {
		await this.queue;
	}
}
