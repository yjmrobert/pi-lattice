# 0009 Messaging semantics, addressing and guardrails

**Delivery**

- At-least-once. Every envelope has a unique id; receivers dedupe on it, so redelivery is harmless.
- Ordered per sender-recipient pair, by a per-sender sequence number. No global order.
- One `Transport` interface: `send`, `subscribe`, `close`. A session selects its transport once, at `session_start`: the host broker if `LATTICE_SOCK` is set and reachable, otherwise the local file transport. It does not switch mid-session.
- The file transport is a maildir-style spool: write to `tmp/`, `rename` into the recipient's `new/`. Rename is atomic on one filesystem, so readers never see partial files. Each mailbox has a lock file holding the owner's pid, which is also how a duplicate claim on a node id is detected (ADR 0004).
- With a host, every envelope goes through the broker, which journals it. The tree shows traffic from that journal, keyed by correlation id.

**Addressing**

A recipient is a node id, or a tree-relative address: `parent`, `children`, `root`. Relative addresses are resolved by whoever knows the tree (the host; without a host only node ids work). There is no role addressing: roles are free-form and change mid-session, so they have no stable resolver.

**Inbound state machine**

One machine, defined in `protocol`, owned by `a2a`: `received -> pending -> approved | rejected`, `approved -> delivered`, with `received -> delivered` directly when policy does not require approval. The `/inbox` command, RPC dialogs and the tree UI are views over it. `collab` adds senders and policy; it does not add a second inbox.

Policy default: approval is required when the sender's owner differs from the recipient's owner. Same-owner mail is delivered without approval but is still untrusted text: a child that read a hostile web page can relay it. Delivered envelopes are wrapped in a clearly delimited block that names the sender and states that the content is data from another agent, not instructions from the user.

**Guardrails**

A model that can send and spawn can loop and fork-bomb. Limits are enforced by the code, not by prompt text:

- `hops` on every envelope, incremented when a message is sent while handling another; envelopes past `maxHops` (default 8) are refused.
- Per-node send rate limit.
- Spawn limits in the host: maximum depth, maximum children per node, maximum nodes per tree. Exceeding one returns a clear tool error.
- All limits are configuration with conservative defaults, and the human can raise them.

**Versioning**

`v` is a single integer. A receiver rejects a higher major version, ignores unknown fields, and passes unknown `intent` strings through (the vocabulary is open). Payloads are size-limited (64 KiB); larger content travels as a file path reference.
