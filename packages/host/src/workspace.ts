/** Workspaces for nodes: the parent's directory, or a git worktree of the node's own (ADR 0010). */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface Worktree {
	cwd: string;
	branch: string;
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "node";
}

/** Keep `.lattice/` out of `git status` without touching the tracked .gitignore. */
function excludeLatticeDir(commonDir: string): void {
	const path = join(commonDir, "info", "exclude");
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	if (current.split("\n").some((line) => line.trim() === ".lattice/")) return;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${current.endsWith("\n") || current === "" ? "" : "\n"}.lattice/\n`);
}

/**
 * Create a worktree on a new branch for a node, starting from the commit checked out in
 * `parentCwd`. The node works at the same relative path inside it.
 */
export function createWorktree(parentCwd: string, nodeId: string, name: string): Worktree {
	let top: string;
	let commonDir: string;
	try {
		top = git(parentCwd, "rev-parse", "--show-toplevel");
		const common = git(parentCwd, "rev-parse", "--git-common-dir");
		commonDir = isAbsolute(common) ? common : resolve(parentCwd, common);
	} catch {
		throw new Error(`A worktree workspace needs a git repository, and ${parentCwd} is not inside one. Use workspace "shared" instead.`);
	}
	try {
		git(parentCwd, "rev-parse", "--verify", "HEAD");
	} catch {
		throw new Error('A worktree workspace needs at least one commit in the repository. Commit first, or use workspace "shared".');
	}
	const mainRoot = dirname(commonDir);
	const path = join(mainRoot, ".lattice", "worktrees", nodeId);
	const branch = `lattice/${slug(name)}-${nodeId.slice(-6)}`;
	excludeLatticeDir(commonDir);
	mkdirSync(dirname(path), { recursive: true });
	try {
		git(parentCwd, "worktree", "add", "-b", branch, path, "HEAD");
	} catch (error) {
		const detail = (error as { stderr?: string }).stderr?.trim() ?? String(error);
		throw new Error(`Could not create a git worktree for the child: ${detail}`);
	}
	const inside = relative(top, parentCwd);
	const cwd = inside && !inside.startsWith("..") ? join(path, inside) : path;
	return { cwd: existsSync(cwd) ? cwd : path, branch };
}

/** A short name for the repository a directory belongs to: the main checkout's folder name, else the directory's own. */
export function repoName(cwd: string): string {
	try {
		const common = git(cwd, "rev-parse", "--git-common-dir");
		return basename(dirname(isAbsolute(common) ? common : resolve(cwd, common)));
	} catch {
		return basename(resolve(cwd));
	}
}
