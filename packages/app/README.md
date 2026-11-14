# pi-lattice (app)

Everything assembled. This is the composition root: the only package that knows about all the others.

It provides:

- **The Pi package.** Its manifest lists the launcher, pane, messaging, roles and tree extensions, so one install gives a developer all of them.
- **The launcher extension.** Starts the background host when the pane asks for one.
- **The background host.** A lattice host that shares with the person's team, the people on the server they joined, and exits on its own when idle. It follows the server file in the lattice home, so there is nothing to switch on per repository.
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
| `--as <name>` | The name you act as. Default: the one you chose when joining a server, else your OS user name |
| `--advertise <host>` | The address teammates should reach this machine at (default: every network address it has) |
| `--idle-exit <seconds>` | `daemon`: exit after this long with nobody connected (default 600, 0 never) |
| `-- <pi arguments>` | Passed to every headless session, for example `-- --model <model>` |

### The team's work, from a shell

```bash
pi-lattice work                    # the work that is not finished, as a tree
pi-lattice work next               # take the next ready issue; prints its brief and the directions above it
pi-lattice work note 38 "the vault token is per customer"
pi-lattice work done 38 --summary "Wrong input is marked before submit." --check "14 tests pass"
pi-lattice work drop 38 "needs the staging key"
pi-lattice work prime              # what to put in an agent's instructions
```

For agents that are not Pi sessions (anything with a shell) and for scripts. It talks to the server this machine has joined, as that person; `--agent <name>` or `LATTICE_AGENT` says which agent is asking, and that is recorded with everything it does. `--json` prints data. An issue taken with `next` is the agent's while it goes on speaking of it, and is given back after thirty minutes of silence. It exits 3 when there is nothing to take and 4 when refused. `pi-lattice work --help` lists the rest.

There is no command here for a person to edit issues with: a person says what they want in Pi, on the tree.

In the line interface, type to talk to the current session; `:tree`, `:use <name>`, `:inbox`, `:approve <id>`, `:dialogs`, `:answer <n> <text>`, `:quit`; and for the team `:people`, `:handoffs`, `:offer`, `:take`, `:approve` (`:help` lists them all).

How the packages fit together is in [ADR 0014](../../docs/decisions/0014-package-seams.md).
