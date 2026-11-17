# 0043 A tree too large for its window folds around your work

Builds on [0024](0024-the-canopy.md) and [0042](0042-the-canopy-is-held-to-being-read.md). Status: built.

The canopy drew every item, and scrolled what did not fit. Measured on generated projects in a terminal 200 columns wide: 505 items were 1,601 columns across, ten screens; 1,848 items were twenty-five screens, and took 58 ms a frame where a frame has 33. Width comes from the stories, each a column about twenty cells wide, so a screen held eight of them whatever the size of the project. Folding by hand gave little back: with twenty features folded the tree was still 421 wide, because folded items sat side by side. And with several people on a project, most of what was drawn was someone else's.

**Decision**

- **A folded item is one line, and the line says what is in it.** It is on the frond of what it is under, as a task is. After its name: how far along it is, how many things in it need a person, a letter in their colour for each person with an agent working in it, and how many things agents changed since this person looked. `⠋ pricing-migration 24/80 ●1 s +3`. Nothing that needs someone is out of sight for being folded.
- **Lines beside each other are one above the other.** With one thing open over an item, its lines are on the branch to that thing and take no width; what is over them is raised by the rows they need. With several things open, the lines are a column beside them, level with them, so that no branch crosses what is written.
- **A tree too wide for its window folds itself, a step at a time, until it fits.** First what is finished. Then everything but the way to this person's sessions and to what asks them. Then everything but the session open here and what asks them. A tree that fits is drawn whole, as before. What fits no way is drawn as folded as it goes, and scrolled.
- **What a person does stays done.** What they fold is folded whatever the room. What they open stays open while the rest is folded to fit, and opens one level: what is under it is lines. `enter` and `f` on a line unfold it.
- **What is selected is always something drawn.** When a narrower window or a change in the work folds it away, the line it is in is selected. `/` finds what is folded away too: the line it is in is selected while the name is typed, so the tree does not move under the letters, and `enter` opens the way to it. `tab` goes to this person's own first, then to anyone's, and to a folded line for what in it needs someone. The count at the edge of the window counts such lines.
- **Looking at a teammate opens the tree around their work.** Their number greys the rest, as before, and now the fold follows: the way to their sessions is open and one's own is folded. `0` is back.
- **Only what is drawn is laid out.** How wide a tree would be is added up before anything is placed, so a step that cannot fit costs one pass over the items.

**What it comes to**

On the same kind of generated project, read and laid out anew each frame as the extension does:

| Items | Whole | Folded, beside the panel at 120 by 36 | A frame |
|---|---|---|---|
| 505 | over 1,500 columns | 43 columns: all of it on the screen | 3 ms |
| 2,208 | 4,801 columns | 94 columns | 6 ms |
| 3,972 | not measured | 129 columns | 9 ms |

The 2,208 and 3,972 are wider than the 80 columns beside the panel because the person in them has sessions in two epics: both stay open.

**Not done**

- `u` still walks everything agents changed on the whole tree, not only what is under the selected item.
- Finished items beside each other keep a line each. A feature with forty finished stories is forty lines.
- A frond of more than twelve lines is a column of its own and as tall as it is. Nothing in it is left out or scrolled by itself.
- Under a teammate's number, what needs other people is greyed with the rest of their work, as it was before.
- How much is folded follows the room and the work with no memory: a session started somewhere can change the step, and the tree moves to its new shape.

**Evidence**

`packages/canopy/test/fold.test.ts`: the steps in order on a tree made narrower a column at a time; what stays open and what is a line; what a person folds and opens; the selection after the panel is opened and closed; lines on a branch and beside it, and the arrows through them; every item that asks, in three projects at four sizes, drawn or counted on the line it is in; 505 items within the window at three sizes; a frame of 2,208 items under 33 ms and a key under 20 ms. `move.test.ts`: going to a name that is folded away. `canopy.test.ts`: what a folded line says.
