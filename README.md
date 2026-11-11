# pi-lattice

Agent-to-agent messaging, session trees, composable roles and shared ownership for [Pi](https://pi.dev).

## What is here

| Package | What it does | Works alone |
|---|---|---|
| [`a2a`](packages/a2a/README.md) | Pi extension. Sessions message each other; inbound mail can require human approval. | Yes ([try it](examples/minimal-two-agents/README.md)) |
| [`roles`](packages/roles/README.md) | Pi extension. Compose a session's role from markdown fragments and change it mid-session. | Yes ([guide](docs/roles.md)) |
| [`graph`](packages/graph/README.md) | Pi extension. A session spawns child sessions and sees the tree. | Needs the host |
| [`host`](packages/host/README.md) | Process that owns a tree of sessions, with a full-screen interface to enter any node. | Yes |
| [`collab`](packages/collab/README.md) | Library. Share a tree between people, with signed ownership handoff. | Loaded by the host |
| `protocol` | Shared envelope schema, state machines and wire types. | Library |

## Try it

From a project directory (a git repository, if you want children to get their own worktrees):

```bash
node /path/to/pi-lattice/packages/host/src/cli.ts --role coordinator,lifecycle,feature
```

That starts a host with one root session, using your installed `pi` and its configuration. See the [host readme](packages/host/README.md) for keys and options, and [a feature through the full lifecycle](examples/feature-lifecycle/README.md) for a walkthrough.

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

- **Publishing.** Nothing is on npm. The host and `protocol` need a build step first ([ADR 0001](docs/decisions/0001-packaging-and-scope.md)), and the `@pi-lattice` scope has not been claimed.
- **A run with a real model.** Every flow is tested against a scripted model, which checks the mechanics, not how well a model follows the role fragments.
- **Two real machines.** Sharing is tested with two isolated hosts on one machine ([manual script](docs/two-machine-handoff.md)).
- **Licence.** None has been chosen.
