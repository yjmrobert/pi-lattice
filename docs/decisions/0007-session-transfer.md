# 0007 Session transfer is fork-on-receipt

**Decision**

Moving a node to another machine ships the session JSONL plus node metadata. The receiver adopts it with `pi --fork <file>` in a working directory of the receiver's choosing. The node id is preserved (ADR 0004); the Pi session id changes.

**Why**

A session records its working directory permanently. Opening it where that directory does not exist fails in non-interactive modes.

**Evidence (spike S9)**

Resuming a session whose directory had been deleted exited with "Stored session working directory does not exist". `--fork` on the same file started a new session in the local directory with the earlier history intact.

**Consequences**

- The working tree is not part of a session. Handoff of implementation work also needs the code to travel (a branch name in the node metadata; the receiver checks it out). The handoff offer carries that reference.
- Session files can contain file contents, command output and secrets. The handoff UI must say so before sending.
- Whether `appendEntry` custom entries survive `--fork` is not yet checked; lattice state that must survive (node id, roles) is verified in Phase 1 and Phase 2 tests.
