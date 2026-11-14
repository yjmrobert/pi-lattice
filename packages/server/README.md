# @pi-lattice/server

One always-on place for a team's work: issues, structured by a scheme the team defines, over HTTP, in one SQLite file. It is the only writer, so there is one copy and one order of events, and nothing to merge when a laptop comes back.

It is a library and a program (`pi-lattice server`, or the board a host starts on a person's own machine), not a Pi extension. A host connects to it with the client in this package.

What it holds:

- **Issues.** A number, a title, a body, a type, a state, a parent, an assignee, labels, the team's own fields, the issues it waits on, whether it is for a person, the repository it is for, comments, and a history of every change with who made it.
- **Order.** An issue has a rank among the issues under its parent. `next` hands out the first ready issue in the order the tree is read, so order is how priority is said.
- **Results.** What was done on an issue, how it was checked and where to look, as whoever did it reported it.
- **What people said.** A line a person said about an issue is kept in their words. One that is kept as a direction stands on the issue and reaches everything under it.
- **Why.** Every change records the person whose token it came with, the session or agent that made it, and the reason it gave. Each person has a revision they last looked at; what an agent changed after it is new to them.
- **Leases.** An agent with no host holds an issue it took for thirty minutes after its last word on it; then the issue is given back.
- **The scheme.** Which types there are and which may sit under which, what the states are and what each means, what fields there are, and what a session does to the issue it is on. By default: epics, features, stories and tasks, with bugs anywhere. It is replaced whole; what exists is never rewritten to fit.
- **Who is in the team**, by a name and a personal token, joined with the team's code.
- **What everyone has running**, as each host says it; a host that goes quiet is forgotten.
- **Where each host is, and each person's public key**, so hosts can connect to each other directly and hand sessions over. Offers and requests are passed through the server; it keeps them a minute, in memory. A session never passes through it.

```ts
import { joinServer, WorkClient, WorkServer } from "@pi-lattice/server";

const server = new WorkServer({ file: "work.db", port: 7420 });
await server.start();
const address = `http://localhost:7420/#${server.tracker.code}`;   // give this to the team

const client = new WorkClient(await joinServer(address, "yan"));
client.start();                                                     // keeps a copy up to date
const epic = await client.create({ title: "Checkout", type: "epic" });
await client.create({ title: "Pay by card", parent: epic.number });  // a feature: what goes under an epic
const { issue } = await client.next({ repo: "shop" });               // the next one that is ready, started and assigned
```

`next` is how a session takes work: the first issue, in the order of the tree, that is in a state sessions take from, is not for a person, is nobody else's, has nothing unfinished under it and waits on nothing unfinished. The server decides, so two askers never get the same one.

It speaks plain HTTP: put it behind TLS. Anyone with the team's code can join, and every member can read and change everything, the scheme included.

Read [the plan](../../docs/design/server-plan.md) for why it exists and what is not built.
