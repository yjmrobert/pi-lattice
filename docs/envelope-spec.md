# Envelope specification, version 1

The envelope is the one message shape every transport, session and host agree on. The schema and validator live in `packages/protocol/src/envelope.ts`; this page is the prose contract.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | integer | yes | Protocol version. Currently 1. |
| `id` | id | yes | Unique, time-sortable envelope id (`env_...`). Receivers dedupe on it. |
| `from` | node id | yes | Sender node. |
| `fromOwner` | string | yes | Owner of the sender, as claimed by the sender. |
| `fromName` | string | no | Display name of the sender. |
| `to` | address | yes | A node id, or `parent`, `children`, `root`. |
| `intent` | string | yes | What kind of message this is. Open vocabulary; well-known values are `ask`, `inform`, `result`, `request-approval`, `handoff`. |
| `correlationId` | id | yes | Groups a conversation. The id of its first envelope. |
| `causationId` | id | no | The envelope this one responds to or was caused by. |
| `seq` | integer ≥ 1 | yes | Per sender-recipient sequence number. |
| `hops` | integer ≥ 0 | yes | Agent-to-agent steps since a human last spoke. |
| `payload.text` | string | yes | The body. |
| `payload.data` | any | no | Structured data. Untrusted. |
| `payload.refs` | string[] | no | File paths for content too large to inline. |
| `createdAt` | ISO 8601 | yes | Creation time. |
| `sig` | string | no | Signature. Reserved for cross-owner mail. |

Ids match `^[a-z]{2,8}_[0-9a-z]{8,40}$`. They are used as file names, so a receiver must reject anything else.

## Rules

- **Compatibility.** A receiver rejects `v` greater than the version it implements, ignores fields it does not know, and accepts any non-empty `intent`.
- **Delivery.** At-least-once. Ordered per sender-recipient pair by `seq`. No global order.
- **Hops.** A send made while handling an inbound envelope carries that envelope's `hops + 1`. A human prompt resets the chain to 0. Envelopes above the limit (default 8) are refused by the sender and rejected by receivers.
- **Size.** The serialized payload is at most 64 KiB by default.
- **Trust.** Everything in an envelope is untrusted input. It is validated before use, delivered to a model only as delimited, attributed text, and never executed.
