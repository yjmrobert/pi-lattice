# @pi-lattice/host

The lattice host: a background process that owns a tree of Pi sessions for a project.

Most people never run it. The [pane](../pane/README.md) inside Pi starts it on demand and stops needing it when you quit. This page is for scripting, debugging and using it as a library.

What it does:

- Runs every session that is not open in someone's terminal as a headless Pi process, loaded with the lattice extensions.
- Hands a session to a terminal when a person opens it, and takes it back when they leave.
- Routes every message between sessions and journals it.
- Keeps the tree in SQLite, so it survives restarts. Sessions sleep when idle and wake for mail.
- Surfaces what needs a human: questions that block a session, and mail waiting for approval.
- Shares the tree peer to peer when asked ([Ownership and handoff](../../docs/leases.md)).

## Run it by hand

```bash
node /path/to/pi-lattice/packages/host/src/cli.ts daemon          # the background host, in the foreground
node /path/to/pi-lattice/packages/host/src/cli.ts --role coordinator   # a line-based interface
```

The line interface is for scripting and debugging: type to talk to the current session; `:tree`, `:use <name>`, `:inbox`, `:approve <id>`, `:dialogs`, `:answer <n> <text>`, `:share`, `:quit`.

| Option | Does |
|---|---|
| `--cwd <dir>`, `--state <dir>` | Project directory; where the tree is kept (default `<cwd>/.lattice`) |
| `--as <name>` | The name you act as |
| `--listen [host:]port`, `--peer <invite>`, `--advertise <host>` | Sharing, peer to peer |
| `--idle-exit <seconds>` | `daemon`: exit after this long with nobody connected (default 600, 0 never) |
| `-- <pi arguments>` | Passed to every headless session, for example `-- --model <model>` |

State lives in `<project>/.lattice/`: the database, session files, worktrees, and `daemon.log`. The host adds `.lattice/` to the repository's local `info/exclude` when it creates a worktree.

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
| `createRoot`, `spawnChild`, `adoptSession` | Grow the tree |
| `prompt`, `abort`, `rpc`, `readMessages` | Talk to or read a headless node |
| `attachForeground`, `detachForeground` | Hand a node to a terminal and take it back |
| `dialogs`, `answerDialog` | See and answer what blocks a node |
| `pendingMail`, `decideMail` | Approve or reject held mail |
| `traffic` | Read the envelope journal |
| `uiState` | Everything the pane shows |

Events: `node`, `envelope`, `mail`, `dialog`, `session`, `log`.

## Limits

`limits` in `HostOptions`, with defaults: depth 4, 8 children per node, 40 nodes per tree, 8 headless sessions. When the cap is reached the host puts the least recently active idle session to sleep; mail for a sleeping session wakes it.
