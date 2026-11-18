# @pi-lattice/canopy

All the work of a team as a tree that grows upward: the team at the root, then epics, features and stories, with tasks at the tips. It answers what the pane's list cannot: who owns each piece, which agent is on it, and how far along each branch is.

It is what Pi opens on wherever you have work, in any directory: every repository's sessions on one tree ([ADR 0041](../../docs/decisions/0041-the-canopy-is-the-same-in-every-directory.md)). A repository whose host is asleep is one item, and `enter` wakes it; the repository you are in, where nothing is started yet, is one item too, and `enter` there is the chat your first message goes in. Where Pi opens on the chat instead (`pane.home`), press `c` in the pane, or run `/lattice canopy`: it takes the whole screen, and `esc` gives it back.

When you have joined your team's server (`/lattice server <address>`), the tree is the team's issues, on the levels of the team's own scheme. An item's colour is whoever it is assigned to, and the ring round it is the colour of whoever's session is on it. Sessions on no issue are drawn at the foot. Without a server, the tree is the sessions themselves and the items planned among them.

Agents keep the issues; you steer. `space` on an item opens a line at the foot of the tree, to the session tending that item and about that item. The foot says who it goes to before you send it. Say what you want ("this first", "split this by provider", "drop it", "why is this held") and that session changes the work and answers there in one sentence. Nothing tends the branch yet: a session is started for it. `s` still puts the session open in your terminal on the selected issue.

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
- **What is selected has `▸` before its name**, and a tint behind it. Nothing is said by colour alone.
- **A bright branch has landed.** Dim while it grows, and a quieter line while it is only planned.
- **It is drawn for the terminal it is in.** Colours for a dark background or a light one, as Pi's theme is (`canopy.palette` says otherwise); the nearest of 256 colours where the terminal has no more; and names in any script, each character as wide as the terminal draws it.
- **It fits where it can.** The tree is the size it likes while the terminal has room; then its levels come closer together, then its columns, and names are shortened only where that makes it fit.
- **Too large for that, it folds around your work.** First what is finished is folded; then everything but the way to your sessions and to what asks you; then everything but the session open here. What you fold stays folded, and what you unfold stays open. A project of five hundred items is on one screen this way. What is still too large is scrolled.
- **A folded item is one line that says what is in it.** `⠋ pricing-migration 24/80 ●1 s +3`: something in it is being worked on, 24 of its 80 tasks have landed, one thing in it needs a person, sam's agents are in it, and agents changed three things since you looked. `enter` unfolds it one level. The lines are read up the branch to what is open, or stand in a column beside it.
- **What is finished can be left out.** `d` leaves it out of whatever is open: a finished task from its story, a story with everything landed from its feature. `✓3` after a name counts what is left out under it, and the top of the screen counts all of it. What still has something in it for someone stays: a thing that asks, an agent at work, the session open here. `d` again draws it all.
- **Left to right is first to last.** What must come first is on the left, at every level, and at the bottom of a story's tasks, nearest the stem. An item that waits on another comes after it, and so does everything it is under. Where nothing says, what is finished comes first, then what has started, then what has not, then what is held. `O` puts everything back as it was filed.
- **`›` between two items** means the second waits on the first; it dims once the first is finished. A wait that reaches into another branch is a dashed arc.
- **Dim with `⧗` is held.** Something it waits on is unfinished, or what it is under is held. `⧗2` after a name counts what waits on that item. What nobody is on and nothing holds is there to be taken: `.` goes to the next, and the top of the screen counts both.
- **A thin dotted line ties an agent to what it is working on**, when that is not the item it sits on.
- **`⚑` is a direction that stands.** Something a person said that is a rule and not an errand ("ask me before anything here lands") is kept on the item in their words, in their colour. Everything under the item is told it. The panel lists the directions that reach the selected item, nearest first.
- **`+` is something an agent changed since you looked.** The top of the screen counts them. `u` goes to the next, and the foot says who did it, what, and why. `x` there puts it back: a line to whatever tends it. Past the last one, you have looked.
- **An agent in a shell is a ring too.** One that took an issue with `pi-lattice work next` is drawn on it by name. It is not a session, so there is nothing to open.
- **What moves is something that happened.** A light running along the branches is a message, from the sender to the receiver. A branch lighting downward is a task that landed. A ring spreading in amber is a question that just arrived; a ring closing in on an item is a session put on it. A colour spreading along a branch is an item that changed hands. With nothing happening the screen is still. `canopy.motion` turns it down (`calm`) or off.

