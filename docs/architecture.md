# pi-lattice architecture

This is the working design. It supersedes the original handoff plan where they differ; every difference is backed by a record in [decisions/](decisions/README.md).

## Goal

An additive set of Pi extensions plus a host process that provide:

1. Agent-to-agent messaging between Pi sessions.
2. A session tree the human can enter at any node. Nothing is forced to bubble up.
3. Composable roles the human assigns to a session, instead of fixed agent profiles.
4. Lifecycle coordination: grilling, planning, implementation, verification.
5. Trees shared between the people of a network, set up once, with explicit ownership, handoff in either direction, and approval of anything inbound from another person's agents.

Non-goals: token optimisation, a library of agent personas, running agents on someone else's machine without their approval.

## Shape

Two kinds of thing, kept separate.

**Extensions** run inside each Pi session. Each is optional and useful alone. They share types through `@pi-lattice/protocol` and find each other at runtime through `pi.events`. No extension imports another.

**The host** is a separate Node process that runs in the background. It owns the tree, runs the sessions nobody has open, and brokers messages. It has no interface of its own: the developer's Pi is the interface ([ADR 0013](decisions/0013-pane-inside-pi.md)).

```
        developer
            |
   +------------------+   control socket    +-------------+
   | pi (interactive) |<------------------->|    host     |
   |  pane  a2a       |   (tree, takeover,  | tree store  |
   |  roles graph     |    approvals)       | broker      |
   +------------------+                     +-------------+
     the session that is                      |  stdio RPC + socket
     open in this terminal                    v
                                    +-------------------+
                                    | pi (headless) x N |   every other session
                                    |  a2a roles graph  |
                                    +-------------------+

   another person's host  <== encrypted peer channel ==>  host
```

## Packages

| Package | What it is | Depends on |
|---|---|---|
| `protocol` | The contracts: envelope, typed events, host assignment, wire frames, inbound and lease state machines. No I/O, no Pi. | typebox |
| `a2a` | Extension. `send_message`, `/inbox`, inbound state machine, `Transport` interface, file and host transports. | protocol |
| `roles` | Extension plus markdown fragments. `/role`, `apply_role`, prompt-section injection. | protocol |
| `graph` | Extension. `spawn_session`, `list_sessions`, `/children`. Needs a host to spawn. | protocol |
| `pane` | Extension. The tree as a left pane inside Pi; `/lattice`; opens a session here by taking it over from the host. | protocol |
| `canopy` | Extension. All the work as a tree that grows upward, full screen: who owns what, which agent is on it. Asks the pane for what to draw over the event bus. | protocol |
| `host` | Library. Store, supervisor, broker, socket API, foreground handover. | protocol |
| `collab` | Library. Networks, identities, finding teammates, an encrypted peer channel, signed ownership logs, cross-owner mail, handoff. | protocol |
| `server` | Library and program. One always-on place for a team's work: issues structured by a scheme the team defines, over HTTP, in one SQLite file; and the client a host uses. ([ADR 0026](decisions/0026-a-server-for-the-work.md)) | protocol |
| `app` | The composition root. The Pi package manifest, the launcher extension, the background host wired to sharing, the command line. | all of the above |

## Seams

The full account is in [ADR 0014](decisions/0014-package-seams.md). In short:

- A package imports only `protocol` from this repository. `app` imports everything, and nothing imports `app`.
- Extensions talk through typed events on `pi.events`, defined in `protocol`. They never read each other's state and never write to the environment for each other.
- A session learns it is a node through a **host assignment**: from the environment when the host started it, or from the `lattice:host:assigned` event when a person opens the node in their own Pi. Extensions accept it at any time, so load order does not matter.
- A package that needs something from another defines an interface and is handed an implementation: `HostPort` (collab), `SharingPort` and `WorkPort` (host), `Transport` (a2a), `PeerTransport` and `Discovery` (collab).
- The pane does not start hosts. It asks on the event bus; the app's launcher answers.
- An extension goes quiet when its session ends, because the event bus outlives a session switch.
- `protocol` holds no state ([0001](decisions/0001-packaging-and-scope.md)). Extensions start nothing in their factory.
- Kinds, intents and fragment names are free-form strings everywhere. No enums of agent types.

