# 0035 The first message is written on the canopy

Builds on [0031](0031-pi-opens-on-the-canopy.md) and [0032](0032-a-session-opens-over-the-tree.md). Status: built.

Pi opened on the canopy only where there was a tree. In a git repository with none, where the first message starts one, Pi opened on the plain chat, with nothing to say that the canopy existed, why it was not there, or that the next message would bring it. Someone trying the canopy in a new repository saw the chat and took the canopy to be broken.

**Decision**

- **Where the first message would start a tree, Pi opens on the canopy.** That is a git repository with `pane.autoStart` and `pane.autoJoin` on, or a repository whose tree has nothing in it yet. Elsewhere, Pi still opens on the chat, as before.
- **The canopy says what is missing and takes the message.** It draws the repository's name, "Your first message starts the tree", and a box to write it in. Every key is for the message: there is nothing on the tree to move to, so letters are text, not keys, and `p` does not open the pane. Pasted text keeps its lines, and the box grows with it and shows its end. `⏎` sends, `shift+⏎` adds a line, `esc` clears, `alt+l` opens the chat over the empty canopy as usual.
- **The message is sent as the session's own**, as if typed into Pi's editor, so the tree starts the way it always did: the pane's `before_agent_start` launches the host and adopts this session as the root. Nothing new happens on the host. A line starting with `/` is run as a command and leaves the canopy waiting for a message.
- **Until the tree is there, the canopy says it is starting**, with the message dimmed in the box. If no tree comes, because the host could not start, or 30 seconds pass, the message is put back to send again and the foot says `/lattice doctor` will say why.
- **The pane says when; the canopy draws it.** `lattice:canopy:mount` carries `first()`: the repository's name and whether a tree is being started for it, or nothing. The canopy knows nothing of hosts or of git ([0014](0014-package-seams.md)).

**Not done**

- Trees of other repositories that are running are not drawn on this screen; `alt+l` then `/lattice` reaches them. This repository has nothing yet, and the screen is about that.
- The box is not an editor: there is no cursor to move and no history. A long message written by hand is better written in the chat (`alt+l`).

**Evidence**

`test/integration/home.test.ts`, in real Pi in a pseudo-terminal: a git repository with no tree opens on the canopy with the hint; letters, `p` among them, go into the message; a bracketed paste keeps its lines; `⏎` starts the tree with that message, the canopy draws it, the tree is kept in the repository, and the session's chat shows the message. `packages/canopy/test/first.test.ts`: writing, pasting, sending and clearing the message, wrapping, the end of a long message shown, and the screen once it is sent.