## Keys

| Key | Does |
|---|---|
| `←` `→` | along a level: to the nearest item of the same level, or for a task, a task on the next stem |
| `↑` `↓` | up into what is under an item, down to what it belongs to; down reads through an item's helpers first. The opposite arrow goes back where the last one came from |
| `/` | go to an item by part of its name, or an issue by its number; `tab` goes on to the next, `enter` stays, `esc` goes back. It finds what is folded away too: the line it is in is selected, and `enter` unfolds the way to it |
| `tab` | the next thing that needs someone: yours first, then anyone's. A folded line stands for what in it does |
| `.` | the next thing that is there to be taken: nobody on it, nothing holding it |
| `O` | first to last, or as filed |
| `o` | offer the session on the item to a teammate |
| `t` | ask a teammate for the session on the item |
| `space` | say what you want about the item, to whatever tends it |
| `u` | the next thing an agent changed since you looked; `x` there puts it back |
| `enter` | open the session on the item in this terminal; unfold a folded item, one level; wake a sleeping repository; on the repository you are in with nothing started, the chat |
| `s` | put a session on a planned item, or the session open here on an issue |
| `f` | fold an item to one line, or unfold it. Either stays as you left it when the tree is folded to fit |
| `d` | leave what is finished out of what is open, so that what remains is what is read, or draw it again |
| `1`–`9`, `0` | look at one person: their colour is kept and the rest greyed, and a folded tree opens around their work; clear |
| `a` | the panel: the selected item, every agent by owner, or nothing |
| `i` | owners' letters |
| `r` | grown, or ruled with every level on one row |
| `shift` + arrows | pan. The view also follows what is selected |
| `home` | the whole tree |
| `?` | every key, in place of the tree; the foot always ends with it |
| `esc` | back |

## The mouse

It does little, and nothing that a key does not do.

| | Does |
|---|---|
| click | select the item under it: on its node, its name, or the line under its name |
| click again | what `enter` does on it: open its session, or unfold it |
| wheel | move the window over a tree larger than it; sideways with `alt`. In the list of keys, read on |

A click anywhere else is not the canopy's, so text is still selected by dragging as everywhere in Pi. A click never answers what a session asks. Pi reports the mouse where it has the whole screen (`tuiMode` `fullscreen`, its default); in `regular` the canopy is keys only ([ADR 0045](../../docs/decisions/0045-the-mouse-does-little.md)).

## What is in it

| File | What |
|---|---|
| `model.ts` | The work, from the state a host gives: items on levels, owners, the agent on each, progress. |
| `order.ts` | What comes first: the order under each item, what waits on what, what is held. |
| `layout.ts` | Where everything goes: at the size the labels need, drawn in to fit the window where it can, and folded around this person's work where it cannot. What is finished, when it is left out. |
| `grid.ts` | Cells with braille dots under them. |
| `paint.ts` | A layout drawn into a grid. |
| `animate.ts` | What happened between two looks, and the path each animation takes. |
| `screen.ts` | The whole screen and what each key does. |
| `extension.ts` | The only part that knows Pi: an overlay, and the event bus. |

Everything but `extension.ts` is a function of its input and is tested as text. The package depends on `protocol` alone; it asks the pane what there is to draw over the event bus (`lattice:trees:query`) and hands anything that changes a session to `/lattice`.

Levels are the setting `canopy.levels`; the order the canopy opens in is `canopy.order`, and whether it opens with what is finished left out is `canopy.finished`. See [the plan](../../docs/design/canopy-plan.md) for what is not built yet, and [0022](../../docs/decisions/0022-canopy-in-pi.md), [0023](../../docs/decisions/0023-planned-work.md), [0024](../../docs/decisions/0024-the-canopy.md), [0030](../../docs/decisions/0030-the-canopy-in-order.md), [0043](../../docs/decisions/0043-a-large-tree-folds-around-your-work.md) and [0044](../../docs/decisions/0044-what-is-finished-can-be-left-out.md) for why it is the way it is.
