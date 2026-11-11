# 0016 Working in the pane: tidying, stopping, settings, and no setup step

Builds on [0015](0015-pane-design.md). Status: accepted and built.

0015 made the pane a place to see sessions and answer them. Using it for a day showed what was missing: the tree only grew, a runaway session could not be stopped without opening it, nothing said what a session was doing or what it cost, and configuration came from whichever shell happened to start the host.

**Decisions**

- **Sessions are archived, not deleted.** `d` hides a session and everything under it and stops their processes; `/lattice restore` brings them back. Nothing is removed from disk. Deleting is irreversible and there is no cheap way to be sure a branch or a conversation is not wanted, so the pane does not offer it. The session open in a terminal cannot be archived from under the person.
- **Stopping takes the key twice.** `s` on a working session asks for `s` again; any other key withdraws it. Stopping loses the step in flight, and a single key next to `d` and `r` is too easy to hit. The session stays, idle.
- **The inspector shows what a session is doing.** The host keeps the last few things each background session said and did, one line each, and reads the end of a sleeping session's file on request. The rail stays one line per session.
- **Usage is counted per session.** The host adds up tokens and cost from each assistant message. Turns in a session open in a terminal are reported by that terminal, since the host does not see them. Counting does not touch the session's "how long in this state" time.
- **Settings are a file, read at each session start.** `<repository>/.lattice/config.json` holds `model`, `thinking`, `approval` and `env`. The host reads it whenever it starts a session, so a change applies to the next one with no restart; `/lattice restart` applies it to the ones already running. A session can have its own model, which wins. Before this, all of it came from the environment of the Pi that started the host.
- **The approval setting reaches the open session over the event bus.** The messaging extension asks `lattice:approval:query`; the pane answers from the file. A flag or `LATTICE_APPROVAL` set by the person still wins. Extensions do not write to the process environment ([0014](0014-package-seams.md)).
- **A first message in a git repository starts the tree.** There is no `/lattice` step. The host starts in the background, so the message is not held up, and the state directory ignores itself in git. Outside a repository nothing starts by itself, because any directory would grow a `.lattice/`; `/lattice` still starts one there. `LATTICE_AUTO_START=0` turns it off.
- **Watching does not keep a host awake.** A terminal tells each host whether it is working in that repository or only showing it from another. A host with only watchers and nothing working stops after ten minutes, as before; it shows as asleep and `enter` wakes it.
- **One command to learn.** Everything is under `/lattice`, including what `/inbox`, `/role`, `/peers`, `/node` and `/children` do. `/lattice help` lists it; `?` in the pane lists the keys; `/lattice doctor` checks credentials, the repository, the host, the settings and the roles, and says what to do about what is wrong.
- **Something waiting rings the terminal and marks its title.** The pane is only seen when its window is. `LATTICE_BELL=0` silences the bell.

**Consequences**

- The wire protocol gained `rename`, `archive`, `archived`, `interrupt`, `tail`, `usage` and `presence`, and the state gained `activity`. A pane talking to an older host ignores the refusals; an older pane ignores the new fields.
- Archived sessions still receive mail and are woken by it. They stay hidden until restored.
- Finished sessions are not folded away by themselves. Archiving is the way to shorten the tree.
- The form edits one line of the brief at a time with `←` `→`; `↑` `↓` move between fields.
