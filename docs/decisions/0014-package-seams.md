# 0014 Package seams

**Decision**

Every package is useful on its own, knows only the shared contracts, and is assembled with the others in exactly one place.

```
                      protocol          contracts only: no I/O, no Pi
        /     /      /    |    \      \
     a2a   roles  graph  pane  host  collab     each depends on protocol and nothing else of ours
        \     \      \    |    /      /
                        app             the composition root: the only package that knows them all
```

**The contracts, all in `protocol`**

| Seam | Between | What it is |
|---|---|---|
| Typed events (`LatticeEvents`) | Extensions in one Pi process | The only way extensions talk to each other |
| Host assignment (`HostAssignment`) | Whoever opens a node, and the session extensions | What lets a session speak as a node |
| Wire frames and `UiApi` | Any session or pane, and a host | The socket protocol |
| Envelope | Every transport, session and host | The one message shape |
| Lease state machine | Host and collab | The rules of ownership |

Interfaces a package defines for others to satisfy, so it never imports them:

| Interface | Defined in | Satisfied by |
|---|---|---|
| `Transport` | a2a | its file and host transports |
| `HostPort` | collab | the host, structurally |
| `SharingPort` | host | the app's wiring of collab |
| `PeerTransport` | collab | TCP today; hole-punching later |
| `Store` | host | SQLite |

**Rules**

1. A package imports only `protocol` from this repository. The app is the exception: it imports everything, and nothing imports it.
2. Imports go through a package's public entry point, never to a file inside it.
3. `protocol` has no I/O and does not depend on Pi. `collab` does not depend on Pi either.
4. Extensions communicate through typed events, never through process state. An extension must not write to the environment for another to read.
5. An extension accepts a host assignment whenever it arrives, before or after its own start. Nothing depends on load order.
6. An extension goes quiet when its session ends. Pi's event bus outlives a session switch, so handlers from the previous session's instances still fire; they must check and do nothing.
7. Each package declares exactly the lattice packages it imports.

`test/architecture.test.ts` enforces rules 1, 2, 3, 4 and 7 on every run. `test/integration/pane.test.ts` covers rule 5 by loading the extensions in reverse order, and rule 6 by switching sessions under load.

**What each package does alone**

| Package | Alone |
|---|---|
| `a2a` | Two Pi sessions on one machine message each other through a file spool, with approval. |
| `roles` | Compose and change a session's role from markdown fragments. |
| `graph` | Loads, and says clearly that there is no host to spawn into. |
| `pane` | Shows the tree of any host already running; without something to start one, says what is missing. |
| `host` | A library: build a tree, run sessions headless, broker their mail. |
| `collab` | A library: pairing, the encrypted channel, signed ownership logs, against any object that satisfies `HostPort`. |
| `app` | Everything assembled: the Pi package, the launcher, the background host with sharing, the command line. |

**What changed to get here**

Four seams were wrong before this decision, and each caused a real problem:

- *The pane told other extensions who they were by rewriting `process.env`.* It only worked if the pane loaded first, and needed a session reload to take effect. Now the pane emits `lattice:host:assigned`, and messaging, roles and the tree tools rebind when they hear it. The reload is gone and the order does not matter.
- *The host package was also the application.* It held the background process and command line, so it depended on collab and on the three session extensions. Those moved to `app`. The host now depends on `protocol` alone and is told which extensions to load.
- *The pane depended on the host package* to find a program to start. Now it asks on the event bus (`lattice:host:launch`), and the app's launcher extension answers. The pane works with a host started any other way, and says so plainly when nothing can start one.
- *Nothing enforced any of this.* The architecture test now does.

Making the seams explicit also surfaced two defects that the old arrangement hid: handlers from a finished session firing on the shared event bus, and the pane using a session context after its session had ended. Both crashed Pi intermittently under a session switch; both are fixed and covered.

**Costs**

- Rebinding makes the messaging extension slightly more complex than choosing a transport once: it can let go of one identity and take up another mid-session.
- Three small pieces of state are process-wide instead of per extension instance, because Pi builds new instances on every session switch: the pane's connection and view, and the node id the messaging extension holds across `/new`. Each is documented where it is declared.
