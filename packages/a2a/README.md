# @pi-lattice/a2a

Agent-to-agent messaging between Pi sessions. Works on its own: two sessions on one machine can talk with no host process.

```bash
pi install ./packages/a2a        # or: pi -e ./packages/a2a
```

## What it adds

| For | Name | Does |
|---|---|---|
| Model | `send_message` | Send text to another session by node id, optionally as a reply |
| Model | `list_peers` | List sessions it can message |
| Human | `/inbox` | Review messages waiting for approval; `/inbox approve\|reject <id\|all>`, `/inbox trust\|untrust <node>` |
| Human | `/peers` | List reachable sessions |
| Human | `/lattice` | Show this session's node id, owner, transport and mail counts |

Inbound messages reach the model as a delimited `<lattice-message>` block that names the sender and states that the content is peer data, not user instructions. An idle session wakes to handle it; a busy one sees it after its current work.

## Approval

`--lattice-approval` (or `LATTICE_APPROVAL`) sets which inbound messages a human must approve before the model sees them:

- `cross-owner` (default): messages whose sender has a different owner. Trusted senders skip it.
- `always`: every message.
- `never`: none.

The owner is `LATTICE_OWNER`, else the OS user name. It is a claim, not proof, until collab signatures exist.

## Limits

Enforced in code, overridable by environment variable:

| Variable | Default | Effect |
|---|---|---|
| `LATTICE_MAX_HOPS` | 8 | Refuses a send once an exchange has bounced between agents this many times without human input |
| `LATTICE_MAX_SENDS_PER_MINUTE` | 30 | Per-session send rate |
| `LATTICE_MAX_PAYLOAD_BYTES` | 65536 | Largest message body |

## State

Mail belongs to the node, not the Pi session, so it survives `/new`, `/fork`, resume and crashes. It lives under `LATTICE_HOME` (default `~/.pi/agent/lattice`):

```
nodes/<node id>/node.json     registration
nodes/<node id>/lock          pid of the process speaking as this node
nodes/<node id>/inbox/        transport spool (tmp, new, failed)
nodes/<node id>/mail/         pending, approved, delivered, rejected, sent
```

Sessions that share a `LATTICE_HOME` can message each other. A message to a node that is not running waits and is delivered when it starts again.
