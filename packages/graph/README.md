# @pi-lattice/graph

Lets a Pi session grow and see a session tree. The tree belongs to a lattice host (`@pi-lattice/host`), which loads this extension into every session it runs. Without a host the tools say so and do nothing.

| For | Name | Does |
|---|---|---|
| Model | `spawn_session` | Create a child session with a name, a brief, and optionally a kind, role fragments, a workspace, a model and what it waits on |
| Model | `list_sessions` | Show the tree with ids, kinds, status and roles |
| Human | `/children` | List this session's children |

`spawn_session` parameters:

- `name`, `brief`: required. The child sees only the brief, so it must stand on its own.
- `kind`: free-form label, for example `grilling`, `planning`, `task`.
- `fragments`: role fragments for the child, in order.
- `workspace`: `shared` (the parent's directory, default) or `worktree` (its own git worktree on a new `lattice/...` branch).
- `model`: the model the child runs on. Left out, it uses the tree's.
- `waits_on`: sessions in the same tree, by id or name, whose result the child needs first. The child is created at once and starts by itself when each of them has sent its parent a message with intent `result`. A message sent to it by id starts it sooner. Sessions above it in the tree and teammates' sessions cannot be waited on. With `worktree`, its worktree is made when it starts ([ADR 0021](../../docs/decisions/0021-waiting-on-other-sessions.md)).

The host enforces limits on depth, children per session and tree size, and reports a refusal to the model as a tool error.
