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
| 0026 | A server for the team's work | built: issues, the scheme, sessions on issues, the canopy; working on issues from it by key replaced by 0033 |
| 0027 | What Kanzo changed | built: a board on your own machine and sharing it, `work_next`, waiting, issues for people, review before done; the order issues are taken in and who reviews changed by 0033 |
| 0028 | The server introduces; the machines carry | built: on a server, hosts find each other and pass offers and requests through it; sessions go directly between the two machines, both online |
| 0029 | Networks joined by a code are gone | built: sessions are shared with the people on your server; join codes, beacons and the shared ports are removed |
| 0030 | The canopy in order | built: what must come first is on the left; held work is dim; `O` puts it back as filed |
| 0031 | Pi opens on the canopy | built: the tree where the chat was, a session's chat sliding in beside it, `alt+l` between them, what a session waits on answered on the tree; `pane.home` puts it back |
| 0032 | A session opens over the tree | built: the tree is the whole screen, a session's chat opens in a box over it that says whose it is and what it is doing, and folding an item moves |
| 0033 | Agents keep the issues; people steer, on the tree | built: agents file, order, check and close the work; a person says what they want on any item with `space`, to whatever tends it; what they say can stand as a direction on the branch; every change by an agent says why; and `pi-lattice work` for agents that are not Pi sessions |
| 0034 | A server encrypts by itself, and its address says which server it is | built: a certificate the server makes itself, its fingerprint in the address after the code, TLS and loopback HTTP on one port |
| 0035 | The first message is written on the canopy | built: where a first message would start a tree, Pi opens on an empty canopy that says so and takes that message, typed or pasted |
| 0036 | A board is tended | built: with a board, the root of a tree is its coordinator unless `roles.root` says otherwise, results that waited are handed on, and a result nobody can check is said |
| 0037 | A push to main releases | built, and not yet run: the version is worked out from the conventional commits since the last release tag, published, tagged, and written up as a GitHub release; nothing is committed back |
| 0038 | Roles are composed in steps | built: a fragment may hold a slot, be kept, be made of parts, apply only where facts hold, mention them, and add to the one beneath it; each is one line of its header and one pure function |
| 0039 | What agents are told is measured, and each rule has one place | built, and run on two models: tools, templates and roles each own one kind of rule; a change is checked as text, with real models in scenarios, and in counts from use |
| 0040 | A type of issue names the roles for a session put on it | built: the scheme's types may carry roles, used when none were chosen; the default names them for a task and a bug |
| 0041 | The canopy is the same in every directory | built: every repository's work is drawn wherever Pi is opened; a sleeping repository and one with nothing in it yet are one item each; a board is drawn as soon as it is joined |
| 0042 | The canopy is held to being read, in any terminal | built: palettes for dark and light, a mark on what is selected, characters as wide as they are, a tree that draws in to fit, arrows that follow it, and keys that agree; each held by a test |
| 0043 | A tree too large for its window folds around your work | built: a folded item is one line that says what is in it; a tree too wide folds what is finished, then what is not yours, then what is not where you are; what a person folds or opens stays; a teammate's number opens the tree around their work |
