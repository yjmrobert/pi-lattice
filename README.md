# pi-lattice

Agent-to-agent messaging, session trees, composable roles and shared ownership for [Pi](https://pi.dev).

## Use it

Install the bundle into Pi once:

```bash
pi install /path/to/pi-lattice
```

Then open `pi` in a project as you always do. A pane on the left lists the project's sessions:

```
 ◆ shop                3 sessions
▸ ⠹ checkout              feature
  ├ ● payments            ✉1 task
  └ ○ impl           @sam offline
──────────────────────────────────
 alt+l to answer        1 waiting
```

- In a git repository there is nothing to set up: your first message starts the tree, and each new session joins with its first message. Elsewhere, run `/lattice` once.
- What needs you is listed above the tree: questions a background session is stuck on, messages to approve. `alt+l` gives the pane the keyboard, and you answer them where they are (`y`/`n`, `a`/`x`).
- With the keyboard, the chat steps aside to show the selected session in full. `enter` opens it in this terminal, with all of Pi. You can switch at any time, even mid-turn: the work you leave carries on in the background.
- `n` creates a child session from one form. Agents can also delegate on their own. Children run in the background, each on the model you choose.
- `r` renames a session, `d` archives it, `s` stops what it is doing. `?` lists every key, and `/lattice help` every command.
- `,` in the pane, or `/lattice config`, opens the settings: models, roles, limits and the pane itself, for this repository or for all of yours. `/lattice doctor` checks the setup.
- Sessions are told how to talk to each other, and you can read and change all of it: `/lattice prompt` shows what a session has been told and the file each part comes from.
- Work in several repositories shows in one pane. Opening a session from another repository moves this terminal there; `-` goes back.
- `/lattice network` puts you and your teammates in one network, once: create it, pass on the join code, and from then on everyone's sessions show in everyone's pane, in every repository you share. `o` offers one of yours to a teammate; `t` asks for one of theirs. It is peer to peer, with no server.

See the [pane readme](packages/pane/README.md) for keys, and [a feature through the full lifecycle](examples/feature-lifecycle/README.md) for a walkthrough.

## What is here

| Package | What it does |
|---|---|
| [`pane`](packages/pane/README.md) | Pi extension. The session trees of every repository as a left pane inside Pi, and the `/lattice` command. |
| [`a2a`](packages/a2a/README.md) | Pi extension. Sessions message each other; inbound mail can require human approval. Also works alone ([try it](examples/minimal-two-agents/README.md)). |
| [`roles`](packages/roles/README.md) | Pi extension. Compose a session's role from markdown fragments and change it mid-session. Also works alone ([guide](docs/roles.md)). |
| [`graph`](packages/graph/README.md) | Pi extension. Lets an agent spawn child sessions and see the tree. |
| [`host`](packages/host/README.md) | Library. Owns the tree and runs the sessions you are not in. |
| [`collab`](packages/collab/README.md) | Library. Shares trees between the people of a network, peer to peer, with signed ownership handoff. |
| [`app`](packages/app/README.md) | Everything assembled: the Pi package, the launcher, the background host, the command line. |
| `protocol` | The contracts everything else shares: envelope, events, wire types, state machines. |

Each package depends only on `protocol` and works on its own; `app` is the one place they are put together. A test enforces this ([ADR 0014](docs/decisions/0014-package-seams.md)).

## Documentation

- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions/README.md)
- [Testing by hand with a real model](docs/testing.md)
- [Envelope specification](docs/envelope-spec.md)
- [Settings, roles files and environment variables](docs/settings.md)
- [Roles](docs/roles.md)
- [Ownership and handoff](docs/leases.md)

## Development

```bash
npm install
npm run check          # typecheck and tests
npm run dev            # open Pi on this checkout, in a scratch repository under .dev/ (-- --faux for the scripted model)
npm run eval           # one delegation with a real model, checked for how the sessions talked (spends tokens)
npm run docs           # rewrite docs/settings.md from the settings table
npm run spike:phase0   # re-run the Phase 0 verification against real Pi processes
```

Requires Node 22.19 or newer and git. Tests and spikes run real Pi processes against a scripted model: no network, no tokens, and they do not read your Pi configuration. The tests of the pane in Pi's terminal interface need `script` (util-linux) for a pseudo-terminal and are skipped where it is missing.

## Not done yet

- **Publishing.** Nothing is on npm, so the bundle is installed from a checkout. The host and `protocol` need a build step first ([ADR 0001](docs/decisions/0001-packaging-and-scope.md)), and the `@pi-lattice` scope has not been claimed.
- **A run with a real model.** Every flow is tested against a scripted model, which checks the mechanics, not how well a model follows the role fragments. `npm run eval` is written for that and has not been run yet.
- **Two real machines.** Sharing is tested with two isolated hosts on one machine ([manual script](docs/two-machine-handoff.md)).
- **Sharing across arbitrary networks.** The two machines must reach each other directly (LAN, VPN, SSH tunnel). Hole-punching is not built ([ADR 0012](docs/decisions/0012-peer-to-peer-collab.md)).
- **The side pane relies on Pi internals.** It falls back to a compact list if they change ([ADR 0013](docs/decisions/0013-pane-inside-pi.md)).
- **Licence.** None has been chosen.
