# pi-lattice

Agent-to-agent messaging, session trees, composable roles and shared ownership for [Pi](https://pi.dev).

Status: Phase 0 complete (verification spikes and design). No usable packages yet.

- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions/README.md)

## Development

```bash
npm install
npm run check          # typecheck and tests
npm run spike:phase0   # re-run the Phase 0 verification against real Pi processes
```

Requires Node 22.19 or newer. The spikes use a scripted model provider: no network, no tokens, and they do not read your Pi configuration.
