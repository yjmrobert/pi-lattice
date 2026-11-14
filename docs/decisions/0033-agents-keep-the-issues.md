# 0033. Agents keep the issues; people steer, on the tree

Status: built. [The plan](../design/steering-plan.md) has what was looked at; [the mockup](../design/steering.html) is the design it was built from, and differs from the canopy in small ways.

Builds on [0026](0026-a-server-for-the-work.md), [0027](0027-what-kanzo-changed.md) and [0031](0031-pi-opens-on-the-canopy.md). Answers two things [the server plan](../design/server-plan.md) left open: the order sessions take issues in, and how agents outside a lattice host reach the work.

## Context

The tracker exists: one server, one SQLite file, issues in a hierarchy a team defines, `work_next`, drawn as a tree in the canopy. People work on issues there with keys: `n` adds one, `e` moves it on, `m` assigns it, `t` comments.

That is a person keeping a tracker, with agents allowed in. Agents file, split, finish and re-plan faster than a person can keep up with by hand, and a person who tries becomes the slowest part of the work. What a person has that the agents do not is the intent: what matters, what does not, what must not happen.

## Decision

1. **Agents keep the issues.** Filing, breaking down, ordering, what waits on what, states, putting sessions on work, checking results, closing, pruning. A person does none of it by hand. `n`, `e`, `m` and `t` are removed from the canopy outright, not kept as shortcuts.

2. **Every branch is tended.** The session that tends an issue is the nearest one of the person's with the coordinator role, on it or on an issue above it; a coordinator at the top of their tree, on no issue, tends what nothing else does. Where a person speaks and nothing tends the branch, the host starts a coordinator on the top issue of that branch, under the person's own session.

3. **A person steers by saying.** `space` on any item opens a line at the foot of the tree, addressed to whoever tends that item, about that item: "this first", "drop this", "split it by provider", "why is this held". The line at the foot says who it goes to before it is sent. The session's last sentence of that turn is the answer, drawn in the same place; what it did moves on the tree. This is `o` from [0031](0031-pi-opens-on-the-canopy.md), no longer waiting to be asked. `/lattice say <issue | session> <text>` does the same from the chat. A session open in a terminal is told by that terminal, since the host cannot type there.

4. **What a person says can stand.** Every line said about an issue is kept on it, in the person's words. There is one key: the session decides whether a line is an errand or a rule, and keeps a rule as a direction (`work_direction`, naming the line). A direction stands on the issue under the person's name, and `work_next` and `pi-lattice work next` print the ones that reach the issue they hand out. `⚑` beside an item, in the person's colour, says one stands there. An agent cannot write a direction or change its words: it can only keep or lift a line a person said. It is lifted by saying so.

5. **Results are checked by agents, and gates are directions.** There is no column a person must empty. A result on a task is checked by the session tending its branch, against what the issue says done means, and closed. A result on anything larger is checked by a session of its own with the `reviewer` role, started under the one that tends it, so that nothing larger than a task is closed by what delegated it. Which types get a reviewer is the scheme's `rules.review`: every type but tasks and bugs by default, and a team sets it to nothing to have the tending session check everything. A person puts a gate where they want one, by saying so there, and it holds for that branch only. An agent that is unsure asks, in amber, as now.

6. **Every change by an agent says why.** The session or agent that made it and the reason it gave are recorded with it, beside the person whose token it came with. The server keeps the revision each person last looked at. Items an agent changed since are marked `+` on the tree; `u` goes through them, newest first: who, what, and why, at the foot. `x` there puts it back, which is a line to whatever tends it. Past the last one, the person has looked.

7. **Order is kept by the agents and steered by people.** An issue has a `rank` among the issues under its parent, set with `place` (first, last, before or after another). `next` hands out the first ready issue in the order the tree is read; waits still come first. In the canopy that is left to right, as it already reads ([0030](0030-the-canopy-in-order.md)), and an item that changes place now moves there, as a folded one does.

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

## Evidence

- `packages/server/test/server.test.ts`, "work that agents keep": tree order and placing, with who and why; a result kept and the issue moved on; a line kept in the person's words, standing and lifted; what changed since a person looked; a lease kept by speaking and lost by silence; `rules.review` checked.
- `test/integration/work.test.ts`, "steering the work", with a real server, a real host and real Pi sessions on the scripted model: a line said about an issue reaches the coordinator above it, which changes the order with a reason and answers; the line is kept and becomes a direction when the session keeps it; a session cannot say a line itself; a session is started to tend a branch that nothing tends; a result from an agent with no host is handed to the tending session for a bug and to a reviewer for a feature.
- `test/integration/tui.test.ts`, in Pi's terminal: `space` on a feature, the line to "a session that is started to tend it", the story the session adds with its reason, the answer at the foot of the tree, and the count of what agents changed.
- `packages/canopy/test/work.test.ts`: the line and who it goes to, the walk through what changed and putting one back, directions drawn where they stand and in the panel, issues in the order the agents keep, an agent holding an issue from a shell, the removed keys doing nothing, and what counts as changing place.
- `packages/app/test/workcli.test.ts`: `pi-lattice work` against a real server: next with the brief and the directions, note, add with a reason, done, show, drop, the exit codes, `--json`.

## Not verified

- **A real model.** Every test uses the scripted model, which does what a line tells it in so many words. Whether a model reads "this first" and places the issue, tells a rule from an errand, and answers in one sentence is what `npm run eval` is for, and it has not been run on this.
- **A teammate's line.** A line said on an issue that a teammate's session tends is kept on the server and passed to that session by their host as a request, not a direction. The code is there; no test has two hosts.
- **A result that arrives while the host is off.** A host hands on the results it sees come in while it runs. One that came in before it started waits until something else moves the issue.

## Rejected

- **A board.** Drawn, and turned down: states as columns with the tree as lanes, and keys for a person to release and accept. It was a second place to look and it had a person moving issues, which is the work being given away. The tree is the only view.
- **Keeping the keys as shortcuts.** Two ways to change an issue, one of which the tending session does not hear about until it reads the history.
- **Two keys, one for an errand and one for a rule.** The person would have to classify what they are about to say before saying it. The session says which it took it for.
- **The tending session checking everything.** It would close work it delegated. That is accepted for tasks, where a reviewer for each would cost more than the task, and is a setting for the rest.
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
- **The command line acts as the person.** An agent's name is recorded with what it did, and is not checked. That only a person says a line is held by the host and by the command line having no way to say one, not by the server: the token is the same.
- **A line said in answer shows as a change.** What a session does because of a person's line is marked `+` like anything else an agent did.
- **`/lattice issue` is still there.** It reads an issue, and can change one from the chat. The canopy has no key for it.
