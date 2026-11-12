# 0018 A network you join once, and a session that moves in two steps

**Networks, join codes, beacons and the shared port were removed by [0029](0029-networks-are-gone.md): hosts are now introduced by the team's server ([0028](0028-the-server-introduces-the-machines-carry.md)). The two-step handoff stands.**

Changes [0012](0012-peer-to-peer-collab.md): how people find and trust each other, and how many steps a handoff takes. Its rule that hosts connect only for the same repository was relaxed by [0019](0019-everything-everyone-is-running.md), for looking only. Everything else in 0012 stands: no server, no shared storage, fetch on demand, one writer per ownership log, the release as the commit point.

**Why**

Under 0012 two people paired by exchanging invites and comparing fingerprints, each chose a port, and did it again in every repository. Three people meant three pairings per repository. A session could only be pushed, in three steps, by its owner; there was no way to ask for one. Setting up cost more than the sharing was worth.

**Decision**

- **A network is a name and a secret.** `/lattice network` creates one and prints a join code, `name.secret@host`. Whoever has the code is in. It is kept in one file in the person's lattice home, so it holds for every repository; each repository's host follows that file, and creating, joining or leaving in one terminal takes effect in all of them.
- **Membership is proved, not approved.** Both sides of every connection send a keyed hash of the handshake under the secret, on top of the signed key exchange from 0012. Someone without the secret cannot connect and learns nothing.
- **Keys are pinned on first sight.** The first key seen under a name, met directly or heard from another member, is that person from then on. A different key under a known name is refused even with the secret, and the human is asked.
- **Hosts find each other.** Nobody types an address or a port:
  - Every member's host for one repository listens on the same port, derived from the secret and the repository. Knowing a teammate's machine is therefore enough to reach them. If the port is taken, the host takes a free one and is found the other two ways.
  - On a local network, hosts announce themselves by multicast. A beacon carries a keyed hash, so only members read it, and it does not say which repository it is for.
  - Every connection starts by exchanging who each side knows and where. Knowing one member leads to all of them. The join code names the machine of whoever gave it, for the first contact.
- **A repository is its first commit.** Two hosts connect only when they work on the same repository, whatever the checkout is called. A person's hosts for other repositories know the same people but stay out of each other's trees.
- **A session moves in two steps, either way round.** Its owner offers it and the other person accepts; or a teammate asks for it and its owner approves. The owner's one act is their consent to the release, so the warning about what a release sends is shown there. The lease state machine is unchanged: the owner's host records the acceptance and then confirms by itself, and the host of someone who asked accepts by itself the moment the offer appears.
- **A session is not sent from under its owner.** If it is open in their terminal when the other person accepts, it goes when they leave it.

**Rejected**

- **A public DHT with hole punching** (Hyperswarm). It would reach across home networks with no VPN, at the cost of a native dependency and of telling a public network who is online. Teams that are not on one LAN use a VPN, which the scheme above works over. `PeerTransport` and `Discovery` are both interfaces, so this can be added without touching what is above them.
- **Approval of each newcomer by a member.** Safer against a leaked code, but it puts back the step this decision removes. A code is passed over a channel the team already trusts; a new member is announced to everyone.
- **Taking an idle session without asking.** A session carries its whole conversation. Its owner says yes each time.

**Costs accepted**

- **The code is the key to everything.** Anyone who gets it can read every member's sessions in the repositories they share, and can be offered them. There is no removing one person: the others leave and join a new network. Anything agents send each other still waits for a human's approval, as before.
- **A name is whoever claims it first.** A member could claim a teammate's name before that teammate is first seen, or tell others a false key for them. The real teammate then shows up as a changed key and the humans sort it out. This is the trust a team already extends by sharing the code.
- **Only reachable machines.** Two home networks with no VPN between them do not connect. Multicast does not cross most VPNs, so there the shared port and the known machines do the finding; a host that could not get the shared port is then only found by someone already connected to it.
- **One host per person per repository.** Two clones of one repository on one person's machines, both running, compete for the same teammates' connections.
- **Shallow clones** have a different first commit and are not recognised as the same repository.
- The handshake and the beacon are standard constructions from Node's primitives, with tests. They have not had an independent security review.

**Evidence**

`packages/collab/test` covers join codes, beacons, joining with and without the secret, a changed key, introductions through a third member, hosts for different repositories, discovery on the local network, both handoff directions, a session open in a terminal, and requests that are declined, withdrawn, expired or approved while the asker is away. `test/integration/network.test.ts` runs two background hosts with separate homes through create, join, a second host following the network file, ask and approve, offer and accept, and leave. `test/integration/collab.test.ts` moves a real session with its conversation and branch.

**Not verified**

Two physically separate machines, and a VPN. See [the manual script](../two-machine-handoff.md).
