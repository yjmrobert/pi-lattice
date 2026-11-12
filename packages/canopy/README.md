# @pi-lattice/canopy

All the work of a network as a tree that grows upward: the network at the root, then epics, features and stories, with tasks at the tips. It answers what the pane's list cannot: who owns each piece, which agent is on it, and how far along each branch is.

Press `c` in the pane, or run `/lattice canopy`. It takes the whole screen; `esc` gives it back.

```
 ◆ harbor  1 @yan ⠋4 ●2 19   2 @mira ⠋4 10   3 @sam ⠋4 ●1 17   4 ○@teo away ●1 4
 harbor ▸ pricing-migration ▸ new-tables ▸ tables  story
                      ⢰⠦✓ schema                              │ tables                    story
                      ⢸⠤⠋ copy                                │ @sam  ◆ shop
                      ⢸⠤⧗ verify-copy     ⢠⠤⠋ writer          │ █████░░░░░░░░░ 1 of 3 done
                     ⢀⢼⢄                  ⢸⠤○ reader          │
                     ⡇◉ tables            ⢸⠤○ flag            │ SITTING HERE
                     ⠈⢺⠊· planner · 1/3   ⢸⠤○ cutover         │ · planner  idle
                      ⢸                   ⢸                   │
                      ⢸                   ○ dual-write        │ UNDER IT
                      ⠈⢧⡀                 ⢸ planned · 0/4     │ ├ ✓ schema        landed
                        ⠙⠢⣄⡀              ⢸                   │ ├ ⠋ copy          worker, working
                           ⠉⠓⠦⣀          ⢀⡼                   │ └ ⧗ verify-copy   worker, waits on others
```

## Reading it

- **A hue is a person.** Their branches, their agents, their name. Where an item belongs to someone other than the owner of what it is under, the name is written beside it. `i` writes a letter beside everything, for reading without colour.
- **A ring is an agent.** `◉` with a ring round it means a session sits on the item; under the name is what it is there to do. The ring turns while it works. `○` means nobody is on it.
- **Amber needs someone.** A question, an approval. It is the only thing that blinks, and no person is given it. An arrow at the edge of the screen counts what needs someone out of view; `tab` goes to the next.
- **A bright branch has landed.** Dim while it grows, dotted while it is only planned.
- **A thin dotted line ties an agent to what it is working on**, when that is not the item it sits on.
- **What moves is something that happened.** A light running along the branches is a message, from the sender to the receiver. A branch lighting downward is a task that landed. A ring spreading in amber is a question that just arrived; a ring closing in on an item is a session put on it. A colour spreading along a branch is an item that changed hands. With nothing happening the screen is still. `canopy.motion` turns it down (`calm`) or off.

## Keys

| Key | Does |
|---|---|
| `←` `→` | across, to what is beside |
| `↑` `↓` | up into what is under an item, down to what it belongs to |
| `tab` | the next thing that needs someone |
| `enter` | open the session on the item in this terminal; unfold a folded item |
| `s` | put a session on a planned item |
| `f` | fold an item to one node, or unfold it |
| `1`–`9`, `0` | keep one person's colour and grey the rest; clear |
| `a` | the panel: the selected item, every agent by owner, or nothing |
| `i` | owners' letters |
| `r` | grown, or ruled with every level on one row |
| `shift` + arrows | pan. The view also follows what is selected |
| `home` | the whole tree |
| `esc` | back |

## What is in it

| File | What |
|---|---|
| `model.ts` | The work, from the state a host gives: items on levels, owners, the agent on each, progress. |
| `layout.ts` | Where everything goes, at whatever size the labels need. |
| `grid.ts` | Cells with braille dots under them. |
| `paint.ts` | A layout drawn into a grid. |
| `animate.ts` | What happened between two looks, and the path each animation takes. |
| `screen.ts` | The whole screen and what each key does. |
| `extension.ts` | The only part that knows Pi: an overlay, and the event bus. |

Everything but `extension.ts` is a function of its input and is tested as text. The package depends on `protocol` alone; it asks the pane what there is to draw over the event bus (`lattice:trees:query`) and hands anything that changes a session to `/lattice`.

Levels are the setting `canopy.levels`. See [the plan](../../docs/design/canopy-plan.md) for what is not built yet, and [0022](../../docs/decisions/0022-canopy-in-pi.md), [0023](../../docs/decisions/0023-planned-work.md) and [0024](../../docs/decisions/0024-the-canopy.md) for why it is the way it is.
