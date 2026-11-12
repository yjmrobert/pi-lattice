# Ownership and handoff

Every node has an **owner** and a **version**. The owner's host is the only one that runs the node's session. The version counts how many times ownership has changed.

Sessions are shared machine to machine. Each person runs their own host, and the hosts connect directly; the team's server introduces them and carries offers and requests, and never holds a session ([ADR 0012](decisions/0012-peer-to-peer-collab.md), [ADR 0028](decisions/0028-the-server-introduces-the-machines-carry.md), [ADR 0029](decisions/0029-networks-are-gone.md)).

## The team

Your team is the people on the server you have joined. You join once, and it holds for every repository.

1. Someone has a server: a board on their own machine (`/lattice server start`, then `/lattice server share`), or `pi-lattice server` on a machine that stays on. Either prints a line to send: `/lattice server http://host:port/#code`.
2. They pass that line to their teammates over a channel the team already trusts. Whoever has it is in.
3. Each teammate pastes it into their Pi, in any project. The first time, they are asked what teammates should call them. When teammates are around, the pane says who was found.

That is all. Nobody approves anybody, chooses a port or types a teammate's address. Everyone is told when someone joins.

The server tells each host where the others are listening and which key each person signs with, and the hosts connect by themselves. Two machines that cannot reach each other at all, such as two home networks with no VPN between them, do not connect, even though both reach the server: the canopy shows each other's sessions on the server's work, and they cannot be read or handed over. If the address a machine gives out is not the one teammates should use, set `LATTICE_ADVERTISE` on it.

A repository is recognised by its first commit, not by what the checkout is called. Hosts for the same repository share its tree and can hand sessions over. Hosts for different repositories still connect, but only to look ([ADR 0019](decisions/0019-everything-everyone-is-running.md)).

To keep one repository to yourself, switch `network.share` off for it in the settings (`,` in the pane). Its sessions are then shown to nobody, and nobody's are shown in it.

The first key known under a person's name is theirs from then on: the server refuses another, and so does every host. If someone later connects under that name with a different key, they are refused and you are asked (`/lattice team`): that is what a new machine looks like, and also what an impostor looks like. To use a second machine as yourself, copy the `identity` folder and `server.json` from your lattice home to it.

Your name on the server and the name your sessions are under must be the same; when they are not, nothing is shared and the host says so.

To stop sharing everywhere, leave the server (`/lattice server leave`). There is no removing someone else: the team moves to a new server.

## What you see of a teammate

The first line of the pane names the server and who is around.

- **In a repository you both have**, their sessions appear in its tree, marked `@name`.
- **In a repository you do not have**, their sessions are listed after your own repositories, under the repository's name and "not here". The group is folded to one line until you give the pane the keyboard.
- You cannot run their sessions or type into them. `enter` fetches the conversation and shows it read-only.
- **While a teammate's session is under the cursor**, what it last did is shown beside the pane and kept up to date: its owner's machine sends each new message as it is written. It stops when you move away.
- When they cannot be reached, their sessions stay as last seen, marked offline, and cannot be opened or asked for until they are back. The same goes for a session in a repository you both have when their host for that repository is not running.

## Handing a session over

A session changes hands in two steps, and it can start from either side.

| | First | Then |
|---|---|---|
| **You give** | You press `o` on one of your sessions and pick a teammate. | They press `a` on the offer. It is theirs. |
| **You take** | You press `t` on a teammate's session. | They press `a` on your request and confirm. It is yours. |

The owner acts once. That one act is their yes to the release, so it is where they are told what a release sends. When the second step happens, the owner's host stops the session, records the signed release and sends the conversation and branch straight to the new owner, without asking again.

- **A session in a repository you do not have** can be asked for the same way. `t` first clones the repository from where its owner has it: you are shown the address and the folder, and asked once which folder clones go into (`network.cloneDir`). If its owner's checkout has no remote, there is nothing to clone from and you are told so.
- An offer or a request nobody answers lapses after 24 hours. Either side can take theirs back before then (`x` on an offer, `t` again on a session you asked for).
- The offer, the request and their answers go through the server; the session itself goes straight between the two machines. Both people need to be online for it to move. A yes given while the other is away takes effect when they are back.
- A session that is open in its owner's terminal is not sent from under them. It goes when they leave it, and the pane says so.
- After the move, the previous owner sees the session marked with the new owner's name and can no longer run it, though they can still read it.

Every step can be repeated safely. If a host crashes partway, the handoff carries on from where it was when the host is back.

If the connection drops during the release, the release still stands. The package stays on the old owner's machine and is sent again on the next contact; it is deleted only when the new owner signs for it. The old owner's screen says so until then.

## What stops things going wrong

- **Stale writes.** An offer carries the version it was made against. If ownership has moved since, it is refused.
- **One writer.** Only a node's current owner appends to its ownership log. Everyone else asks the owner, so two hosts never write the same log at once.
- **Forged ownership.** Ownership is recomputed from a log of signed events. An event not signed by the person it names, or one the state machine would not allow, is ignored along with everything after it.
- **Contradicting histories.** A host accepts a log only if it extends the one it already holds. A log that disagrees is refused and reported.
- **Strangers.** Only someone who holds the team's secret can connect at all, and they have to prove it on every connection. The server gives the secret to those who joined it.
- **Impostors.** A known name with a different key is refused until you accept the new key.
- **Eavesdropping.** Everything between two hosts is encrypted, with keys that exist only for that connection.

## What travels in a handoff

- The node's metadata: name, kind, brief, roles.
- The session file: the whole conversation, including any file contents and command output in it. You are told this before you offer a session or approve a request for one.
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
| The team's secret and proving membership | `packages/collab/src/network.ts` |
| The people of the team and their keys | `packages/collab/src/peers.ts` |
| Who is where, keys, and carrying offers and requests | `packages/server/src/http.ts`, `packages/app/src/work.ts` |
| What everyone has running, guests, and watching a session | `packages/collab/src/collab.ts` |
| Repositories that are not here, in the pane; cloning to take | `packages/pane/src/view.ts`, `packages/pane/src/extension.ts` |
| The encrypted channel | `packages/collab/src/channel.ts` |
| Connections, fetching, mail, offers and requests | `packages/collab/src/collab.ts` |
| Following the server joined, one host per repository | `packages/app/src/daemon.ts` |
