# pi-lattice architecture

This is the working design. It supersedes the original handoff plan where they differ; every difference is backed by a record in [decisions/](decisions/README.md).

## Goal

An additive set of Pi extensions plus a host process that provide:

1. Agent-to-agent messaging between Pi sessions.
2. A session tree the human can enter at any node. Nothing is forced to bubble up.
3. Composable roles the human assigns to a session, instead of fixed agent profiles.
4. Lifecycle coordination: grilling, planning, implementation, verification.
5. Trees shared between two people, with explicit ownership, handoff, and approval of anything inbound from the other person's agents.

Non-goals: token optimisation, a library of agent personas, running agents on someone else's machine without their approval.

## Shape

Two kinds of thing, kept separate.

**Extensions** run inside each Pi session. Each is optional and useful alone. They share types through `@pi-lattice/protocol` and find each other at runtime through `pi.events`. No extension imports another.

**The host** is a separate Node process. It owns the tree, spawns and supervises sessions, brokers messages, and renders the tree UI. Sessions are workers.

```
            human
              |
        +-----------+        stdio RPC (prompts, events, dialogs)
        |   host    |<------------------------------------+
        | tree store|        unix socket (envelopes,      |
        | broker    |<----------- spawn, metadata) ---+   |
        | tree UI   |                                 |   |
        +-----------+                           +-----------------+
                                                | pi (RPC mode)   |
   no host: sessions exchange envelopes         |  a2a  graph     |
   through a maildir spool on disk              |  roles collab   |
                                                +-----------------+
```

## Packages

| Package | What it is | Depends on |
|---|---|---|
| `protocol` | Envelope schema and validators, `pi.events` names and payload types, inbound and lease state machines as pure functions, version constant. No Pi dependency. | typebox |
| `a2a` | Extension. `send_message` tool, `/inbox`, inbound state machine, `Transport` interface, file transport, host transport. | protocol |
| `roles` | Extension plus markdown fragments. `/role`, `apply_role`, prompt-section injection. | protocol |
| `graph` | Extension. Node metadata, `spawn_session`, `list_sessions`, `/children`. Needs a host to spawn. | protocol |
| `host` | Node app. Store, supervisor, broker, socket API, tree UI. | protocol |
| `collab` | Library the host loads. Identities, signed ownership logs, a shared git store, cross-owner mail, handoff and session transfer. | protocol |

Rules:

- The contract between extensions is the set of typed events in `protocol`. Each extension announces itself with a hello event carrying its protocol version, so a mismatch is reported instead of failing silently.
- `protocol` holds no state ([0001](decisions/0001-packaging-and-scope.md)).
- Extensions start nothing in their factory. Sockets, watchers and timers start in `session_start` and stop in an idempotent `session_shutdown`.
- Kinds, intents and fragment names are free-form strings everywhere. No enums of agent types.

## Identity

A **node** is a place in the tree. A **Pi session** is the conversation currently occupying it. They have separate ids, and addresses use the node id ([0004](decisions/0004-node-identity.md)).

Node record: `id`, `parentId`, `rootId`, `kind`, `brief`, `fragments`, `owner`, `version`, `status`, `sessionId`, `sessionFile`, `cwd`, `workspace`, `branch`.

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
- **Broker**: routes and journals every envelope.
- **Workspaces**: shared directory or a git worktree per node ([0010](decisions/0010-workspace-policy.md)).
- **UI**: terminal only. Tree with status and owner badges, attach, spawn with fragment picker, pending approvals, blocked dialogs ([0006](decisions/0006-attach-model.md)).

## Collaboration

Each person runs their own host. The hosts agree through a private git repository ([ADR 0011](decisions/0011-collab-transport.md)); [leases.md](leases.md) describes the behaviour.

Every node has an owner and a version. Ownership changes only by a three-step handoff: the owner offers to a named person, that person accepts, the owner confirms the release. Only the last step moves ownership and increments the version, in the same commit that ships the session and branch. Offers expire, either side can cancel before the release, and every step is idempotent, so a crash mid-handoff is recovered by repeating the last step.

Ownership is a log of signed events replayed through the lease state machine, not a field. Stale-version events, events not signed by the person they name, and events from people whose key the human has not trusted are ignored. The previous owner keeps the node in their tree, marked with the new owner, and cannot run it.

Mail from another owner's agents is signed, verified on arrival, and then waits in the recipient's inbox for the human, per message by default.

Session transfer is fork-on-receipt ([ADR 0007](decisions/0007-session-transfer.md)).

## Security

- Extensions run with the user's full OS permissions. Only trusted code is loaded.
- Remote-originated content is never executed and never treated as instructions. Every inbound envelope is validated against the schema and delivered as delimited, attributed data.
- The host socket is private to the user and children authenticate with a per-child token.
- Shared state is signed. A collaborator's key is trusted only by a deliberate human act, and pinned.
- Limits on hops, send rate and spawning are enforced by code.

## Build phases

Each phase ends with something usable and a stop for review.

| Phase | Scope | Done when |
|---|---|---|
| 0 | Verification spikes, decisions, repo scaffold | **Done.** `npm run spike:phase0` passes 18 checks. |
| 1 | `protocol` (envelope, events, inbound and lease machines, tests) and `a2a` with the file transport | **Done.** Two local Pi sessions exchange messages and the model sees them. |
| 2 | `roles` | **Done.** `coordinator + planning` can be composed on a session and changed mid-session. |
| 3 | `host` (store, supervisor, broker, socket) and `graph` | **Done.** A coordinator spawns a child and both appear in the tree. |
| 4 | Tree UI: view, attach, spawn with fragment picker, approvals, blocked dialogs | **Done.** Feature, grilling and task nodes can be navigated and typed into. |
| 5 | Lifecycle fragments, then a full feature run | **Done against a scripted model.** A feature goes through grilling, planning, implementation and verification. A run with a real model is still to do. |
| 6 | `collab`: transport decision, handoff, cross-owner approvals, session transfer | **Done on one machine.** Two isolated hosts share a tree and a node changes owner with both confirming. A run across two real machines is still to do ([script](two-machine-handoff.md)). |

## Testing

- Unit tests for `protocol`: validation, inbound machine, lease machine including stale version and crash mid-handoff.
- Integration tests spawn real Pi processes against the scripted provider ([0002](decisions/0002-testing-with-faux-provider.md)).
- A [manual script](two-machine-handoff.md) for the two-machine handoff.