`test/architecture.test.ts` fails the build if a package imports something it should not.

## Identity

A **node** is a place in the tree. A **Pi session** is the conversation currently occupying it. They have separate ids, and addresses use the node id ([0004](decisions/0004-node-identity.md)).

Node record: `id`, `parentId`, `rootId`, `kind`, `brief`, `fragments`, `owner`, `version`, `status`, `sessionId`, `sessionFile`, `cwd`, `workspace`, `branch`, `waitsOn` until it starts, and `planned` while it is work nobody has been put on ([0023](decisions/0023-planned-work.md)).

Status is one of `dormant`, `starting`, `idle`, `running`, `blocked`, `exited`, `failed`. `blocked` means a dialog is waiting for a human ([0005](decisions/0005-host-control-plane.md)).

## Messaging

Envelope fields ([specification](envelope-spec.md)): `v`, `id`, `from`, `fromOwner`, `to`, `intent`, `correlationId`, `causationId`, `seq`, `hops`, `payload`, `createdAt`, optional `sig`.

Delivery is at-least-once with dedupe by id, ordered per sender-recipient pair. Recipients are node ids or tree-relative (`parent`, `children`, `root`). Inbound mail runs through one state machine with one approval policy. Loop and spawn limits are enforced in code. Details in [0009](decisions/0009-messaging-semantics.md).

Injection into the model uses `pi.sendMessage` with `deliverAs: "followUp"` and `triggerTurn: true`, so an idle agent wakes and a busy one finishes its current work first.

## Roles

A role is a list of fragment names. A fragment is a markdown file with frontmatter: `name`, `summary`, optional `requires`, `conflicts` and `suggests` (all advisory, shown to the human, never enforced).

Fragments are looked up in order: project `.pi/lattice/roles/`, user `~/.pi/agent/lattice/roles/`, then the package's built-in set. Earlier locations override later ones by name. Adding a fragment is dropping a file.

Details in [roles.md](roles.md). Each applied fragment becomes one system prompt section ([0003](decisions/0003-roles-as-prompt-sections.md)). The list is persisted with `appendEntry` and edited with `/role add|remove|show`.

## Host

- **Store**: SQLite through `node:sqlite` behind a `Store` interface ([0008](decisions/0008-host-store.md)).
- **Supervisor**: one Pi child per running node, lazy resume, concurrency cap, explicit handling of exit and failure ([0005](decisions/0005-host-control-plane.md)).
- **Order**: a child spawned to wait on other sessions is created at once and given its brief when each of them has sent its result ([0021](decisions/0021-waiting-on-other-sessions.md)).
- **Broker**: routes and journals every envelope.
- **Workspaces**: shared directory or a git worktree per node ([0010](decisions/0010-workspace-policy.md)).
- **Foreground handover**: a session opened in a terminal is taken over from the host and handed back on leaving. Its messaging goes through the same broker either way.
- **No UI of its own**: the pane in the developer's Pi shows the tree and drives the host ([0013](decisions/0013-pane-inside-pi.md)).

## Collaboration

Each person runs their own host, and the hosts connect directly, peer to peer, to share sessions ([ADR 0012](decisions/0012-peer-to-peer-collab.md)); [leases.md](leases.md) describes the behaviour. The team's work is different: it lives on one server every host talks to ([ADR 0026](decisions/0026-a-server-for-the-work.md)), which may be a board a person's own host starts on their machine ([ADR 0027](decisions/0027-what-kanzo-changed.md)), and sharing sessions is planned to move there too ([the plan](design/server-plan.md)).

