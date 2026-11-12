# 0026 A server for the team's work

Begins the move away from peer to peer ([0012](0012-peer-to-peer-collab.md), [0018](0018-networks.md), [0019](0019-everything-everyone-is-running.md)). Changes [0023](0023-planned-work.md): with a server, work is planned as issues on it, not as items in a session tree. [The plan](../design/server-plan.md) has the reasoning and what is left.

**Decision**

- **One always-on server holds the team's work, and is the only thing that writes it.** A new package, `server`: an HTTP API over one SQLite file, and the client a host uses. Every change is checked and applied there, in order. A client keeps a copy by asking for what changed since its revision. Nothing is merged, anywhere.
- **Work is issues.** A number, a title, a body, a type, a state, a parent, an assignee, labels, fields, comments, and a history of every change with who made it.
- **Structure is a scheme, and the scheme is data.** Types with the level each is drawn on and what each may sit under; states, each of a kind (open, active, done, dropped); typed fields; and what sessions do to issues. The default is epics, features, stories and tasks, with bugs anywhere. It lives in `protocol` as types and pure functions, so the server enforces it and the canopy and the agents read it.
- **A changed scheme never rewrites what exists.** New issues and moves must fit. What no longer fits stays where it is and is marked misplaced, so a team changes its structure first and moves its work after.
- **A session records the issue it is on.** Putting a session on an issue starts it, and its result landing finishes it unless something under it is unfinished; both are the scheme's rules, applied by the server. (Since [0027](0027-what-kanzo-changed.md) the default rule puts the issue up for review instead.) A child session with no issue of its own is on its parent's.
- **A host follows one file.** `server.json` in the person's lattice home says which server and who they are on it. The host of every repository reads it, so joining in one terminal takes effect in all. The token in it is the person: the file is readable only by them.
- **Hosts tell the server what they run,** every fifteen seconds and when it changes; the server forgets a host after forty-five seconds of silence. This is how teammates see each other's sessions, with no connection between laptops.
- **The canopy draws issues when there is a server.** Levels come from the scheme, the colour of an item is whoever it is assigned to, and the ring is the colour of whoever's session is on it. Sessions on no issue are drawn at the foot. Without a server the canopy draws the session tree, as before.
- **The host knows nothing of HTTP.** It is given a `WorkPort`, as it is given sharing; `app` supplies one made from the client. `server` depends on `protocol` alone ([0014](0014-package-seams.md)).
- **Agents have four tools:** `work_list`, `work_add`, `work_update`, `work_on`; and `spawn_session` takes an issue.
- **People work on issues where they see them.** In the canopy: `n` adds an issue under the selected one, of the first type the scheme allows there, with its title typed at the foot; `e` moves it to its next state; `m` assigns it to you; `t` comments; `s` puts your session on it. `/lattice issue` shows, adds, changes and comments; `/lattice scheme edit` opens the scheme as the data it is, and says what is wrong with it before anything is saved.
- **The canopy changes work through `/lattice` commands,** as it opens sessions: it has no connection of its own ([0024](0024-the-canopy.md)).

**Rejected**

- **Issues in each host, synchronised between them.** This is what peer to peer would need: merging edits made apart and carrying history to whoever was away. Avoiding it is the reason for the server.
- **Queueing writes while the server is away.** A queue of edits made offline is the same merging problem. Writes fail and say so; reads use the last copy.
- **Fixed levels.** Epics, features, stories and tasks are a default, not a schema: a team that works differently changes the scheme, not the code.
- **Rejecting a scheme that existing issues do not fit.** It would make a change of structure impossible without first rewriting every issue under the old one.
- **Issues per repository.** Work crosses repositories; a repository can be a field.

**Evidence**

- `packages/server/test/server.test.ts` runs a real server on a local port: joining, the default structure and its refusals, two people changing one issue, a change based on an old look being refused, history, the feed reaching a listener, replacing the scheme, sessions being forgotten, the server going away and coming back, and one file holding everything across a restart.
- `test/integration/work.test.ts` runs a real host joined to a real server with real Pi sessions: an agent adds and reads work, a teammate sees it at once, a session put on an issue starts it and its result finishes it, and without a server the tools say so.
- `test/integration/tui.test.ts` does it in Pi's terminal: `/lattice server <address>`, the canopy drawn from the server's issues, and `s` putting the session on one.

**Not verified**

- A server reached over a real network, behind TLS, with real latency. Every test uses a local port.
- More than a few hundred issues. Each host holds a copy of all of them.
- Two hosts of one person publishing at once from two repositories, in Pi. The server keeps them apart by host id; only the server's side of that is tested.

**Costs accepted**

- **Something to run.** A team needs one machine that stays on.
- **No roles.** Anyone with the team's code can join, and every member can change everything, the scheme included.
- **Plain HTTP.** TLS is left to whatever is put in front of it.
- **Two ways to share, for now.** Reading a teammate's conversation, mail between owners and handing a session over still go peer to peer; the plan moves them to the server and then removes `collab`.
- **A name cannot be taken back.** Leaving keeps the name taken on the server; a lost token means a new name.
