# @pi-lattice/collab

Shares pi-lattice session trees between the people of a network, peer to peer. Each person runs their own host; the hosts find each other and connect directly over an authenticated, encrypted channel. There is no server and no shared storage.

It is a library the host loads, not a Pi extension: ownership belongs to the tree, and the tree lives in the host.

What it provides:

- **Networks.** A name and a secret, passed on as a join code. Holding the secret is membership, and a host proves it on every connection.
- **Identity.** An Ed25519 key per person, used to sign ownership events and to authenticate connections. The first key seen under a name is pinned.
- **Finding each other.** A port every member's host for one repository shares, beacons on the local network, and an exchange of who knows whom on every connection.
- **A secure channel** between two hosts, over any byte stream. TCP is the shipped transport.
- **Signed ownership logs** with one writer each, replayed through the lease state machine from `@pi-lattice/protocol`.
- **`CollabSession`**: fetches a teammate's nodes while they are online, reads a teammate's conversation on demand, carries mail between owners, and moves a session: `offer` and `accept`, or `ask` and `approve`.
- **What everyone has running.** Hosts for different repositories connect as guests, which may only look. `elsewhere()` lists teammates' trees in other repositories, and `follow(nodeId)` keeps a teammate's conversation up to date for as long as it is called.

Read [Ownership and handoff](../../docs/leases.md) for how it behaves, [ADR 0019](../../docs/decisions/0019-everything-everyone-is-running.md), [ADR 0018](../../docs/decisions/0018-networks.md) and [ADR 0012](../../docs/decisions/0012-peer-to-peer-collab.md) for why it is built this way and what it does not do, and [the two-machine script](../../docs/two-machine-handoff.md) to check it across real machines.

```ts
import { CollabSession, createNetwork, Identity, LanDiscovery, lobbyPort, networkKey, parseJoinCode, PeerBook, sharedPort, TcpTransport } from "@pi-lattice/collab";

const network = createNetwork("team");               // or parseJoinCode(theCodeATeammateGaveYou)
const key = networkKey(network);
const scope = "the-repository";                      // hosts connect only when this is the same
const collab = new CollabSession({
  host,                                              // a LatticeHost
  identity: Identity.loadOrCreate(keyDir, host.owner),
  network,
  peers: new PeerBook(peopleFile),                   // one file per person, for every repository
  transport: new TcpTransport({ port: sharedPort(key, scope), orAnyPort: true }),
  discovery: new LanDiscovery({ key, scope, name: host.owner }),
  lobby: new TcpTransport({ port: lobbyPort(network) }), // where teammates with no repository in common first ask
  directoryDir,                                      // shared by all of this person's hosts
  repo: { name: "shop", url: "git@example.com:team/shop.git" },
  scope,
  dir: workDir,
  projectDir: process.cwd(),
});
await collab.start();
console.log(collab.joinCode());                      // give this to your teammates
await collab.offer(nodeId, "sam");                   // theirs as soon as they accept
await collab.ask(theirNodeId);                       // yours as soon as they approve
```

The channel and the beacon are standard constructions built from Node's crypto primitives and are tested, but they have not had an independent security review.
