# 0011 Collab transport (open)

To decide at the start of Phase 6. Requirements the choice must meet:

- Atomic compare-and-swap on node metadata, so stale-version writes are rejected by the transport and not just by convention.
- Authenticated identity for "a named person". The envelope `sig` field cannot stay unused once two owners share a tree.
- Works across NAT without either person running a public server, or the cost of running one is accepted explicitly.

Current lean: a shared git repository. A rejected non-fast-forward push is the compare-and-swap, signed commits give identity, and both people already have the tooling. Costs: latency of seconds, and polling. Alternatives: a small relay server, or object storage with conditional writes.

Independent of transport, and built earlier: the lease state machine is a pure function in `protocol` with unit tests for stale versions, expiry, cancel, duplicate steps and crash at every step.
