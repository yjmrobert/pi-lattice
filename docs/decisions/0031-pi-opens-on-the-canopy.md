# 0031 Pi opens on the canopy

Builds on [0013](0013-pane-inside-pi.md), [0015](0015-pane-design.md) and [0024](0024-the-canopy.md). Status: built.

Pi opened on one session's chat, with the others listed in a pane beside it and the canopy a key away. With several sessions working, the chat of one of them is the wrong thing to open on: what matters first is which of them needs someone, and the chat of that one comes second.

**Decision**

- **The canopy is what Pi opens on.** Where there is a tree, the canopy takes the screen and the keyboard. Where there is none yet, Pi opens on the chat as it always did, and the canopy arrives on its left when the first message starts a tree; the keyboard stays where the person is typing.
- **A session's chat slides in from the right.** `enter` on a session opens it in this terminal, as before, and its chat, which is Pi itself with its editor and its dialogs, comes in beside the tree with the keyboard. The tree stays, so what the other sessions do is still seen while one is talked to.
- **`alt+l` moves the keyboard between the tree and the chat.** From the tree, `esc` slides the chat away. The session carries on either way: closing its chat stops nothing.
- **The divider is lit on the side that has the keyboard**, as it was beside the pane, and the canopy lists only `alt+l tree` while the keys are not its own.
- **Something a session waits on is answered on the tree.** Selecting a session that waits on a person draws what it waits on under the tree, in full: a question, a message to approve, an offer. The keys that answer it are drawn with it (`y`/`n`, `a`/`x`), and mean that and nothing else while it is there; `tab` goes to the next session that waits. A question that needs more than one key (a choice, a line of text) is answered with `enter`, through Pi's own dialogs in the chat.
- **The pane says what the keys are and carries them out.** `lattice:waiting:query` and `lattice:waiting:answer`: the canopy is given the text and the keys from the same table the pane's own footer is drawn from, and hands a key back. So the two cannot differ, and the canopy still knows nothing of hosts.
- **`p` in the tree opens the pane's screen**: the sessions as a list, the new-session form, stopping, archiving, the settings.
- **Below 120 columns the two do not share the screen.** Whichever has the keyboard has all of it. Below the canopy's floor of 60 by 20, Pi opens on the chat with the pane, as before.
- **`pane.home` chooses.** `canopy` is the default; `chat` is everything as it was: the chat, the pane on its left, the canopy opened with `c`.
- **The pane keeps the layout; the canopy is asked for a view.** `lattice:canopy:mount` on the event bus: the pane gives the terminal, what `enter` and `esc` should do, and the keys it adds, and gets back something that draws and reads keys. The canopy still imports nothing of the pane ([0014](0014-package-seams.md)). It is asked again in each session, since a session's extensions end with it; what was selected is kept by the pane across them.
- **The chat slides in a few steps.** Each step wraps the conversation again at a new width, so it moves most of the way at once and then settles. With `canopy.motion` off, or `NO_COLOR`, it does not slide.

**Found on the way**

A terminal that speaks the kitty keyboard protocol reports a key's release as well as its press, and what an extension is given by `addInputListener` comes before Pi filters releases out. Letting go of `alt+l` was read as a second press, and the keyboard went into the pane and straight back. Releases are now dropped there.

**Not done**

- What a command says (`notify`) is written in the chat, and is not seen while the chat is closed. A command run from the pane's keys opens the chat for that reason; the canopy's own (`n`, `e`, `m`, `t`) say what they are doing on its last line.
- The width of the chat is a share of the terminal, not a setting.

**Evidence**

`test/integration/home.test.ts`, in real Pi in a pseudo-terminal: the tree beside the chat once there is one, the keyboard moving with `alt+l` and a key's release not counting as a press, `esc` closing the chat and `enter` bringing it back, a background session opened beside the tree, `p` and the new-session form, a message waiting for approval drawn under the tree and approved there with `a`, opening on the tree when one already exists, and a narrow terminal giving each the whole width. `packages/canopy/test/screen.test.ts`: what is asked is drawn under the tree with its keys, the keys answer and keep their own meaning otherwise. `test/integration/tui.test.ts` runs with `pane.home` set to `chat` and covers the pane as it was.
