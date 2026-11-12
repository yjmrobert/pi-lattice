# 0024 The canopy

Builds on [0022](0022-canopy-in-pi.md) and [0023](0023-planned-work.md). Status: the first part is built; [the plan](../design/canopy-plan.md) lists the rest.

**Decision**

- **A package of its own, `canopy`**, depending on `protocol` alone. The pane stays the small, always-on view where things are answered; the canopy is opened from it with `c` and takes the whole screen.
- **It asks for what to draw.** `lattice:trees:query` on the event bus: the pane, which holds the connections to the hosts, fills in every tree it has and the session open here. The canopy asks again at each look and keeps no connection of its own. `lattice:canopy:open` is how the pane asks for it; without the package nothing claims the request and the pane says so.
- **What changes a session goes through `/lattice`.** Opening a session and putting one on a planned item are commands the pane already has. The canopy closes before a session is opened, because that switches the terminal.
- **Everything but the overlay is a function of its input.** The work model, the layout, the grid of cells and dots, the painter, the animations and the screen with its keys know nothing of Pi, and are tested as text: a tree in, characters out, compared with a stored file.
- **Height is the level of the work.** An item is above its parent. The last level is a frond: its items listed one above the other on a stem, so a story's tasks cost width once, not once each.
- **Grown, not ruled.** Each item sits a little above or below its level's line by an amount computed from its id, so the tree looks like one and still draws the same way every time. `r` rules it.
- **The tree is as big as its labels need; the screen is a window.** The window moves as little as it takes to keep what is selected in view, and pans with shift and the arrows. Below 60 columns by 20 rows the canopy says what it needs and draws nothing.
- **Three channels that never share.** A hue is a person. A ring is an agent. Amber is "needs someone", is given to no person, and is the only thing that blinks.
- **A helper is not a level.** A session whose kind is not in `canopy.levels`, or is not deeper than what it is under, hangs on the item it serves and is not counted as work.

- **What moves is what happened.** The canopy compares each look at the world with the last. A message runs along the branches from sender to receiver; a finished task lights its branch down to its parent, and on through every item that completes; a question spreads one amber ring; a planned item grows out of its parent; a session arrives on an item as a closing ring; a change of hands sweeps the new colour along the branch. Opening the canopy plays nothing. `canopy.motion` is `full`, `calm` (only working agents and amber move) or `off`; `NO_COLOR` means off.

**Not built yet**

Answering in place; zoom, the map and find; following an agent; the fallback to box characters and to fewer colours; the pixel renderer. A teammate's planned items still arrive as sessions that never ran.

**Evidence**

`packages/canopy/test`: the model, the grid, the layout's rules (a child above its parent, no two labels on one cell, the same drawing every time), the screen and every key, with the mockup's tree as the fixture and its drawing stored in `test/snapshots/`. `test/integration/tui.test.ts` opens the canopy from the pane in real Pi, moves in it, and returns.
