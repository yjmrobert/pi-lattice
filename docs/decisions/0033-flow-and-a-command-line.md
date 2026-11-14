# 0033. Flow: two gates for people, and a command line for other agents

Status: proposed. Nothing here is built. [The plan](../design/flow-plan.md) has what was looked at, the screens and the order to build in; [the mockup](../design/flow.html) can be clicked through.

Builds on [0026](0026-a-server-for-the-work.md) and [0027](0027-what-kanzo-changed.md). Answers three things [the server plan](../design/server-plan.md) left open: the order sessions take issues in, whether the tools should reach agents outside a lattice host, and what a board is when agents do most of the moving.

## Context

The tracker exists: one server, one SQLite file, issues in a hierarchy a team defines, `work_next`, review before done, drawn as a tree in the canopy. What it does not have is a way to steer.

Agents file issues faster than a person reads them and finish them faster than a person reviews them. So the work piles up in two places, and both are a person: deciding what should be done at all, and looking at what was done. Sprints, estimates and velocity measure a team's capacity to do work, which is no longer what is short. What is short is attention at those two points.

The canopy says where a piece of work belongs. It does not say where work is stuck, and nothing lets a person say what comes first.

## Decision

1. **Work flows through five states, and people hold two of the gates.** The default scheme becomes `proposed`, `ready`, `doing`, `review`, `done` (and `dropped`). Agents propose, people release, agents take, people accept. Everything else moves by itself.
   - An issue a session files starts in `proposed` (`rules.filed`). One a person files starts in `ready`: they have already decided.
   - `rules.take` is `ready`. Nothing a session filed is taken until a person releases it.
   - A team that trusts its agents sets `rules.filed` to `ready` and has one gate.

2. **Releasing and accepting are one key each, and work on a branch.** `g` releases the selected issue; on an item with issues under it, everything proposed under it, after saying how many. `a` accepts what is in review; `x` sends it back with a line that says why, and the issue returns to `ready` with that line as a comment, ahead of everything else under its parent. `o` is there as everywhere ([0031](0031-pi-opens-on-the-canopy.md)): say something else.

3. **Review has a limit, per person, and the server holds to it.** `rules.reviewLimit`, five by default. The reviewer of an issue is its assignee, or the nearest assignee above it. When that many of a person's issues are in review, `next` hands out nothing more that they would have to review, and says why. A person can still put a session on an issue by hand. This is the one work-in-progress limit: the column that fills is the one a person empties.

4. **Order is a thing people set.** An issue has a `rank` among the issues under the same parent. `next` takes the first ready issue in tree order: the first ready child of the first unfinished branch. Waits still come first. New issues go to the end. In the canopy this is what left to right already means ([0030](0030-the-canopy-in-order.md)); `[` and `]` now move an item earlier and later, and `o` no longer has two orders to switch between, because the filed order is the rank.

5. **A second reading of the same work: flow.** `v` in the canopy turns the tree on its side: the states are columns, and the lanes are the hierarchy, at the level chosen with `l` (epics, features, stories, or none). An issue is one line in its lane. The selection, the colours, the ring, amber and the band under it are the canopy's. The tree answers "where does this belong, and who is on it"; flow answers "where is it stuck, and what is mine to do".

6. **An issue opens in the box.** `space` on any item opens the issue over the screen, as a session opens ([0032](0032-a-session-opens-over-the-tree.md)): what it is, what done means, what it waits on, what was reported, and everything that happened to it with who did it. `enter` still opens the session on it.

7. **A result is part of the issue.** A session that finishes says what it did, how it checked, and where to look (`work_done`: a summary, checks, a url). That is what review shows; a person should not have to open a chat to accept.

8. **`pi-lattice work`: the same board from a shell.** For agents that are not Pi sessions (Claude Code, Codex, anything with a shell), for scripts, and for a person in a plain terminal. It is a client of the same server, with the token in `server.json`.

   ```
   pi-lattice work                      the board, as text
   pi-lattice work next [--under 12]    take the next ready issue; prints its brief
   pi-lattice work show 38
   pi-lattice work add "title" [--under 12] [--waits 3,4] [--human] [--body -]
   pi-lattice work note 38 "text"
   pi-lattice work done 38 --summary "…" [--check "…"] [--url …]
   pi-lattice work drop 38 "why"        give it back
   pi-lattice work prime                what an agent needs to be told, in a dozen lines
   ```

   `--json` on all of them. `--agent <name>` or `LATTICE_AGENT` says which agent is asking; the repository is the folder it is run in. Exit 0 when done, 3 when there is nothing to take, 4 when refused, with the reason on one line.

9. **An agent outside Pi holds an issue on a lease.** There is no host to say it is still running, so a taken issue is the agent's for thirty minutes after its last command that names it. After that the server puts the issue back in `ready` and writes in its history that it went quiet. In the canopy such an agent is a ring like any other, in its person's colour, with its name written.

10. **Pi sessions keep their tools.** `work_list`, `work_add`, `work_update`, `work_on`, `work_next`, and the new `work_done`. They say which session is asking without being told, which is what puts the ring on the right item and moves the issue when a result lands. The command line and the tools use the same words for the same things.

## Rejected

- **Sprints, points, velocity, burndown.** They pace and measure a team's capacity. Here that is not the constraint.
- **A board with flat columns.** It is what every kanban tool draws, and it loses the hierarchy, which is the one thing that keeps a thousand agent-made issues readable. Lanes are the tree.
- **An MCP server first.** Its tool definitions are in an agent's context on every turn whether or not it touches the board; a command costs nothing until it is run, and every coding agent has a shell. It can be added as a thin layer over the same client if an agent with no shell needs it.
- **Replacing the Pi tools with the command line.** A shell command does not know which session ran it. The tools do.
- **Issues as files in the repository** (Backlog.md, the first Beads). They travel with the code and diff well, but work here crosses repositories, and many agents writing at once is a merge. Beads moved to a database with versioning for that reason. One writer already avoids it.
- **GitHub or Linear as the store.** No single step that picks, starts and assigns; rate limits; nothing without a network. Mirroring an issue out to one of them is a separate, later thing, and the `url` field is where it would point.
- **Agents releasing their own proposals.** The gate is the point.
- **A limit on `doing`.** The number of sessions is already limited by the host, and is not what a person runs out of.

## Costs accepted

- **A default scheme that changed.** A server whose scheme was never edited gains `proposed` and `ready` in place of `todo`; existing `todo` issues become `ready`. An edited scheme is left alone, as in 0027.
- **A gate is a queue.** A person who is away holds up what agents proposed. `rules.filed` is the way out, and it is the team's choice.
- **A lease can expire on an agent that is only slow.** It is told so at its next command and can take the issue again if nobody has.
- **Two readings to keep alike.** The flow shares the canopy's world, order and band; what it adds is a layout.
- **The command line acts as the person.** An agent run by a person is that person to the server. The agent's name is recorded with what it did, and is not checked.
