# @pi-lattice/collab

Shares a pi-lattice session tree between people, peer to peer. Each person runs their own host; the hosts connect directly over an authenticated, encrypted channel. There is no server and no shared storage.

It is a library the host loads (`pi-lattice --listen <port>`), not a Pi extension: ownership belongs to the tree, and the tree lives in the host.

What it provides:

- **Identity.** An Ed25519 key per person, used to sign ownership events and to authenticate connections.
- **Pairing.** Invites (`name@host:port#key`) and a book of paired people with pinned keys.
- **A secure channel** between two hosts, over any byte stream. TCP is the shipped transport.
- **Signed ownership logs** with one writer each, replayed through the lease state machine from `@pi-lattice/protocol`.
- **`CollabSession`**: fetches a peer's nodes while they are online, reads a peer's conversation on demand, carries mail between owners, and runs the handoff steps `offer`, `accept`, `confirm`, `cancel`.

Read [Ownership and handoff](../../docs/leases.md) for how it behaves, [ADR 0012](../../docs/decisions/0012-peer-to-peer-collab.md) for why it is built this way and what it does not do, and [the two-machine script](../../docs/two-machine-handoff.md) to check it across real machines.

```ts
import { CollabSession, Identity, PeerBook, TcpTransport } from "@pi-lattice/collab";

const collab = new CollabSession({
  host,                                             // a LatticeHost
  identity: Identity.loadOrCreate(keyDir, host.owner),
  peers: new PeerBook(peersFile),
  transport: new TcpTransport({ port: 47610 }),
  dir: workDir,
  projectDir: process.cwd(),
});
await collab.start();
console.log(collab.invite());                       // give this to a collaborator
await collab.addInvite(theirInvite);                // or pair with theirs
await collab.offer(nodeId, "sam");
```

The channel is a standard construction built from Node's crypto primitives and is tested, but it has not had an independent security review.
