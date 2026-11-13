# 0030 The canopy in order

Builds on [0024](0024-the-canopy.md). Status: built.

The canopy drew the items under one in the order they were filed, and every unfinished wait as a dashed arc between the two. With more than a few waits the arcs crossed each other and the labels, and nothing said which work could go ahead.

**Decision**

- **Left to right is first to last, at every level.** Under each item, what must come first is on the left. On a frond, the last level, it is at the bottom, nearest the stem: the tree grows upward.
- **A wait between two items is a wait between the siblings they are under.** Where the paths of the two part, the one that holds the waiting item comes after the one that holds what it waits on. So a feature moves right because one story in it waits on a story elsewhere. A wait on something above or below oneself orders nothing.
- **Where nothing says: finished, started, not started, held, then as filed.** Read left to right, the tree is past to future. An item moves only when its state does.
- **A circle of waits is drawn anyway.** The first of them, as filed, goes first.
- **Order replaces the arc where it can.** `›` stands between two limbs side by side when the second waits on the first, and dims when the first is finished. Two tasks on one frond get no mark: the one that waits is above, with `⧗`. Only a wait that reaches into another branch, or past a sibling, is still an arc.
- **Held is drawn.** An unfinished item is held when something it waits on is unfinished, or what it is under is held. With nobody on it, it is dim, and a task's mark is `⧗`. `⧗2` after a name counts the unfinished items that wait on it.
- **What can be taken is found, not labelled.** A tip nobody is on and nothing holds reads like work, not dim; `.` goes to the next one, and the header counts them and what is held. A word beside each would be on most of a tree that has no waits.
- **`o` switches, `canopy.order` chooses.** `dependency` is the default; `filed` is the tree as it was, with held work still drawn as held.
- **It is part of the world.** `order.ts` works the order out once, when the world is built, from the same waits the server uses for `work_next`. An issue keeps its place after what it waited on once that is finished.

**Not done**

An item that changes place is not animated: it is drawn where it now belongs. Sessions on no issue stay at the foot, unordered.

**Evidence**

`packages/canopy/test/order.test.ts`: the order under an item, the lift across branches, the tie-break, a circle, the frond, the mark and the missing arc, held work, and the keys. `test/work.test.ts`: an issue stays after what it waited on. The stored drawings in `test/snapshots/` are in order.
