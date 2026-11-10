# 0004 Node identity is separate from Pi session identity

**Decision**

Every participant has a lattice **node id** (a ULID-style string minted by whoever creates the node). Envelopes are addressed to node ids, never to Pi session ids.

- The node id reaches the session through the `LATTICE_NODE_ID` environment variable when the host spawns it, and is recorded in the session with `appendEntry` on first start.
- Without a host, the a2a extension mints a node id on first `session_start` and records it the same way.
- On `session_start` with reason `resume` or `reload`, the recorded id wins.
- On reason `new` or `fork`, the Pi process is still the same worker in the tree, so the process keeps its node id and the node's `sessionId` field is updated. A session file copied by fork or clone and later opened by an unrelated Pi process carries a recorded id that another live process may own; the mailbox lock (ADR 0009) detects that and the newcomer mints a fresh id.

**Why**

`/new`, `/fork`, `/resume` and tree navigation replace the session inside one process. An address tied to the session id would silently break on any of them, and fork or clone would create two sessions claiming one address.

**Evidence (spike S8)**

`--session-id` assigns the Pi session id, so the host can still choose it. `new_session` fired `session_shutdown(new)` then `session_start(new)` with a different session id in the same process.

**Phase 1 finding**

Pi builds a fresh extension instance when a session is replaced, so an id kept in the factory closure is lost on `/new`. The a2a extension reads the id recorded in the session being left (`event.previousSessionFile`) and falls back to a process-wide value for ephemeral sessions. An integration test covers `/new`, resume by session file, and a second process opening a copy of a live session.
