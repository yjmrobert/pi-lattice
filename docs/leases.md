# Ownership and handoff

Every node has an **owner** and a **version**. The owner's host is the only one that runs the node's session. The version counts how many times ownership has changed.

Sharing is peer to peer. Each person runs their own host, and the hosts connect directly; there is no server and no shared storage ([ADR 0012](decisions/0012-peer-to-peer-collab.md)).

## Pairing

1. One person turns sharing on and shows their invite (`/lattice share`, "Show my invite"). It looks like `name@host:port#key`.
2. The other pairs with it ("Pair using someone's invite"). Their host connects.
3. The first person is told who knocked, compares the key fingerprint with them over a call or in person, and pairs back.

From then on the two hosts connect whenever both are running. Someone using a paired name with a different key is refused, and you are told.

## What you see of a peer

- Their sessions appear in your pane, marked `@name`. You cannot run them or type into them.
- Opening one fetches its conversation from them and shows it read-only.
- When they are offline, their sessions stay in your pane as last seen, marked offline, and cannot be opened until they are back.

## The handoff

Ownership moves in three explicit steps, and only on the last one. Both people need to be online for steps 2 and 3.

| Step | Who | What happens |
|---|---|---|
| 1. Offer | Owner | Names one paired person. Nothing moves. The offer expires after 24 hours. |
| 2. Accept | That person | Says yes. The owner's host records it. Nothing moves yet. |
| 3. Confirm release | Owner | The session stops, the signed confirmation is recorded, and the conversation and branch go straight to the new owner. |

Until step 3, the original owner keeps the node and either side can cancel. After it, the previous owner sees the node marked with the new owner's name and can no longer run it, though they can still read it.

Every step can be repeated safely. If a host crashes mid-handoff, doing its last step again is recognised and ignored.

If the connection drops during step 3, the release still stands. The package stays on the old owner's machine and is sent again on the next contact; it is deleted only when the new owner signs for it. The old owner's screen says so until then.

## What stops things going wrong

- **Stale writes.** An offer carries the version it was made against. If ownership has moved since, it is refused.
- **One writer.** Only a node's current owner appends to its ownership log. Everyone else asks the owner, so two hosts never write the same log at once.
- **Forged ownership.** Ownership is recomputed from a log of signed events. An event not signed by the person it names, or one the state machine would not allow, is ignored along with everything after it.
- **Contradicting histories.** A host accepts a log only if it extends the one it already holds. A log that disagrees is refused and reported.
- **Strangers.** Only paired people can connect at all.
- **Eavesdropping.** Everything between two hosts is encrypted, with keys that exist only for that connection.

## What travels in a handoff

- The node's metadata: name, kind, brief, roles.
- The session file: the whole conversation, including any file contents and command output in it. The release step warns about this before sending.
- The branch, when the node has its own worktree, packed so the new owner can recreate it without a shared code remote.

The new owner's host adopts the session by forking it into their own checkout of the project ([ADR 0007](decisions/0007-session-transfer.md)). The conversation continues; the Pi session id is new; the node id is the same.

What does not travel: uncommitted changes in a shared (non-worktree) workspace. Commit and push those through your normal code remote first.

## Mail between owners

An agent can message a node another person owns. It is delivered directly when that person is online; otherwise it waits on the sender's machine and goes when they reconnect. The receiving host checks that the sending session really belongs to the person who sent it, then holds the message in the inbox until the human approves it. Approval is per message unless the human has deliberately trusted that sender.

## Where the rules live

| What | Where |
|---|---|
| The lease state machine | `packages/protocol/src/lease.ts` |
| Signed logs and replay | `packages/collab/src/ledger.ts` |
| Keys and signatures | `packages/collab/src/identity.ts` |
| Paired people and invites | `packages/collab/src/peers.ts` |
| The encrypted channel | `packages/collab/src/channel.ts` |
| Connections, fetching, mail and handoff steps | `packages/collab/src/collab.ts` |
