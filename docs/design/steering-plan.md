# Steering: agents keep the issues, people say what they want

What the issue tracker needed next, and how it was built. Status: built, all six phases. The decision is [0033](../decisions/0033-agents-keep-the-issues.md), which also says what is not verified; [the mockup](steering.html) is the canopy below as it was designed.

## The questions this started from

**Should it be built into Pi?** It is, and should stay: the canopy is where the work is seen and the agents' tools are Pi tools. Nothing is added beside the canopy.

**Should there be a command line for agents?** Yes: `pi-lattice work`, for coding agents that are not Pi sessions and for scripts. Pi sessions keep their tools, which know which session is asking.

**A SQLite database on the server?** That is what there is ([0026](../decisions/0026-a-server-for-the-work.md)). It gains a rank, a result, directions, a reason on each change, and leases.

**Other ideas?** One: the person stops keeping the tracker. Agents keep it; a person says what they want, on the tree, to whoever tends that part of it.

## What was looked at

- **What is here.** Issues, a scheme, `work_next`, review before done, the canopy, and `o`: a line typed at the foot of the tree instead of an answer ([0031](0031-pi-opens-on-the-canopy.md)). The coordinator role already lays work out and checks what comes back.
- **Beads** (its documentation, November 2026). A tracker made for coding agents: the command line is the interface, JSON on every command, `bd ready` for what nothing holds, `bd prime` for what an agent should be told. It moved from files in git to a versioned database because many writers and merges did not get along. Taken: the command line and `prime`.
- **Linear's agents** (its documentation and its writing on the agent SDK). An issue keeps a human owner and gains an agent it is delegated to; an agent says it is one; a person is told when an agent needs them. Here that is the hue, the ring and amber.
- **MCP against a command line** (several write-ups from 2026; the figures are vendors' own). Tool definitions cost context on every turn; a command costs nothing until run.
- **A board,** tried in a first draft of this plan: columns of states, lanes from the tree, keys to release and accept. Turned down. It kept the person as the one who moves issues.

## The brief

**Who, and when.** A developer with many sessions working, theirs and teammates', looking at the tree for seconds at a time and coming back to it after being away. They did not watch the work happen and do not want to keep a tracker.

**What they must be able to do.** Say what they want, where they see it. See that it was understood. See what the agents changed by themselves, and why. Be asked only what is theirs to decide.

**The thesis.** One act: `space`, and a line. Everything a tracker has buttons for is something to say to the session tending that branch.

**Anti-goals.** A second view. Forms. Fields to fill. A person changing an issue's state, order or parent by hand. A queue a person must empty.

## On the canopy

```
                      ⢰⠦✓ schema                              │ tables                    story
                      ⢸⠤⠋ copy                                │ @sam  ◆ shop
                      ⢸⠤⧗ verify-copy     ⢠⠤⠋ writer          │ tended by planner, here
                     ⢀⢼⢄                  ⢸⠤○ reader          │
                     ⡇◉ tables ⚑          ⢸⠤○ flag            │ DIRECTIONS
                     ⠈⢺⠊· planner · 1/3   ⢸⠤○ cutover         │ ⚑ no freeze during the copy
                      ⢸                   ⢸                   │   @sam, here
                      ⢸                   ○ dual-write +      │ ⚑ ask me before the cutover
                      ⠈⢧⡀                 ⢸ planned · 0/4     │   @sam, on pricing-migration
 ─────────────────────────────────────────────────────────────┴───────────────────────────
 to planner on tables, about verify-copy:  compare the totals too, not only the rows▏
```

- **`space`: say.** A line at the foot. Before it is sent, the foot says who it goes to and what it is about. While it is being read the tending session's ring turns; then its answer replaces the line: what it did, in a sentence.
- **What it did moves.** A branch that was put first travels there. One that was dropped folds into what it was under and is gone. New work grows out of its parent.
- **`⚑` is a direction that stands,** in the colour of the person who gave it. The panel lists the ones on the item and on everything above it, nearest first, each in the person's words.
- **`+` beside an item** means an agent changed it since the person last looked. The top of the screen counts them. `u` goes to the next: the foot says who did it, what, and why. `x` there puts it back.
- **Amber is unchanged:** a session that needs a person. `tab` goes to the next. A result that a direction sends to a person is asked the same way, with `a` and `x`.
- **The panel** (`a`) gains who tends the item, the directions that reach it, the result when there is one, and what happened to it with the reason for each change.
- **Someone else's branch.** A line said on a teammate's item goes to what tends it as a message from another person, not as a direction. It is theirs to approve, as mail between owners is.

### Keys

| Key | Does |
|---|---|
| `space` | say something to whoever tends the selected item |
| `u` | the next thing an agent changed since you looked |
| `x` (on a change) | put it back |
| `tab` | the next thing that needs someone, as before |
| `enter` | open the session on the item, as before |
| `n` `e` `m` `t` | gone: say it |

Everything else in the canopy is as it was.

### From a shell

```
$ pi-lattice work next
#38 card-form                    task · cards · @yan · shop
Validate number, expiry and CVC as they are typed.
Done means: wrong input is marked before submit; amex lengths are right.
Directions above it:
  ⚑ ask me before anything that moves money lands        @yan, on payments
It is yours until you say done or drop it, or go quiet for 30 minutes.
```

`pi-lattice work prime` prints what an agent needs: take with `next`, write what you learn with `note`, file what you find with `add` and say why, finish with `done` and say how you checked, give back with `drop`. One line in a repository's agent instructions is the whole integration.

## States and edges

- **Nothing tends the branch.** The foot says so and that a session is being started for it; the line is sent when it is there.
- **The line was not understood.** The session is told to change nothing and say so. Whether it does is the model's.
- **The line asks for something the scheme refuses** (a task under an epic). The answer says why not.
- **A direction and a later one disagree.** The nearer to the item wins; on one item, the later. The tending session says which it followed.
- **A person is away.** Nothing waits on them but what a direction of theirs, or an agent's doubt, sends to them.
- **No server, or it is away.** The last copy, marked stale; `space` says why it cannot be sent.
- **A lease ran out.** The issue is back with the others, and the change is marked like any other.

## What changes where

| Part | Change |
|---|---|
| `protocol` | `rank`, `result` and `directions` on an issue; `why` on an event; tree order; what a session is told (the directions above it) |
| `server` | rank kept on create and move; `next` in tree order; `done` with a result; directions written only with a person's token; leases; migration |
| `host` | who tends an item; carrying a line to it and its answer back; starting one where there is none; what each person has seen |
| `graph` | `work_done`; `why` on writes; rank in `work_update` |
| `roles` | the coordinator tends: it keeps the issues under it, answers a line in one sentence, checks results against done means, keeps what should stand |
| `app` | `pi-lattice work` and its verbs, `--json`, exit codes, `prime` |
| `canopy` | `space` and the line; `⚑`; `+` and `u`; items that move when their place changes; the panel; `n` `e` `m` `t` removed |

## Build order

1. **Say.** `space`, the line to whatever tends the item, its answer at the foot. The coordinator keeping issues with the tools it has. Tested with a real host, server and scripted model.
2. **Why, and what changed.** A reason on every write; `+` and `u`; putting a change back.
3. **Directions.** Kept on the issue, told to everything below, `⚑`, the panel. Results checked by the tending session; a gate where a direction asks for one.
4. **Order.** `rank`, `next` in tree order, items that move.
5. **The command line.** `pi-lattice work`, leases, `prime`.
6. **The keys go.** `n`, `e`, `m`, `t`.

## Decided on the way

- **One key.** The session tells an errand from a rule, and says which it took a line for.
- **A reviewer for everything but tasks.** `rules.review` in the scheme names the types whose results a session of their own checks; the rest are checked by the session tending the branch.
- **The keys go at once,** not after a trial.

## Open

- Whether a model tells an errand from a rule reliably. It needs a run with a real one.
- What a person is shown when two teammates' directions on one branch disagree.
- Whether a result that came in while no host was running should be handed on when one starts.
- Whether the command should have a shorter name than `pi-lattice work`.
- How long a lease is. Thirty minutes is a guess.
