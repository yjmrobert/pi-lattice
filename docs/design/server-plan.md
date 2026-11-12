# One server, and the work on it

A plan to replace peer-to-peer sharing with one hosted service, and to track work on it as issues. Status: phases 1 to 6 are built ([0026](../decisions/0026-a-server-for-the-work.md)), and so is what reading Kanzo changed ([0027](../decisions/0027-what-kanzo-changed.md)): a board on a person's own machine, sessions taking the next ready issue, and review before done. Phases 7 and 8 are not: reading a teammate's conversation, mail between owners and handing a session over still go peer to peer. Of phase 6, moving an issue under another parent, changing its type, labels and fields are commands or agent tools, not keys in the canopy.

## Why

Peer to peer ([0012](../decisions/0012-peer-to-peer-collab.md), [0018](../decisions/0018-networks.md), [0019](../decisions/0019-everything-everyone-is-running.md)) has no place where shared things live. Sessions get by without one: each has an owner, the owner's machine is the truth, and when it is off the session is shown as last seen.

Work is different. An epic is nobody's machine's: several people edit it, reorder it, close it, and it must be there when its author's laptop is shut. Doing that between laptops means merging edits made apart, deciding who is right, and carrying history to whoever was away. A server that is always on makes all of it one writer and one copy.

## What was looked at

