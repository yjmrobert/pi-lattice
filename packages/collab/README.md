# @pi-lattice/collab

Shares pi-lattice session trees between the people of a team, machine to machine. Each person runs their own host; the hosts connect directly over an authenticated, encrypted channel. Nothing of a session is stored anywhere else.

It is a library the host loads, not a Pi extension: ownership belongs to the tree, and the tree lives in the host.

What it provides:

- **Membership.** A team is a name and a secret. Holding the secret is membership, and a host proves it on every connection. The secret comes from whatever starts the session: in pi-lattice, the team's server.
- **Identity.** An Ed25519 key per person, used to sign ownership events and to authenticate connections. The first key known under a name is pinned.
- **Being introduced.** A host does not look for anyone. It is told who is on the team (`learn`) and where their hosts are (`heardAt`), and says where it can be reached (`listening`).
- **A secure channel** between two hosts, over any byte stream. TCP is the shipped transport.
- **Signed ownership logs** with one writer each, replayed through the lease state machine from `@pi-lattice/protocol`.
- **A relay**, optional: something both hosts can reach, such as their team's server, that carries offers, requests and their answers in place of the connection.
- **`CollabSession`**: fetches a teammate's nodes while they are online, reads a teammate's conversation on demand, carries mail between owners, and moves a session: `offer` and `accept`, or `ask` and `approve`.
- **What everyone has running.** Hosts for different repositories connect as guests, which may only look. `elsewhere()` lists teammates' trees in other repositories, and `follow(nodeId)` keeps a teammate's conversation up to date for as long as it is called.

Read [Ownership and handoff](../../docs/leases.md) for how it behaves, [ADR 0012](../../docs/decisions/0012-peer-to-peer-collab.md), [ADR 0019](../../docs/decisions/0019-everything-everyone-is-running.md), [ADR 0028](../../docs/decisions/0028-the-server-introduces-the-machines-carry.md) and [ADR 0029](../../docs/decisions/0029-networks-are-gone.md) for why it is built this way and what it does not do, and [the two-machine script](../../docs/two-machine-handoff.md) to check it across real machines.

```ts
import { CollabSession, Identity, PeerBook, TcpTransport } from "@pi-lattice/collab";

const scope = "the-repository";                      // hosts hand sessions over only when this is the same
const collab = new CollabSession({
  host,                                              // a LatticeHost
  identity: Identity.loadOrCreate(keyDir, host.owner),
  network: { name: "team", secret },                 // 32 random bytes, base64url, the same for every member
  peers: new PeerBook(peopleFile),                   // one file per person, for every repository
  transport: new TcpTransport({ port: 0 }),          // any free port
  relay,                                             // optional: carries offers and requests
  directoryDir,                                      // shared by all of this person's hosts
  repo: { name: "shop", url: "git@example.com:team/shop.git" },
  scope,
  dir: workDir,
  projectDir: process.cwd(),
});
await collab.start();
tellTheTeam(collab.listening());                     // where this host can be reached
collab.learn("sam", samsPublicKey);                  // who a teammate is
collab.heardAt("sam", ["10.0.0.7:41233"], true);     // where their host for this repository is
await collab.offer(nodeId, "sam");                   // theirs as soon as they accept
await collab.ask(theirNodeId);                       // yours as soon as they approve
```

The channel is a standard construction built from Node's crypto primitives and is tested, but it has not had an independent security review.
