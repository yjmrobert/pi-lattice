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
| 0006 | Attach renders RPC events with Pi's own components | superseded by 0013 |
| 0007 | Session transfer is fork-on-receipt | accepted |
| 0008 | Host store is SQLite via `node:sqlite` | accepted |
| 0009 | Messaging semantics, addressing and guardrails | accepted |
| 0010 | Workspace policy per node | accepted |
| 0011 | Collab transport: a shared git repository, with signed records | superseded by 0012 |
| 0012 | Collab is peer to peer, with no server and no shared storage | accepted; pairing and the three-step handoff changed by 0018 |
| 0013 | The tree lives inside Pi, as a pane | accepted |
| 0014 | Package seams | accepted |
| 0015 | The pane: a rail, an inbox, an inspector, and every repository | accepted |
| 0016 | Working in the pane: tidying, stopping, settings, and no setup step | accepted |
| 0017 | Settings on one screen, and sessions that are told how to talk to each other | accepted |
| 0018 | A network you join once, and a session that moves in two steps | accepted |
