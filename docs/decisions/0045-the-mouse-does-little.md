# 0045 The mouse does little

Builds on [0042](0042-the-canopy-is-held-to-being-read.md). Status: built.

The canopy took keys only: 0042 says so under what was not done. A tree is something people point at, and a hand already on the mouse had to go back to the arrows to select what the eye was on. Pi reports the mouse where it has the whole screen, and gives it to whatever is drawn under the pointer, so the canopy could take as much of it as it liked: dragging the tree about, a menu at a right click, things lighting up under the pointer. That was weighed, and what was chosen is less: the mouse does what a person would try without being told, and nothing that needs learning.

**Decision**

- **A click on an item selects it.** On its node, its name, or the line under its name; a helper on its own line; a folded item anywhere along its line. The window stays where it is.
- **A second click there does what `enter` does.** It opens the session on it, unfolds it, wakes a sleeping repository. Only on what is already selected: when the tree moved between the two clicks, the second selects what is now under it and opens nothing.
- **The wheel moves the window** over a tree larger than it, and reads on in the list of keys. With `alt` it goes sideways. What is selected stays as it was. A tree that fits does not move, and the wheel is still the canopy's, so nothing behind it is scrolled.
- **Nothing is done with the mouse only.** Each of these has a key, and the list `?` shows names the mouse after the keys.
- **A click never answers what a session asks.** Where `enter` would send a waiting message, a second click opens the session and no more. An answer is a key, named under the question.
- **Everything else is left to Pi.** A click on a branch, on nothing, on the panel, or on what is written above and under the tree is not taken, and neither is another button, a drag, or the pointer moving. Dragging still selects text as it does everywhere in Pi.
- **While a line is typed, a click is not taken**, so what is written is not lost to a slip of the hand. The wheel still turns.
- **Behind an open chat the tree is only read.** The mouse is the tree's where the keys are.

**How**

`itemAt` in `screen.ts` turns a cell of the screen into what is drawn there, from the same layout, window and band under the tree that drawing uses. `interpretMouse` is to the mouse what `interpret` is to a key: it returns the next state and what to do, or nothing where the mouse is not the canopy's. The view the canopy gives the pane has `mouse` beside `key`, and the pane's layout and the canopy's own overlay hand it what Pi's `handleMouse` gives them. That is a documented part of a Pi component, unlike the layout the pane sits in (0013).

**Not done**

- No menu at a right click, no dragging the tree, nothing lit under the pointer. The pointer moving is not reported inside tmux, zellij or screen, so nothing could depend on it.
- The top, the foot, the panel and the keys under a question are not buttons.
- A wheel turned sideways, as a trackpad does, never reaches the canopy: Pi reads the wheel up and down only.
- Where Pi does not have the whole screen (`tuiMode` `regular`) it does not report the mouse, and the canopy is keys only. Asking the terminal for the mouse there would take text selection from the rest of Pi.
- A click during the moment a fold moves lands on the tree as it will be, not as it is drawn.

**Evidence**

`packages/canopy/test/mouse.test.ts`: every item and helper reached by a click on its node and on its name, at the cells the screen is written in; the window unmoved; nothing taken on empty cells, the top, the foot, the panel, the list of keys, while typing, or below the smallest size; a second click against `enter` on every item, and against a question `enter` would answer; the wheel to each edge of a tree larger than its window, on one that fits, in the list of keys, and while typing. `test/integration/home.test.ts`, in real Pi, with the mouse as a terminal reports it: a click selects, a click on nothing does not, a second click opens the session, and a click behind the open chat is left alone.
