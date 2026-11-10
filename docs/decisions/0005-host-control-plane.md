# 0005 Host control plane: own JSONL client plus extension socket

**Decision**

The host talks to each child over two channels.

1. **RPC over stdio**, for what Pi already models: prompts, steering, abort, state, messages, and the session event stream used for attach. The host uses a thin JSONL client of its own instead of the exported `RpcClient`.
2. **A local unix socket**, opened by the lattice extensions in `session_start`, for what Pi does not model: envelopes, spawn requests, node metadata, approvals.

The socket lives in a directory with mode 0700 and is itself 0600. Each child receives a random token in its environment and presents it in its first frame; the host drops connections without a valid token.

**Why not `RpcClient`**

It delivers `extension_ui_request` records to listeners but has no public method to send the `extension_ui_response`. The spike had to write to its private `process.stdin`. The protocol is small (LF-framed JSON, id correlation), and owning the client also lets the host handle child exit and backpressure deliberately.

**Blocked children are a first-class state**

Any extension's `ctx.ui.select/confirm/input/editor` blocks the child until the client answers. The host records every unanswered dialog on the node, marks the node `blocked`, and the tree shows it. Nothing is auto-answered.

**Evidence (spike S5, S6)**

An extension connected to a unix socket in `session_start`; a command sent over it called `pi.sendMessage(..., { triggerTurn: true })` and woke an idle session; `ctx.ui.confirm` surfaced as `extension_ui_request`, stayed blocked, and resolved once answered.

**Supervision**

Children are stdio subprocesses, so they exit when the host does (stdin EOF is an orderly shutdown). The tree therefore persists node records, not processes. Nodes are `dormant` until needed, and the host resumes one with `--session <file>` on attach or on inbound mail. A cap limits concurrently running children (default 8; each idle child is about 120 MB resident).

**Phase 3 notes**

- Each lattice extension opens its own connection (a channel: `a2a`, `graph`). The frames are in `protocol/src/wire.ts`.
- The host rejects an envelope whose `from` or `fromOwner` does not match the authenticated connection, so a session cannot send as another node.
- Envelopes stay queued in the journal until the recipient acknowledges having stored them. Mail for a dormant node starts it; if the running cap prevents that, the host retries whenever a session settles or exits.
- A command that opens a dialog does not return its RPC response until the dialog is answered. Callers must not await such a prompt before answering.
