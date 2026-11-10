# 0008 Host store is SQLite via `node:sqlite`

**Decision**

The host keeps nodes, the envelope journal, approvals and leases in one SQLite file using Node's built-in `node:sqlite`. Minimum Node is 22.19 (24 recommended).

**Why**

Version-checked updates (`UPDATE ... WHERE version = ?`) and multi-row transactions are exactly what the lease state machine and the broker need, and the built-in module avoids a native dependency. Atomic JSON files would need hand-rolled transactions across files.

All access goes through one `Store` interface so the engine can change. Schema changes are numbered migrations applied at startup.
