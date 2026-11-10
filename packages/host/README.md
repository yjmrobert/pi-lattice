# @pi-lattice/host

The lattice host: a process that owns a tree of Pi sessions for a project.

- Runs each node as a Pi process in RPC mode, loaded with the lattice `a2a`, `roles` and `graph` extensions.
- Routes every message between sessions and journals it.
- Keeps the tree in SQLite, so it survives restarts. Sessions sleep when idle and resume on demand.
- Surfaces what needs a human: dialogs that block a session, and mail waiting for approval.

## Run it

From the repository, in your project directory:

```bash
node /path/to/pi-lattice/packages/host/src/cli.ts --role coordinator --plain
```

`--plain` gives a line-based interface: type to talk to the current session; `:tree`, `:use <name>`, `:inbox`, `:approve <id>`, `:dialogs`, `:answer <n> <text>`, `:quit`. Arguments after `--` go to every Pi session, for example `-- --model <model>`.

State lives in `<project>/.lattice/` (database, session files, worktrees). The host adds `.lattice/` to the repository's local `info/exclude` when it creates a worktree.

Do not also install the lattice extensions globally with `pi install`; the host loads them itself, and loading them twice registers every tool twice.

## Use it as a library

```ts
import { LatticeHost } from "@pi-lattice/host";

const host = await LatticeHost.start({ stateDir: ".lattice" });
const root = await host.createRoot({ name: "checkout", cwd: process.cwd(), fragments: ["coordinator"] });
host.on("node", (node) => console.log(node.name, node.status));
await host.prompt(root.id, "Plan the checkout rewrite.");
```

| Method | Does |
|---|---|
| `createRoot`, `spawnChild` | Grow the tree |
| `prompt`, `abort`, `rpc` | Talk to a node; starts it if dormant |
| `dialogs`, `answerDialog` | See and answer what blocks a node |
| `pendingMail`, `decideMail` | Approve or reject held mail |
| `traffic` | Read the envelope journal |
| `pin`, `sleep` | Control which sessions stay running |

Events: `node`, `envelope`, `mail`, `dialog`, `session`, `log`.

## Limits

`limits` in `HostOptions`, with defaults: depth 4, 8 children per node, 40 nodes per tree, 8 running sessions. When the running cap is reached the host puts the least recently active idle session to sleep; mail for a sleeping session wakes it.
