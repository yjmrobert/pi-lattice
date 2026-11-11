# pi-lattice

Agent-to-agent messaging, session trees, composable roles and shared ownership for [Pi](https://pi.dev).

## Use it

Install the bundle into Pi once:

```bash
pi install /path/to/pi-lattice
```

Then open `pi` in a project as you always do, and run `/lattice`. The session you are in becomes the root of a tree, and a pane on the left lists its sessions:

```
 SESSIONS
▸ ● checkout
    you · shop · feature
 ├ ◐ payments  ✉1
 │   you · shop · task
 └ ○ impl
     @sam · shop · task · offline
```

- Ask the agent to delegate, or press `alt+l` then `n`, to create child sessions. They run in the background.
- `alt+l`, arrows, `enter` opens any session in this terminal, with all of Pi.
- `/lattice share` pairs you with a collaborator, peer to peer, so you see each other's sessions and can hand one over.

Nothing changes in a session until you run `/lattice`. See the [pane readme](packages/pane/README.md) for keys, and [a feature through the full lifecycle](examples/feature-lifecycle/README.md) for a walkthrough.

## What is here

| Package | What it does |
|---|---|
| [`pane`](packages/pane/README.md) | Pi extension. The session tree as a left pane inside Pi, and the `/lattice` command. |
| [`a2a`](packages/a2a/README.md) | Pi extension. Sessions message each other; inbound mail can require human approval. Also works alone ([try it](examples/minimal-two-agents/README.md)). |
| [`roles`](packages/roles/README.md) | Pi extension. Compose a session's role from markdown fragments and change it mid-session. Also works alone ([guide](docs/roles.md)). |
| [`graph`](packages/graph/README.md) | Pi extension. Lets an agent spawn child sessions and see the tree. |
| [`host`](packages/host/README.md) | Library. Owns the tree and runs the sessions you are not in. |
| [`collab`](packages/collab/README.md) | Library. Shares a tree between people, peer to peer, with signed ownership handoff. |
| [`app`](packages/app/README.md) | Everything assembled: the Pi package, the launcher, the background host, the command line. |
| `protocol` | The contracts everything else shares: envelope, events, wire types, state machines. |

Each package depends only on `protocol` and works on its own; `app` is the one place they are put together. A test enforces this ([ADR 0014](docs/decisions/0014-package-seams.md)).

## Documentation

- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions/README.md)
- [Envelope specification](docs/envelope-spec.md)
- [Roles](docs/roles.md)
- [Ownership and handoff](docs/leases.md)

## Development

```bash
npm install
npm run check          # typecheck and tests
npm run spike:phase0   # re-run the Phase 0 verification against real Pi processes
```

Requires Node 22.19 or newer and git. Tests and spikes run real Pi processes against a scripted model: no network, no tokens, and they do not read your Pi configuration.

## Not done yet

- **Publishing.** Nothing is on npm, so the bundle is installed from a checkout. The host and `protocol` need a build step first ([ADR 0001](docs/decisions/0001-packaging-and-scope.md)), and the `@pi-lattice` scope has not been claimed.
- **A run with a real model.** Every flow is tested against a scripted model, which checks the mechanics, not how well a model follows the role fragments.
- **Two real machines.** Sharing is tested with two isolated hosts on one machine ([manual script](docs/two-machine-handoff.md)).
- **Sharing across arbitrary networks.** The two machines must reach each other directly (LAN, VPN, SSH tunnel). Hole-punching is not built ([ADR 0012](docs/decisions/0012-peer-to-peer-collab.md)).
- **The side pane relies on Pi internals.** It falls back to a compact list if they change ([ADR 0013](docs/decisions/0013-pane-inside-pi.md)).
- **Licence.** None has been chosen.
