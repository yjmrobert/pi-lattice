import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/index.ts";

let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-lattice-ws-")));
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "a.txt"), "one\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("createWorktree", () => {
	it("creates a worktree on a new branch from the parent's commit", () => {
		const wt = createWorktree(repo, "nd_0000000000abcdefghjk", "Fix Login!");
		expect(wt.branch).toBe("lattice/fix-login-efghjk");
		expect(wt.cwd).toBe(join(repo, ".lattice", "worktrees", "nd_0000000000abcdefghjk"));
		expect(readFileSync(join(wt.cwd, "src", "a.txt"), "utf8")).toBe("one\n");
		expect(git(wt.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
	});

	it("keeps the parent's relative directory", () => {
		const wt = createWorktree(join(repo, "src"), "nd_0000000000abcdefghjk", "x");
		expect(wt.cwd).toBe(join(repo, ".lattice", "worktrees", "nd_0000000000abcdefghjk", "src"));
	});

	it("isolates edits from the parent checkout and keeps .lattice out of git status", () => {
		const wt = createWorktree(repo, "nd_0000000000abcdefghjk", "x");
		writeFileSync(join(wt.cwd, "src", "a.txt"), "two\n");
		expect(readFileSync(join(repo, "src", "a.txt"), "utf8")).toBe("one\n");
		expect(git(repo, "status", "--porcelain")).toBe("");
	});

	it("places a grandchild's worktree beside its parent's, branching from the parent's work", () => {
		const child = createWorktree(repo, "nd_0000000000aaaaaaaaaa", "child");
		writeFileSync(join(child.cwd, "src", "b.txt"), "child work\n");
		git(child.cwd, "add", ".");
		git(child.cwd, "commit", "-q", "-m", "child");
		const grandchild = createWorktree(child.cwd, "nd_0000000000bbbbbbbbbb", "grandchild");
		expect(grandchild.cwd).toBe(join(repo, ".lattice", "worktrees", "nd_0000000000bbbbbbbbbb"));
		expect(existsSync(join(grandchild.cwd, "src", "b.txt"))).toBe(true);
	});

	it("explains what to do outside a git repository or before the first commit", () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "pi-lattice-plain-")));
		try {
			expect(() => createWorktree(plain, "nd_0000000000abcdefghjk", "x")).toThrow(/needs a git repository.*shared/);
			git(plain, "init", "-q");
			expect(() => createWorktree(plain, "nd_0000000000abcdefghjk", "x")).toThrow(/at least one commit/);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
