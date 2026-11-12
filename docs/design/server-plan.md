# One server, and the work on it

A plan to replace peer-to-peer sharing with one hosted service, and to track work on it as issues. Status: phases 1 to 5 are being built; the status line at the end of each phase says what exists.

## Why

Peer to peer ([0012](../decisions/0012-peer-to-peer-collab.md), [0018](../decisions/0018-networks.md), [0019](../decisions/0019-everything-everyone-is-running.md)) has no place where shared things live. Sessions get by without one: each has an owner, the owner's machine is the truth, and when it is off the session is shown as last seen.

Work is different. An epic is nobody's machine's: several people edit it, reorder it, close it, and it must be there when its author's laptop is shut. Doing that between laptops means merging edits made apart, deciding who is right, and carrying history to whoever was away. A server that is always on makes all of it one writer and one copy.

## What was looked at

- **GitHub issues** (from memory of the product, not re-read for this plan): an issue is a number, a title, a body, a state, assignees and labels, with a timeline of everything done to it. Structure was added in three separate parts: *issue types* (a short list a team defines), *sub-issues* (a parent, so issues form a tree), and *project fields* (typed values a team adds: text, number, date, a choice). The shape worth copying is that split: the issue itself is small and fixed, and what a team wants beyond it is configuration, not schema.
- **Linear, Jira**: the same core, with workflow states grouped into a few kinds (not started, started, done, cancelled) so that tools can reason about a state whatever a team calls it.
- **"Kanzo"** was not found by a web search; the plan follows the description given (one hosted service, issues with metadata), not that product.
- **What this repository has**: planned work ([0023](../decisions/0023-planned-work.md)) puts items in a host's session tree, so they live on one machine and reach teammates only as sessions that never ran. The canopy ([0024](../decisions/0024-the-canopy.md)) draws items on levels and does not care where they come from.

## The model

**An issue** is: a number (`#12`, counted by the server), a title, a body, a type, a state, a parent, an assignee, labels, values for the team's fields, comments, and a history of every change with who made it and when.

**A scheme** is how a team structures them, and it is data on the server, edited as a whole:

- **Types**, each with the level it is drawn on and the types it may sit under. By default `epic`, `feature` under an epic, `story` under a feature, `task` under a story, and `bug` under any of them or under nothing.
- **States**, each of a kind: `open`, `active`, `done` or `dropped`. By default `todo`, `doing`, `done`, `dropped`.
- **Fields**: a name and a type (`text`, `number`, `date`, `person`, `choice` with its choices), optionally only for some types, optionally required.
- **Rules** for what sessions do to issues: the state an issue takes when a session is put on it, and when the session reports its result.

Changing the scheme never rewrites or rejects what exists. An issue that no longer fits (a type that was removed, a parent that is no longer allowed) stays where it is and is marked as misplaced, so a team can change its structure first and move the work after.

**A session sits on an issue.** A session records the number of the issue it is on. Several can be on one. Putting a session on an issue, an agent saying it has moved to another, and a result landing are the three things that connect the two.

**One server per team.** Issues are the team's, not a repository's: work crosses repositories. A repository is a field on an issue when it matters.

## The parts

| Part | Where | What |
|---|---|---|
| Types and rules | `protocol` | `Issue`, `Scheme`, the default scheme, and the pure functions that say whether an issue fits. No I/O. |
| The service | new package `server` | An HTTP server over one SQLite file. The only writer. Also the client the host uses. |
| The host | `host`, wired in `app` | Connects when a server is configured, keeps a copy of the issues, tells the server which sessions it runs, and answers the pane, the canopy and the agents from the copy. |
| Agents | `graph` | Tools to read the work, add to it, change it, and say which issue they are on. |
| The canopy | `canopy` | Draws the issues, with sessions on them, when there is a server; the session tree as before when there is not. |
| Running it | `app` | `pi-lattice server`, and `/lattice server <address>` to join one. |

The API, all JSON over HTTP, with a personal token:

- `POST /join` with the team's code and a name: a token.
- `GET /changes?after=<n>&wait=<s>`: what changed since revision `n`: issues, the scheme, people, sessions. Waits up to `wait` seconds when nothing has. A client that has nothing asks from 0.
- `POST /issues`, `PATCH /issues/<number>`, `POST /issues/<number>/comments`, `GET /issues/<number>` (with comments and history).
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
4. **Agents.** `work_list`, `work_add`, `work_update`, `work_on`; `spawn_session` takes an issue; a result landing closes what the rules say.
5. **The canopy draws issues.** Levels from the scheme, sessions on their issues, teammates' sessions from the server, misplaced issues marked.
6. **Working on issues from the canopy.** Add, edit, move, assign, comment, change state in place; edit the scheme.
7. **Sessions through the server.** Reading a teammate's conversation, mail between owners, and handing a session over, with the server holding what is in flight so both people need not be online.
8. **Retire peer to peer.** Remove `collab`, networks and join codes once phase 7 covers what they do. Until then both exist, and a team can use either.

Phases 7 and 8 are the pivot proper and the largest part. They are last because they replace something that works, and nothing before them depends on them.

## Open

- Whether a server should hold more than one team.
- Whether the scheme should be editable by everyone, as planned, or by the person who started the server.
- Whether a host should be able to carry a small server of its own, so that one person gets issues with nothing to deploy.