- **GitHub issues** (from memory of the product, not re-read for this plan): an issue is a number, a title, a body, a state, assignees and labels, with a timeline of everything done to it. Structure was added in three separate parts: *issue types* (a short list a team defines), *sub-issues* (a parent, so issues form a tree), and *project fields* (typed values a team adds: text, number, date, a choice). The shape worth copying is that split: the issue itself is small and fixed, and what a team wants beyond it is configuration, not schema.
- **Linear, Jira**: the same core, with workflow states grouped into a few kinds (not started, started, done, cancelled) so that tools can reason about a state whatever a team calls it.
- **[Kanzo](https://github.com/emanuele-em/kanzo)** (0.4.2, read after phases 1 to 6 were built; AGPL-3.0, so its ideas were taken and none of its code). A kanban board and an MCP server in one program. What it does, and what this plan took from it:

  | Kanzo | Here |
  |---|---|
  | Every install is the board. `kanzo share on` opens it to the network, `kanzo join <address>` uses someone else's. A Raspberry Pi that stays on keeps it for everyone. Nothing is deployed. | Taken. `/lattice server start` starts a board on the person's own machine, `/lattice server share` opens it, `/lattice server <address>` joins another. `pi-lattice server` is still there for a machine that stays on. |
  | Agents call `next_task`: the top of todo, moved to doing in the same step. | Taken as `work_next`, decided on the server so two sessions never get the same issue. |
  | A task can wait on others; `next_task` skips it until they are done. | Taken: `waitsOn`. A dropped issue holds nothing; one in review still does. |
  | A task marked human is left to the person. | Taken: `human`. |
  | Columns are todo, doing, review, done. Agents move a task to review and leave done to the person. | Taken as the default: a session's result moves its issue to `review`. It is a rule in the scheme, so a team can have results close issues. |
  | A backlog column agents leave alone. | Taken as a rule: `take` names the state sessions take from. |
  | A project is found from the git remote of the folder the agent works in. | Partly. Issues are the team's and cross repositories, so there are no projects; an issue may name a `repo`, its children inherit it, and `work_next` leaves work for another repository alone. The repository is the folder's name, not its remote. |
  | A URL on a task, for its pull request. | A `url` field in the default scheme. |
  | No logins: share only on a network you trust. | Kept stricter: a code to join, a token each. Still no roles and no TLS. |
  | One writer, a change counter the board polls. | The same, arrived at separately: revisions and a feed that waits. |
  | When the shared board cannot be reached, calls fail. | Kept as it was: the last copy stays, marked stale; writes fail. |
  | Board order: cards are dragged into the order agents take them. | Not built. Issues are taken lowest number first. |
  | A board in the browser; MCP, so any agent can use it; images; a filter language; export; sync through a git repository; a single 4.7 MB binary. | Not built. The canopy is the board, and only Pi sessions under a lattice host have the tools. |

  Kanzo has no hierarchy, types or custom fields: a task is in a project and a column. The scheme here has no counterpart in it.
- **What this repository has**: planned work ([0023](../decisions/0023-planned-work.md)) puts items in a host's session tree, so they live on one machine and reach teammates only as sessions that never ran. The canopy ([0024](../decisions/0024-the-canopy.md)) draws items on levels and does not care where they come from.

## The model

**An issue** is: a number (`#12`, counted by the server), a title, a body, a type, a state, a parent, an assignee, labels, values for the team's fields, the issues it waits on, whether it is for a person, the repository it is for, comments, and a history of every change with who made it and when.

**A scheme** is how a team structures them, and it is data on the server, edited as a whole:

- **Types**, each with the level it is drawn on and the types it may sit under. By default `epic`, `feature` under an epic, `story` under a feature, `task` under a story, and `bug` under any of them or under nothing.
- **States**, each of a kind: `open`, `active`, `done` or `dropped`. By default `todo`, `doing`, `done`, `dropped`.
- **Fields**: a name and a type (`text`, `number`, `date`, `person`, `choice` with its choices), optionally only for some types, optionally required.
- **Rules** for what sessions do to issues: the state an issue takes when a session is put on it (`doing`), when the session reports its result (`review`, for a person to close), and optionally the one state sessions take their next issue from, which leaves the others, like a backlog, to people.

**What is ready.** A session asking for its next issue gets the lowest-numbered one that is in a state sessions take from, is not for a person, is unassigned or its owner's, has nothing unfinished under it, waits on nothing unfinished, and is not for another repository. The server picks, starts and assigns it in one step.

Changing the scheme never rewrites or rejects what exists. An issue that no longer fits (a type that was removed, a parent that is no longer allowed) stays where it is and is marked as misplaced, so a team can change its structure first and move the work after.

**A session sits on an issue.** A session records the number of the issue it is on. Several can be on one. Putting a session on an issue, an agent saying it has moved to another, and a result landing are the three things that connect the two.

**One server per team.** Issues are the team's, not a repository's: work crosses repositories. An issue names a repository when it matters, and what is under it is for that repository too.

**Where the server runs.** Either on a machine that stays on (`pi-lattice server`), or on a person's own: a board, started by their host the first time it is asked for, kept in their lattice home, reachable only from that machine until they share it. It is the same server either way. The board is one process for all of the person's repositories; it stops after ten minutes with no host asking, unless shared, and any host that finds it gone starts it again. Shared from a laptop, it is there while the laptop is on, which is the trade Kanzo makes too.

## The parts

| Part | Where | What |
|---|---|---|
| Types and rules | `protocol` | `Issue`, `Scheme`, the default scheme, and the pure functions that say whether an issue fits. No I/O. |
| The service | new package `server` | An HTTP server over one SQLite file. The only writer. Also the client the host uses. |
| The host | `host`, wired in `app` | Connects when a server is configured, keeps a copy of the issues, tells the server which sessions it runs, and answers the pane, the canopy and the agents from the copy. |
| Agents | `graph` | Tools to read the work, add to it, change it, and say which issue they are on. |
| The canopy | `canopy` | Draws the issues, with sessions on them, when there is a server; the session tree as before when there is not. |
| Running it | `app` | `pi-lattice server` for a machine that stays on; `/lattice server start` and `share` for a board on one's own; `/lattice server <address>` to join either. |

The API, all JSON over HTTP, with a personal token:

- `POST /join` with the team's code and a name: a token.
- `GET /changes?after=<n>&wait=<s>`: what changed since revision `n`: issues, the scheme, people, sessions. Waits up to `wait` seconds when nothing has. A client that has nothing asks from 0.
- `POST /issues`, `PATCH /issues/<number>`, `POST /issues/<number>/comments`, `GET /issues/<number>` (with comments and history).
- `POST /next`: take the next ready issue, narrowed by repository, an issue it must be under, a type or a label.
- `PUT /scheme`.
- `PUT /sessions`: the sessions one host is running, which expire if the host stops saying so.

Every write is checked and applied by the server in order. A write may name the revision it was based on; if the issue has changed since, it is refused and the client looks again. There is nothing to merge.

## Edges

- **No server configured.** Everything works as today: the session tree, planned items in it, the canopy drawn from sessions.
- **Server unreachable.** The host keeps its last copy and shows it as stale. Reads work; writes fail and say so. Nothing is queued: a queue of edits made offline is the merging this plan exists to avoid.
- **A laptop goes offline.** Its sessions disappear from the server after 45 seconds without word. Its issues are untouched.
- **Two people change one issue.** Different fields: both apply. The same field: the later one wins, and history shows both.
- **A parent is closed with open children,** or a child moved under its own descendant: refused, with the reason.
- **A name is taken.** Joining under a name someone holds is refused without that person's token.
- **Scale.** A copy of every issue on every host is fine for thousands; beyond that the changes feed would need to be scoped. Not built.
- **Security.** The server speaks plain HTTP; put it behind TLS (a reverse proxy, a tunnel). Anyone with the team code can join and read and write everything. There are no roles.

## Delivery

1. **Types and rules.** The scheme, its default, and validation, in `protocol`.
2. **The service.** Store, HTTP API, the changes feed, joining, and a client. Tested against a real server on a local port.
3. **The host joins.** Configuration, the copy, presence, a `work` method for the pane and canopy, and sessions that record their issue. `pi-lattice server`, `/lattice server`.
4. **Agents.** `work_list`, `work_add`, `work_update`, `work_on`, `work_next`; `spawn_session` takes an issue; a result landing moves the issue as the rules say.
5. **The canopy draws issues.** Levels from the scheme, sessions on their issues, teammates' sessions from the server, misplaced issues marked.
6. **Working on issues from the canopy.** Add, edit, move, assign, comment, change state in place; edit the scheme.
6a. **After Kanzo.** A board on one's own machine and sharing it; `work_next`, waiting, issues for people, review, a state to take from, a repository on an issue.
7. **Sessions through the server.** Reading a teammate's conversation, mail between owners, and handing a session over, with the server holding what is in flight so both people need not be online.
8. **Retire peer to peer.** Remove `collab`, networks and join codes once phase 7 covers what they do. Until then both exist, and a team can use either.

Phases 7 and 8 are the pivot proper and the largest part. They are last because they replace something that works, and nothing before them depends on them.

## Open

- Whether a server should hold more than one team.
- Whether the scheme should be editable by everyone, as planned, or by the person who started the server.
- ~~Whether a host should be able to carry a small server of its own.~~ Yes: the board, after Kanzo.
- Whether the board should start by itself, so that a person has issues without asking. Today it is one command, because with it the canopy draws issues instead of the session tree, and that is a change someone should choose.
- The order sessions take issues in. Lowest number first is predictable and cannot be changed; Kanzo lets cards be dragged.
- Whether a repository should be known by its remote rather than its folder's name, so that clones under different names are one repository.
- Whether the work tools should also be an MCP server, so that agents outside a lattice host can use the board.
