# 0012 Collab is peer to peer, with no server and no shared storage

Supersedes [0011](0011-collab-transport.md). Pairing by invite and the separate confirm step were replaced by [0018](0018-networks.md); the rest stands.

**Decision**

Each person's host talks directly to the other's over an authenticated, encrypted channel. Nothing sits between them.

- **Online only.** A peer's sessions are fetched from that peer while they are connected. When they are not, their nodes stay in the tree as last seen, greyed out. A handoff needs both people online, which is natural since both have to act.
- **Fetch, not stream.** On connect a host asks its peer for the nodes it owns. After that the owner sends a one-word "changed" note and the peer fetches again. A session's conversation is fetched only when someone opens it. No session events are streamed between machines.
- **One writer per ownership log.** Only a node's current owner appends to its log. The recipient's acceptance is a signed request to the owner, who records it. This removes the need for compare-and-swap, which is what required shared storage in 0011. A peer takes a log only if its signatures verify and it extends the one already known; a log that contradicts a known one is refused and reported.
- **Pairing by invite.** An invite is `name@host:port#key`. Accepting one pins that person's key and address. The other side sees who knocked, with a fingerprint to compare, and pairs back. A different key under a paired name is refused and flagged.
- **The channel** is a signed ephemeral Diffie-Hellman exchange (X25519, signatures with each person's Ed25519 identity key), then ChaCha20-Poly1305 frames with a per-direction counter. Each side checks the other against its pinned key, so only paired people connect, and recorded traffic cannot be decrypted later with an identity key.
- **Transport is an interface.** `PeerTransport` opens a byte stream to an address. TCP is the one implementation: it covers a LAN, a VPN and an SSH tunnel. A hole-punching transport for arbitrary networks would implement the same interface without touching anything above it.

**The release is the commit point**

Confirming a release records the signed confirmation, gives the node up locally, and sends the conversation and branch straight to the new owner. If the connection drops before they acknowledge, the package is kept on the old owner's disk and sent again on the next contact; it is deleted only on the new owner's signed receipt. The alternative, waiting for the receipt before committing, would let a crash leave both people believing they own the node.

**Mail**

Delivered directly when the owner is online. Otherwise it waits in the sender's own outbox and goes on reconnect. The channel proves who sent it; the recipient also checks that the sending session belongs to that person, then holds the message for the human's approval as before.

**What this fixes from 0011**

- No repository to create, host or keep private.
- A transferred session is never stored anywhere but the two machines, and is encrypted in transit.
- Changes arrive immediately instead of on a polling interval.

**Costs accepted**

- Nothing works across a peer who is offline, except reading what was last seen and queueing mail.
- One side must be reachable by the other. Behind NAT without a VPN, neither is; that needs the hole-punching transport, which is not built.
- A node released to someone who never comes back online stays released, with its package waiting. Recovering it needs them, or a deliberate override that does not exist yet.
- An owner could sign two different continuations of a log and show one to each of two peers. Each peer will refuse the other's version when they meet, and say so, but nothing prevents it up front. This is acceptable between collaborators who have chosen to pair.
- The channel is a standard construction from Node's primitives with tests for strangers, wrong keys, impostors and tampering. It has not had an independent security review.
- Transfers are sent as one message, limited to 128 MB. A very large branch would need chunking.

**Evidence**

`packages/collab/test` covers the channel, pairing, change notes, offline and reconnect, every handoff step, a failed delivery retried, and refused mail. `test/integration/collab.test.ts` runs two real hosts with separate Pi configurations, project checkouts and keys through pairing, an on-demand read of a peer's session, a full handoff with conversation and branch, mail held for approval in both directions, and one side going offline.

**Not verified**

Two physically separate machines. The tests use two isolated hosts on one machine connected over local TCP. See [the manual script](../two-machine-handoff.md).