A **network** is a name and a secret, kept in one file in the person's lattice home and followed by the host of every repository they have open ([ADR 0018](decisions/0018-networks.md)). Whoever holds the secret is a member, and proves it on every connection; the first key seen under a name is pinned. A person goes by a name they choose once, when they first create or join ([ADR 0020](decisions/0020-one-line-to-join.md)). Hosts find each other by a port derived from the network and the repository, by beacons on the local network, and by telling each other who they know. Hosts for the same repository share its tree and hand sessions over; hosts for different repositories connect only to look ([ADR 0019](decisions/0019-everything-everyone-is-running.md)).

A teammate's nodes are fetched from them while they are online and shown as last seen, greyed out, when they are not. That includes what they have running in repositories this person has no tree for: each host writes what it has running to the person's lattice home, so any one of their hosts answers for all. A teammate's conversation is fetched on demand, read-only. One thing is sent as it happens: a session someone is looking at, message by message, for as long as they look.

Every node has an owner and a version. Ownership changes in two steps from either side: the owner offers and the other person accepts, or a teammate asks and the owner approves. The owner's host then releases the node by itself; only that release moves ownership and increments the version. Offers and requests expire, either side can take theirs back before the release, and every step is idempotent.

Ownership is a log of signed events replayed through the lease state machine, not a field. Only the current owner appends to a node's log; a peer accepts a log only when its signatures verify and it extends the one already held.

Mail from another owner's agents is delivered directly, checked against the ownership logs, and then waits in the recipient's inbox for the human, per message by default.

Session transfer is fork-on-receipt ([ADR 0007](decisions/0007-session-transfer.md)).

## Security

- Extensions run with the user's full OS permissions. Only trusted code is loaded.
- Remote-originated content is never executed and never treated as instructions. Every inbound envelope is validated against the schema and delivered as delimited, attributed data.
- The host socket is private to the user and children authenticate with a per-child token.
- Hosts connect only to members of the person's network, over an encrypted channel. Ownership events are signed, and a teammate's key is pinned when first seen. The join code is the one secret: whoever has it can read the network's sessions.
- Limits on hops, send rate and spawning are enforced by code.

## Build phases

Each phase ends with something usable and a stop for review.

| Phase | Scope | Done when |
|---|---|---|
| 0 | Verification spikes, decisions, repo scaffold | **Done.** `npm run spike:phase0` passes 18 checks. |
| 1 | `protocol` (envelope, events, inbound and lease machines, tests) and `a2a` with the file transport | **Done.** Two local Pi sessions exchange messages and the model sees them. |
| 2 | `roles` | **Done.** `coordinator + planning` can be composed on a session and changed mid-session. |
| 3 | `host` (store, supervisor, broker, socket) and `graph` | **Done.** A coordinator spawns a child and both appear in the tree. |
| 4 | Tree UI: view, attach, spawn, approvals, blocked dialogs | **Done, then redone inside Pi.** A pane in Pi lists the tree; any node can be opened and typed into with Pi's full interface. |
| 5 | Lifecycle fragments, then a full feature run | **Done against a scripted model.** A feature goes through grilling, planning, implementation and verification. A run with a real model is still to do. |
| 6 | `collab`: transport decision, handoff, cross-owner approvals, session transfer | **Done on one machine, peer to peer.** Two isolated hosts connect directly, share a tree, and a node changes owner with both confirming. A run across two real machines is still to do ([script](two-machine-handoff.md)). |
| 7 | Networks: one join code, hosts that find each other, handoff in two steps from either side | **Done on one machine.** Two background hosts with separate homes create and join a network, see each other's sessions, and move one by request and by offer. Two real machines and a VPN are still to do. |
| 8 | Everyone's sessions in every repository, watched while looked at, taken with a clone | **Done on one machine.** A real Pi creates a network from its prompts, reads a teammate's session in a repository it does not have, and takes it by cloning. Two real machines, a VPN and a remote that needs credentials are still to do. |

## Testing

- Unit tests for `protocol`: validation, inbound machine, lease machine including stale version and crash mid-handoff.
- Integration tests spawn real Pi processes against the scripted provider ([0002](decisions/0002-testing-with-faux-provider.md)).
- A [manual script](two-machine-handoff.md) for the two-machine handoff.
