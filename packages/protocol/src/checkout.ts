/**
 * Where a repository's main checkout is. A tree's state, and the worktrees of its sessions,
 * are kept in `.lattice` there, so that every worktree of the repository shares them.
 */

/**
 * The main checkout, from the repository's git directory (`git rev-parse --git-common-dir`,
 * as an absolute path) and, when that is not inside a checkout, what the git directory records
 * as its work tree (`git --git-dir <dir> rev-parse --show-toplevel`).
 *
 * Usually the git directory is the `.git` in the main checkout, and the checkout is the
 * directory above it: that is so from any worktree made from it too. A submodule's git directory
 * is kept under the outer repository's `.git/modules`, where the directory above is no checkout
 * at all; it records where its own is. A bare repository records none: its worktrees share
 * the directory it is in.
 */
export function mainCheckout(commonDir: string, recordedWorkTree: () => string | undefined): string {
	const dir = commonDir.replace(/[\\/]+$/, "");
	const at = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
	const above = at > 0 ? dir.slice(0, at) : dir.slice(0, at + 1) || dir;
	if (dir.slice(at + 1) === ".git") return above;
	return recordedWorkTree() || above;
}
