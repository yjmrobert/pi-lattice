# pi-lattice (app)

Everything assembled. This is the composition root: the only package that knows about all the others.

It provides:

- **The Pi package.** Its manifest lists the launcher, pane, messaging, roles and tree extensions, so one install gives a developer all of them.
- **The launcher extension.** Starts the background host when the pane asks for one.
- **The background host.** A lattice host wired to peer-to-peer sharing, which exits on its own when idle.
- **The `pi-lattice` command**, for running the host by hand and for a line-based interface.

From a checkout, install it into Pi with `pi install /path/to/pi-lattice` (the repository root carries the same manifest).

## Command line

```bash
node packages/app/src/cli.ts daemon                 # the background host, in the foreground
node packages/app/src/cli.ts --role coordinator     # a line-based interface, for scripting and debugging
```

| Option | Does |
|---|---|
| `--cwd <dir>`, `--state <dir>` | Project directory; where the tree is kept (default `<cwd>/.lattice`) |
| `--as <name>` | The name you act as |
| `--listen [host:]port`, `--peer <invite>`, `--advertise <host>` | Sharing, peer to peer |
| `--idle-exit <seconds>` | `daemon`: exit after this long with nobody connected (default 600, 0 never) |
| `-- <pi arguments>` | Passed to every headless session, for example `-- --model <model>` |

In the line interface, type to talk to the current session; `:tree`, `:use <name>`, `:inbox`, `:approve <id>`, `:dialogs`, `:answer <n> <text>`, `:share`, `:quit`.

How the packages fit together is in [ADR 0014](../../docs/decisions/0014-package-seams.md).
