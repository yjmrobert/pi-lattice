# 0010 Workspace policy per node

**Decision**

`spawn_session` takes a `workspace` parameter with two values:

- `shared` (default): the child runs in the parent's working directory. Right for grilling, planning, review and any read-mostly work.
- `worktree`: the host creates a git worktree on a new branch under `.lattice/worktrees/<node-id>` and runs the child there. Right for implementation children that run concurrently.

The branch name is stored in node metadata and reported to the parent in the spawn result, so the coordinator can merge or the human can review. The host never merges, rebases or deletes a worktree with uncommitted changes on its own.

**Why**

Several agents editing one checkout at once corrupt each other's work, and the original plan was silent on it. A worktree per writer is the smallest mechanism that prevents it and also gives handoff (ADR 0007) a branch to carry.
