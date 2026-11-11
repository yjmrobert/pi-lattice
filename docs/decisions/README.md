# Decisions

Short ADRs. Each records one decision, the evidence for it, and what it rules out.
Evidence marked "spike" is reproducible with `npm run spike:phase0` (Pi 1.5.2, scripted model, no tokens).

| # | Decision | Status |
|---|---|---|
| 0001 | Packaging, npm scope and shared code | accepted |
| 0002 | Deterministic testing with Pi's faux provider | accepted |
| 0003 | Roles are injected as system prompt sections | accepted |
| 0004 | Node identity is separate from Pi session identity | accepted |
| 0005 | Host control plane: own JSONL client plus extension socket | accepted |
| 0006 | Attach renders RPC events with Pi's own components | accepted, verified in Phase 4 |
| 0007 | Session transfer is fork-on-receipt | accepted |
| 0008 | Host store is SQLite via `node:sqlite` | accepted |
| 0009 | Messaging semantics, addressing and guardrails | accepted |
| 0010 | Workspace policy per node | accepted |
| 0011 | Collab transport | open, decide at start of Phase 6 |
