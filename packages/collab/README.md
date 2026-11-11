# @pi-lattice/collab

Shares a pi-lattice session tree between people. Each person runs their own host; this library keeps the hosts in agreement through a private git repository, and moves nodes between owners with a signed, two-phase handoff.

It is a library the host loads (`pi-lattice --share <git url> --as <name>`), not a Pi extension: ownership belongs to the tree, and the tree lives in the host.

What it provides:

- **Identity.** An Ed25519 key per person. Everything shared is signed; nothing is believed until the human trusts the signer's key by comparing fingerprints.
- **A shared store** with compare-and-swap commits (`GitSharedStore`).
- **Signed ownership logs**, replayed through the lease state machine from `@pi-lattice/protocol`.
- **`CollabSession`**: publishes your nodes, imports other people's as read-only, carries signed mail between owners, and runs the handoff steps `offer`, `accept`, `confirm`, `cancel`.

Read [Ownership and handoff](../../docs/leases.md) for how it behaves, [ADR 0011](../../docs/decisions/0011-collab-transport.md) for why it is built this way, and [the two-machine script](../../docs/two-machine-handoff.md) to check it across real machines.

```ts
import { CollabSession, GitSharedStore, Identity, TrustStore } from "@pi-lattice/collab";

const collab = new CollabSession({
  host,                                    // a LatticeHost
  identity: Identity.loadOrCreate(keyDir, host.owner),
  trust: new TrustStore(trustFile),
  store: new GitSharedStore({ remote, dir: workingCopy, author: host.owner }),
  dir: queueDir,
  projectDir: process.cwd(),
});
await collab.start();
await collab.trustPerson("sam");           // after comparing collab.people() fingerprints
await collab.offer(nodeId, "sam");
```

The shared repository must be private to the collaborators: a transferred session contains the whole conversation, and git history keeps it.
