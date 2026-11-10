# @pi-lattice/graph

Lets a Pi session grow and see a session tree. The tree belongs to a lattice host (`@pi-lattice/host`), which loads this extension into every session it runs. Without a host the tools say so and do nothing.

| For | Name | Does |
|---|---|---|
| Model | `spawn_session` | Create a child session with a name, a brief, and optionally a kind, role fragments and a workspace |
| Model | `list_sessions` | Show the tree with ids, kinds, status and roles |
| Human | `/children` | List this session's children |

`spawn_session` parameters:

- `name`, `brief`: required. The child sees only the brief, so it must stand on its own.
- `kind`: free-form label, for example `grilling`, `planning`, `task`.
- `fragments`: role fragments for the child, in order.
- `workspace`: `shared` (the parent's directory, default) or `worktree` (its own git worktree on a new `lattice/...` branch).

The host enforces limits on depth, children per session and tree size, and reports a refusal to the model as a tool error.
