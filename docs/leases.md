# Ownership and handoff

Every node has an **owner** and a **version**. The owner's host is the only one that runs the node's session. The version counts how many times ownership has changed.

## The handoff

Ownership moves in three explicit steps, and only on the last one.

| Step | Who | What happens |
|---|---|---|
| 1. Offer | Owner | Names one trusted person. Nothing moves. The offer expires after 24 hours. |
| 2. Accept | That person | Says yes. Nothing moves yet. |
| 3. Confirm release | Owner | The session stops, its conversation and branch are shipped, the owner changes and the version increments, all in one commit. |

Until step 3 lands, the original owner keeps the node and either side can cancel. After it, the previous owner sees the node in their tree, marked with the new owner's name, and can no longer run it.

Every step is idempotent. If a host crashes mid-handoff, repeating its last step does nothing harmful: a repeated offer, accept or confirm is recognised and ignored.

## What stops things going wrong

- **Stale writes.** An offer carries the version it was made against. If ownership has moved since, it is refused.
- **Two writers.** Every change to shared state is a compare-and-swap. If two hosts change the same node at once, one lands and the other re-runs against the result.
- **Forged ownership.** Ownership is recomputed from a log of signed events. An event that is not signed by the person it names, or that the state machine would not allow, is ignored along with everything after it.
- **Strangers.** Nothing signed by a person is believed until you have trusted their key. Until then their sessions do not appear and their mail is held, not dropped.
- **A replaced key.** A person's key is pinned when you trust it. If a different key later appears under their name, it is reported as changed and not believed.

## What travels in a handoff

- The node's metadata: name, kind, brief, roles.
- The session file: the whole conversation, including any file contents and command output in it. The release step warns about this before sending.
- The branch, when the node has its own worktree, packed so the new owner can recreate it without a shared code remote.

The new owner's host adopts the session by forking it into their own checkout of the project ([ADR 0007](decisions/0007-session-transfer.md)). The conversation continues; the Pi session id is new; the node id is the same.

What does not travel: uncommitted changes in a shared (non-worktree) workspace. Commit and push those through your normal code remote first.

## Mail between owners

An agent can message a node another person owns. The envelope is signed by the sender's owner and carried through the shared store. On arrival it is checked: signed by a trusted person, who is the owner of the node it claims to come from, addressed to a node the recipient owns. Then it waits in the recipient's inbox until the human approves it. Approval is per message unless the human has deliberately trusted that sender.

## Where the rules live

| What | Where |
|---|---|
| The lease state machine | `packages/protocol/src/lease.ts` |
| Signed logs and replay | `packages/collab/src/ledger.ts` |
| Keys and trust | `packages/collab/src/identity.ts` |
| Compare-and-swap store | `packages/collab/src/shared-store.ts` |
| Sync, mail and handoff steps | `packages/collab/src/collab.ts` |

The decision and its costs are in [ADR 0011](decisions/0011-collab-transport.md).
