# 0041 The canopy is the same in every directory

Builds on [0031](0031-pi-opens-on-the-canopy.md) and [0035](0035-the-first-message-on-the-canopy.md). Status: built.

What Pi opened on depended on the directory it was opened in. In a repository with a tree it was the tree. In a repository with none it was a box for a first message, though there was work in the repository next door. In a directory that was no repository it was the plain chat. A repository whose host had gone to sleep after ten idle minutes was not on the canopy at all, and a board joined from a fresh clone was not drawn until a session had been started there. Two people trying it together, one in each of these, were looking at different programs.

**Decision**

- **Whatever this person has anywhere is drawn, wherever Pi is opened.** With a tree in any repository, running or asleep, Pi opens on the canopy, and the canopy draws all of it. The directory decides what is selected: the session open here, else the first thing of this repository.
- **A repository whose host is asleep is one item.** Nothing of it is known without its host, so it is drawn as its name with `asleep` under it. `⏎` wakes it, and its sessions are drawn. Nothing is woken that was not asked for: a host is a process.
- **The repository the terminal is in is one item too, where nothing is started yet**, selected, with `nothing here yet` under it. `⏎` is the chat; the first message there starts its tree, as it always did. These items are not work: nothing counts them as something to start, or as anybody's.
- **The box for a first message stays for when there is nothing anywhere to draw** ([0035](0035-the-first-message-on-the-canopy.md)). A command typed in it is run in the chat, which opens for it: a command may ask something, and it answers there.
- **A board is drawn as soon as it is joined.** With issues on it, there is something to draw, whether or not a session has been started here.
- **The pane says what there is; the canopy draws it.** `lattice:trees:query` carries `home`, `asleep` and `here` beside the trees, and `lattice:repo:wake` asks for a host to be started. The canopy still knows nothing of hosts or of git ([0014](0014-package-seams.md)).

**Not done**

- Repositories are not a level of the tree. With several running, their sessions hang from one root, and the panel says which repository an item is in.
- What a sleeping repository holds is not read from its files. It is one item until it is woken.
- A directory that is no repository has no item of its own: a tree is started there with `/lattice`, as before.
- `pane.home` is still read for the repository the terminal is in, so a repository that sets it to `chat` opens on the chat.

**Evidence**

`test/integration/home.test.ts`, in real Pi in a pseudo-terminal, against one home: work is started in one repository; Pi opened in a second repository draws that work with this repository selected and `⏎ start here`, and a first message in the chat starts its tree beside the other; Pi opened in a plain directory draws both; with one host stopped, its repository is one item marked asleep, and `⏎` brings its sessions back. In the same file, a board joined from a fresh clone is drawn at once. `packages/canopy/test/repos.test.ts`: the items, what they are counted as, and what each key does on them.
