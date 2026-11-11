# pi-lattice

Agent-to-agent messaging, session trees, composable roles and shared ownership for [Pi](https://pi.dev).

Status: early. `@pi-lattice/a2a` ([try it](examples/minimal-two-agents/README.md)) and `@pi-lattice/roles` ([guide](docs/roles.md)) work on their own. The [host](packages/host/README.md) runs a tree of sessions you can enter at any node, with a full-screen tree interface, and can [share a tree between people](docs/leases.md) with signed ownership handoff.

- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions/README.md)
- [Envelope specification](docs/envelope-spec.md)
- [Roles](docs/roles.md)
- [Ownership and handoff](docs/leases.md)
- Examples: [two agents, no host](examples/minimal-two-agents/README.md), [a feature through the full lifecycle](examples/feature-lifecycle/README.md)

## Development

```bash
npm install
npm run check          # typecheck and tests
npm run spike:phase0   # re-run the Phase 0 verification against real Pi processes
```

Requires Node 22.19 or newer. The spikes use a scripted model provider: no network, no tokens, and they do not read your Pi configuration.
