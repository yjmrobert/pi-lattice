# @pi-lattice/host

The lattice host, as a library: it owns a tree of Pi sessions for a project.

It depends only on the shared contracts. It knows nothing about sharing or about which extensions exist: it is given the extension paths to load, and an optional `SharingPort`. The [app](../app/README.md) assembles it into the background process a developer's Pi talks to.

What it does:

- Runs every session that is not open in someone's terminal as a headless Pi process, loaded with the lattice extensions.
- Hands a session to a terminal when a person opens it, and takes it back when they leave.
- Routes every message between sessions and journals it.
- Keeps the tree in SQLite, so it survives restarts. Sessions sleep when idle and wake for mail.
- Surfaces what needs a human: questions that block a session, and mail waiting for approval.
- Exposes a `SharingPort` seam, so sharing can be supplied without the host knowing how it works.

## Use it as a library

```ts
import { LatticeHost } from "@pi-lattice/host";

const host = await LatticeHost.start({ stateDir: ".lattice", extensionPaths: [a2aDir, rolesDir, graphDir] });
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
