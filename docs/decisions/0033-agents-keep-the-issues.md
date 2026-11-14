# 0033. Agents keep the issues; people steer, on the tree

Status: proposed. Nothing here is built. [The plan](../design/steering-plan.md) has what was looked at and the order to build in; [the mockup](../design/steering.html) can be used.

Builds on [0026](0026-a-server-for-the-work.md), [0027](0027-what-kanzo-changed.md) and [0031](0031-pi-opens-on-the-canopy.md). Answers two things [the server plan](../design/server-plan.md) left open: the order sessions take issues in, and how agents outside a lattice host reach the work.

## Context

The tracker exists: one server, one SQLite file, issues in a hierarchy a team defines, `work_next`, drawn as a tree in the canopy. People work on issues there with keys: `n` adds one, `e` moves it on, `m` assigns it, `t` comments.

That is a person keeping a tracker, with agents allowed in. Agents file, split, finish and re-plan faster than a person can keep up with by hand, and a person who tries becomes the slowest part of the work. What a person has that the agents do not is the intent: what matters, what does not, what must not happen.

## Decision

1. **Agents keep the issues.** Filing, breaking down, ordering, what waits on what, states, putting sessions on work, checking results, closing, pruning. A person does none of it by hand. `n`, `e`, `m` and `t` leave the canopy.

2. **Every branch is tended.** The session that tends an item is the nearest one at or above it with the coordinator role. Where a person speaks and nothing tends the branch, the host starts one on the nearest item above that has an owner.

3. **A person steers by saying.** `space` on any item opens a line at the foot of the tree, addressed to whoever tends that item, about that item: "this first", "drop this", "split it by provider", "why is this held". The line at the foot says who it goes to before it is sent. The answer comes back in one line in the same place, saying what was done, and what was done moves on the tree. This is `o` from [0031](0031-pi-opens-on-the-canopy.md), no longer waiting to be asked.

4. **What a person says can stand.** A line that is a rule and not an errand ("ask me before anything here lands", "no new dependencies") is kept on the item as a direction, word for word, under the person's name. Everything under the item is told it: a direction is part of the brief of every issue below, and `work_next` prints the ones above the issue it hands out. `⚑` beside an item, in the person's colour, says one stands there. Only a person's line makes a direction; an agent cannot write one. It is lifted by saying so.

5. **Gates are directions.** There is no column a person must empty. By default the session tending a branch checks a result against what the issue says done means, and closes it. A person puts a gate where they want one, by saying so there, and it holds for that branch only. An agent that is unsure asks, in amber, as now.

6. **Every change by an agent says why.** A reason is recorded with it. Items changed since a person last looked are marked on the tree; `u` goes through them, newest first: who, what, and why, at the foot. `x` there puts it back, which is a line to whoever made the change.

7. **Order is kept by the agents and steered by people.** An issue has a `rank` among the issues under its parent. `next` hands out the first ready issue in tree order; waits still come first. In the canopy that is left to right, as it already reads ([0030](0030-the-canopy-in-order.md)), and an item that changes place now moves there.

8. **A result is part of the issue.** `work_done`: what was done, how it was checked, where to look. It is what the tending session checks, and what a person is shown when a direction sends it to them.

9. **`pi-lattice work`: the same work from a shell,** for agents that are not Pi sessions (Claude Code, Codex, anything with a shell) and for scripts. A client of the same server, with the token in `server.json`.

   ```
   pi-lattice work next [--under 12]    take the next ready issue; prints its brief and the directions above it
   pi-lattice work show 38
   pi-lattice work add "title" [--under 12] [--waits 3,4] --why "…"
   pi-lattice work note 38 "text"
   pi-lattice work done 38 --summary "…" --check "…" [--url …]
   pi-lattice work drop 38 "why"        give it back
   pi-lattice work prime                what an agent needs to be told, in a dozen lines
   ```

   `--json` on all of them; `--agent <name>` says which agent is asking. Exit 0 when done, 3 when there is nothing to take, 4 when refused, with the reason on one line. There is no command for a person to edit issues with: a person says what they want in Pi.

10. **An agent outside Pi holds an issue on a lease.** No host says it is still running, so the issue is its own for thirty minutes after its last command that names it; then the server puts it back and records that it went quiet. On the tree it is a ring like any other, in its person's colour, with its name.

11. **Pi sessions keep their tools,** which know which session is asking: `work_list`, `work_add`, `work_update`, `work_on`, `work_next`, and the new `work_done`. Each write takes a `why`.

## Rejected

- **A board.** Drawn, and turned down: states as columns with the tree as lanes, and keys for a person to release and accept. It was a second place to look and it had a person moving issues, which is the work being given away. The tree is the only view.
- **Keeping the keys as shortcuts.** Two ways to change an issue, one of which the tending session does not hear about until it reads the history.
- **A fixed review step for people.** It makes a person the limit on everything, including what they do not care about.
- **Agents writing directions.** A direction is what a person meant. An agent that wants a rule asks for one.
- **Sprints, points, velocity.** They pace a team's capacity, which is not what is short.
- **An MCP server first.** Its tool definitions sit in an agent's context on every turn; a command costs nothing until it is run, and every coding agent has a shell.
- **Issues as files in the repository, or in GitHub or Linear.** Many writers at once is a merge in the first case; no single step that picks, starts and assigns in the second. One server already avoids both.

## Costs accepted

- **A tracker is as good as what tends it.** A session that orders badly or closes too soon does so quietly. The reasons, the marks on what changed, and `x` are what a person has against that. Whether they are enough needs real use.
- **Saying is slower than a key** for the smallest change, and a line can be misread. The answer says what was done, so a misreading is seen at once.
- **Something is always tending.** A session per branch a person steers, for as long as there is work on it.
- **Existing habits go.** People who used `n` and `e` say it instead.
- **The command line acts as the person.** An agent's name is recorded with what it did, and is not checked.
