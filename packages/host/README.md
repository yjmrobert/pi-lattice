# @pi-lattice/host

The lattice host: a process that owns a tree of Pi sessions for a project.

- Runs each node as a Pi process in RPC mode, loaded with the lattice `a2a`, `roles` and `graph` extensions.
- Routes every message between sessions and journals it.
- Keeps the tree in SQLite, so it survives restarts. Sessions sleep when idle and resume on demand.
- Surfaces what needs a human: dialogs that block a session, and mail waiting for approval.

## Run it

From the repository, in your project directory:

```bash
node /path/to/pi-lattice/packages/host/src/cli.ts --role coordinator
```

Arguments after `--` go to every Pi session, for example `-- --model <model>`.

### The tree interface

The screen shows the session tree beside the conversation of the attached session, with an editor that talks to that session. Whatever you type goes to the attached node only; nothing is forced up to its parent. Slash commands such as `/role add planning` run inside that session.

| Key | Does |
|---|---|
| `ctrl+t` | Move focus to the tree and back |
| `↑` `↓` (or `k` `j`), `enter` | In the tree: move, then open the selected session |
| `alt+↑` `alt+↓` | Open the previous or next session without leaving the editor |
| `ctrl+n` (or `n` in the tree) | Create a child: name, kind, role picker, workspace, brief |
| `ctrl+a` (or `a` in the tree) | Review messages waiting for approval |
| `s` in the tree | Put the selected session to sleep |
| `ctrl+c` | Stop the attached agent's current work; twice when idle to quit |
| `ctrl+d` | Quit, when the editor is empty |

Badges in the tree: `●` idle, `◐` running, `!` blocked, `○` asleep, `✗` failed, `? n` dialogs waiting on you, `✉ n` messages awaiting approval, `@name` another owner.

When the attached session opens a dialog (a permission prompt, `/inbox`), it appears as a modal. A dialog in a session you are not attached to is never answered for you: the tree and the notice bar flag it until you open that session.

Opening a sleeping session shows it as asleep and does not start it; sending it a message does.

### Sharing a tree

Sharing is direct between two machines that can reach each other (same LAN, same VPN, or an SSH tunnel). There is no server.

```bash
pi-lattice --as alice --name checkout --listen 47610                 # start, and accept paired people
pi-lattice --as bob --listen 47610 --peer '<alice's invite>'         # join using an invite
```

`ctrl+o` (or `o` in the tree) opens sharing: show your invite, pair using someone's invite, pair with someone who knocked, offer the selected session, accept an offer, confirm a release, or cancel.

Other people's sessions appear in the tree marked `@name`. You can open and read them while their owner is online; you cannot run them. When the owner is offline they are greyed out. See [Ownership and handoff](../../docs/leases.md).

| Option | Does |
|---|---|
| `--listen [host:]port` | Accept connections from paired people. Default port 47610 when only `--peer` is given. |
| `--peer <invite>` | Pair with someone by their invite. Repeatable. |
| `--advertise <host>` | The address others should use for you, when the guessed one is wrong. |
| `--as <name>` | The name you act as. |

### Line interface

`--plain` (or a non-interactive terminal) gives a line-based interface: type to talk to the current session; `:tree`, `:use <name>`, `:inbox`, `:approve <id>`, `:dialogs`, `:answer <n> <text>`, `:quit`.

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
