# 0042 The canopy is held to being read, in any terminal

Builds on [0024](0024-the-canopy.md) and [0030](0030-the-canopy-in-order.md). Status: built.

The first time two people used the canopy together, on two machines, one of them could not read it: the names of items were not there, only the grey `todo` under each; what was selected could not be found; a tree of a dozen items did not fit the screen; the arrows went somewhere other than expected; and the key that offers a session was not on the tree. None of it failed a test. The tests compared the screen as text at one size, and what was wrong was colour, room, and keys.

**Decision**

Each of these is now something a test holds the canopy to, so the next one is found before a person finds it.

- **Colour is read against the background it is on.** There is a palette for a dark terminal and one for a light terminal, taken from Pi's theme or named by `canopy.palette`. Less bright means nearer the background. A terminal without 24-bit colour is sent the nearest of its 256. Every colour is held to a contrast against the backgrounds a terminal of its kind is likely to have.
- **Nothing is said by colour alone.** What is selected has a mark, `▸`, between its node and its name, and a tint. Work nobody has started hangs on a quiet, unbroken line: broken into dots it read as noise on a board where nothing is started.
- **A character takes the cells a terminal gives it.** Two for wide characters and emoji, none for a mark on the one before. Every line of every screen is held to the width of the terminal as Pi measures it, and a line Pi would find too wide is cut before Pi sees it: Pi stops on one.
- **The tree draws in to fit its window.** It is the size it likes while that fits; then its levels come closer, then its columns, and names are shortened only where that makes it fit. A project of a dozen items is held to being seen whole from 80 by 24.
- **The arrows follow the tree.** Along a level, up into what is under an item, down to what it belongs to. The opposite arrow goes back where the last came from, and helpers under an item are reached. `/` goes to an item by name. Every item is held to being reached, and what is selected to staying in the window.
- **The keys agree.** `o` offers the session on what is selected and `t` asks for a teammate's, on the tree as in the list of sessions; the order of the tree is `O`. `?` lists every key, and the foot always ends with it. Every key the canopy acts on is held to being in the list, and every key at the foot to doing something where it is said.

**Not done**

- A font that draws braille badly is not something a test here can see. Ghostty, kitty and WezTerm draw it themselves.
- The mouse does nothing.
- A tree wider than the window is still scrolled, by selecting or with `shift` and the arrows; nothing is folded for the person.

**Evidence**

`packages/canopy/test/palette.test.ts` (contrast, the mark, the unbroken line), `width.test.ts` (widths against Pi's `visibleWidth`, 256 colours), `fit.test.ts` (what fits where, and no two labels on the same cells at any spacing), `move.test.ts` (every arrow on every item, and a run of 1500 keys at four sizes), `keys.test.ts` (every key a terminal can send, on every item). `test/integration/home.test.ts`, in real Pi: a light theme, read from the colours the terminal emulator holds; a session named in Chinese; the list of keys; and offering from the tree.
