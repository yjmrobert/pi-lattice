# 0032 A session opens over the tree

Builds on [0031](0031-pi-opens-on-the-canopy.md) and [0024](0024-the-canopy.md). Status: built.

In 0031 the chat slid in beside the tree. Two things side by side compete: the tree lost almost half its width whenever a session was open, and nothing on the screen said which of the two was the one being used. The tree is the place; a session is something opened from it and closed back into it.

**Decision**

- **The tree is the whole screen.** Nothing sits beside it.
- **A session opens in a box over the tree.** `enter` on a session grows its chat out of the node, over the tree, which is still drawn behind it at about a third of its brightness. The chat is Pi itself: its transcript, its editor, its dialogs. `alt+l` closes it back into the node. The session carries on either way.
- **The box says whose session it is.** Its top edge names the session, then its owner in their colour (with "(you)" for one's own), then what it is doing: working, needs you, waits on others, idle, done, failed. The edge itself is the owner's colour, and amber while the session waits on someone. With several people in one tree, whose session one is typing into is the first thing to know.
- **`alt+l`, not `esc`, closes it.** In Pi `esc` interrupts the agent and cancels its dialogs. A key that sometimes stops the agent and sometimes closes the box would do the wrong one at the worst moment.
- **In a terminal narrower than 120 columns** the box is the whole screen, with the same top edge.
- **Folding moves.** `f` on an item folds what is under it into it, and the rest of the tree draws in to the room that leaves; `f` again unfolds it. Over about 0.4 seconds the branches move by less than a cell at a time, because they are dots; names follow a cell at a time. A name that is going is gone before its branch has folded away, and one that is arriving is written once its branch has mostly grown. With `canopy.motion` off, or `NO_COLOR`, it changes at once.

**How**

Pi lays its screen out in rows and columns that do not overlap. The pane gives the stack that holds the tree and the box a negative gap, which puts the second over the first; the same again puts Pi's own layout over the box's frame, inside its border. The frame is opaque, so the tree does not show through where Pi draws nothing. The canopy draws the frame, because it knows the people's colours and what each session is doing, and tells the pane which cell the selected item is drawn in, which is where the box grows from.

A fold is drawn from two layouts of the tree, the one before the key and the one after (`morph.ts`). Branches are matched by what they lead to and each dot moves from where it was to where it will be; a branch that is only in one layout shrinks into, or grows out of, the nearest item above it that is in both. The window on the tree moves with them.

**Not done**

- A teammate's session cannot be opened in the box: it runs on their machine, and `enter` says so, as before. Reading it is `p`, then `enter`.
- What a session says while its box is closed is still not seen until it is opened; the tree shows that it is working or needs someone.
