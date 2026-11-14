# Flow: steering work that agents do

A plan for what the issue tracker needs next. Status: proposed, nothing built. The decision is [0033](../decisions/0033-flow-and-a-command-line.md); [the mockup](flow.html) is the screens below, working.

## The questions this started from

**Should it be built into Pi?** It is, and should stay. The canopy is the board and the agents' tools are Pi tools, so a session's issue, its ring and its result need no setup. What is missing is a way in for everything that is not a Pi session.

**Should there be a command line for agents?** Yes: `pi-lattice work`, for other coding agents, scripts and plain terminals. Not instead of the Pi tools, which know which session is asking.

**A SQLite database on the server?** That is what there is ([0026](../decisions/0026-a-server-for-the-work.md)), and nothing looked at here is a reason to change it. It gains a `rank` column, a result on an issue, and leases.

**Other ideas?** The ones taken are in the decision: two gates for people, a limit on review, order people can set, and a flow reading of the tree.

## What was looked at

- **What is here.** Issues, a scheme, `work_next`, review before done, the canopy ([0026](../decisions/0026-a-server-for-the-work.md), [0027](../decisions/0027-what-kanzo-changed.md), [0030](../decisions/0030-the-canopy-in-order.md) to [0032](../decisions/0032-a-session-opens-over-the-tree.md)). Left open in [the server plan](server-plan.md): the order issues are taken in, and tools for agents outside a host.
- **Beads** (from its documentation, November 2026). A tracker made for coding agents. The command line is the interface, with JSON on every command; `bd ready` lists only what nothing holds; `bd prime` prints what an agent should be told. It began as SQLite with a JSONL file in git and moved to Dolt, a versioned database, because many writers and git merges did not get along. Taken: the command line, `prime`, and the lesson about writers, which one server already answers.
- **Linear's agents** (its documentation and its writing on the agent SDK). An issue keeps a human assignee and gains an agent it is delegated to; an agent says it is one; a person is told when an agent needs input or has something to review. Here that is already the hue and the ring. Taken: review as something that reaches a person, not a column they must remember to look at.
- **MCP against a command line** (several write-ups from 2026; the figures are vendors' own and vary). The common finding: tool definitions cost context on every turn, a command costs nothing until run, and the gap narrows where tools are loaded on demand. An issue tracker is a handful of verbs, which is the easy case for a command.
- **Kanban boards for agents.** Kanzo was read for 0027. Vibe Kanban, the best known, has announced it is shutting down and retired its board; what the survivors share is a review step that belongs to the person. None of those read keeps a hierarchy.

## The brief

**Who, and when.** A developer with several sessions working, their own and teammates', in a terminal, mid-task. They look at the board for seconds at a time and come back to it after being away. They did not watch the work happen.

**What they must be able to do.** Say what should be done and in what order, and say whether what was done is right. Everything on the screen serves one of those or reports on the work between them.

**What is true here and nowhere else.** The work is a tree that a team shapes, agents sit on it visibly, and anything can be answered where it is seen. A board that drops any of those is a worse version of something that exists.

**The thesis.** Two gates, two keys: `g` to release, `a` to accept. The columns that are a person's read as theirs; the three between them are the agents' and need nothing.

**Anti-goals.** Dragging. Cards with avatars, badges and counts. Charts. A screen that needs reading to find what is waiting. Any ceremony with a calendar.

## The screens

### Flow (`v` in the canopy)

```
 ◆ harbor  1 @yan ⠋2 ●1   2 @sam ⠋1   3 @mira ⠋1   4 ○@teo away                tree │ flow
 since you looked 40m ago   6 landed   4 proposed by agents   1 went quiet

 PROPOSED 5            READY 6               DOING 4               REVIEW 4              DONE 9 today
 yours to release                                                  yours 3 of 3 · full
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 checkout-v2  epic @yan
 ▾ saved-cards  feature  ███░░░░ 2 of 9
   · 44 retry failed…    ○ 38 card form val…   ⠹ 35 tokenize on…     ◇ 33 stripe webho…    ✓ 30 vault schema
   · 45 expiry remin…    ○ 39 delete a sav…                          ◇ 37 card brand i…    ✓ 31 customer ma…
 ▾ tax-lines  feature  █░░░ 1 of 4
                         ⧗ 40 tax per line…    ● 36 rounding rul…    ◇ 34 totals endpo…    ✓ 29 tax table
 ───────────────────────────────────────────────────────────────────────────────────────────────────
 ◇ #33 stripe webhooks   up for review 12m · worker (pi) · @yan
 Handles charge.succeeded and charge.failed; replays are ignored by event id.
 checked  14 tests pass · replayed a failed charge against staging     +212 −18 in 6 files
  a  accept   x  send back   o  something else   enter  open the session   space  the issue
```

- **Columns are the states of the scheme,** in its order; done shows today's. A column header counts what is in it. Under the two a person owns is what is theirs to do there. Review says `3 of 3 · full` in amber when the limit is reached, because that is when agents stop being handed work.
- **Lanes are the tree.** `l` chooses the level the lanes are at; what is above a lane is written once as a heading, what is below is the cards. A lane folds with `f`, to its bar and its counts.
- **A card is one line:** the canopy's mark, the number, the title, in its owner's colour. `·` proposed, `○` ready, `⧗` held, a turning ring for a session working, `●` amber for a question, `◇` amber for a result to look at, `✓` done. Amber is still the only colour that means a person is needed.
- **Top to bottom in a column is first to last.** In ready that is the order agents take in. `[` and `]` move a card earlier and later.
- **The band under the board** is the canopy's ([0031](0031-pi-opens-on-the-canopy.md)): what the selected card is, and the keys that act on it, which change with its column.
- **`tab` goes to the next thing that needs you:** questions first, then results, oldest first.
- **Since you looked.** One line saying what changed while the person was away; `u` walks through it.
- **Below 120 columns** one column is shown at a time, with the headers as a row to move along.

### What each column offers

| On a card in | Keys |
|---|---|
| proposed | `g` release · `x` drop · `o` say something else. On a lane: `g` releases all that is proposed under it |
| ready | `[` `]` earlier, later · `s` put a session on it · `h` keep it for a person · `b` back to proposed |
| doing | `enter` open the session · what it asks, with its own keys |
| review | `a` accept · `x` send back with a line · `o` something else · `enter` open the session |
| done | `b` reopen |
| anywhere | `space` the issue · `n` new issue here · `/` find · `tab` next that needs you · `v` the tree |

### The issue (`space`)

A box over the board, in the owner's colour, as a session's is. Title, type, where it is. What it is and what done means. What it waits on and what waits on it. The result, when there is one. Then everything that happened, newest first, each line with who did it: a person, a session by name, an agent outside Pi by name. `e` edits the text in Pi's editor; `t` comments.

### From a shell

```
$ pi-lattice work next
#38 card form validation        task · saved-cards · @yan · shop
Validate number, expiry and CVC as they are typed.
Done means: wrong input is marked before submit; amex lengths are right.
It is yours until you say done or drop it, or go quiet for 30 minutes.

$ pi-lattice work next
Nothing to take: 3 of @yan's are waiting for review, and 3 is the limit.
```

`pi-lattice work prime` prints what an agent needs: take with `next`, write what you learn with `note`, file what you find with `add` and leave it for a person to release, finish with `done` and say how you checked, give back with `drop`. One line in a repository's agent instructions (`Run pi-lattice work prime`) is the whole integration.

## States and edges

- **Nothing yet.** The flow says how work gets here: `n` to file the first issue, or tell a session what you want and release what it proposes.
- **Nothing needs you.** The band says so, and what is running.
- **No server, or it is away.** As in the canopy: the last copy, marked stale; the keys that write say why they cannot.
- **Hundreds of proposed issues.** Lanes fold to counts; `g` on a lane releases them together; `/` narrows.
- **A lease ran out.** The card is back in ready with `went quiet` beside it until someone takes it.
- **Sent back.** First in ready under its parent, with the reason as its newest comment; the session that did it, if it is still there, is told.
- **Someone else's review is full.** Their column header says so for them; yours says yours.

## What changes where

| Part | Change |
|---|---|
| `protocol` | `rank` and `result` on an issue; `rules.filed`, `rules.reviewLimit`; the default scheme; who reviews an issue; tree order |
| `server` | `rank` kept on create and move; `next` in tree order, holding to the review limit; `done` with a result; leases for agents with no host; migration |
| `graph` | `work_done`; `work_add` from a session lands in `proposed` |
| `app` | `pi-lattice work` and its verbs, `--json`, exit codes, `prime` |
| `canopy` | `[` `]`; the flow layout and `v`, `l`; the issue box; review in the band with `a` `x` `o`; `g` |

## Build order

1. **Gates.** The scheme, `rules.filed`, release and accept, `work_done` with a result, review in the canopy's band. Useful alone, in the tree.
2. **Order.** `rank`, `next` in tree order, `[` `]`.
3. **The command line.** `pi-lattice work`, leases, `prime`. Tested with a real server and a shell.
4. **The limit.** `rules.reviewLimit`, and what `next` says when it holds.
5. **Flow.** The layout, lanes, `v` and `l`, narrow terminals. Tested as text, like the canopy.
6. **The issue box and since you looked.**

Each is a phase that stands by itself; 1 to 4 change what the tracker does, 5 and 6 how it is seen.

## Open

- Whether the command should have a shorter name than `pi-lattice work`. Agents do not mind typing; people do.
- Whether `proposed` should be the default for sessions, or only for sessions more than one level below a person's own.
- Whether accepting should be able to merge a branch, or stays a mark on an issue.
- Whether a result's checks should be run by the server's side (a command that must pass) rather than taken on the agent's word.
- How long a lease is. Thirty minutes is a guess.
