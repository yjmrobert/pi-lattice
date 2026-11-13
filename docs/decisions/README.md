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
| 0012 | Collab is peer to peer, with no server and no shared storage | accepted for the connection, the ownership logs and the transfer; pairing and the three-step handoff changed by 0018, and "no server" by 0028 |
| 0013 | The tree lives inside Pi, as a pane | accepted |
| 0014 | Package seams | accepted |
| 0015 | The pane: a rail, an inbox, an inspector, and every repository | accepted |
| 0016 | Working in the pane: tidying, stopping, settings, and no setup step | accepted |
| 0017 | Settings on one screen, and sessions that are told how to talk to each other | accepted |
| 0018 | A network you join once, and a session that moves in two steps | the two-step handoff stands; networks and join codes removed by 0029 |
| 0019 | Everyone's sessions in every repository, watched while looked at, and taken with a clone | accepted; how hosts find each other replaced by 0028 and 0029 |
| 0020 | One line to join, and a name you choose | the name stands; the join code removed by 0029 |
| 0021 | A session that waits on others | accepted |
| 0022 | The canopy: what Pi lets an extension do | found out; 0024 is built on it |
| 0023 | Planned work, and what a session is working on | accepted |
| 0024 | The canopy | first part built |
| 0025 | One published package, built | built; the publish itself not yet done |
| 0026 | A server for the team's work | built: issues, the scheme, sessions on issues, the canopy, working on issues from it |
| 0027 | What Kanzo changed | built: a board on your own machine and sharing it, `work_next`, waiting, issues for people, review before done |
| 0028 | The server introduces; the machines carry | built: on a server, hosts find each other and pass offers and requests through it; sessions go directly between the two machines, both online |
| 0029 | Networks joined by a code are gone | built: sessions are shared with the people on your server; join codes, beacons and the shared ports are removed |
| 0030 | The canopy in order | built: what must come first is on the left; held work is dim; `o` puts it back as filed |
