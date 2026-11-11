# 0013 The tree lives inside Pi, as a pane

Supersedes [0006](0006-attach-model.md).

**Decision**

`pi` is the only thing a developer runs. The session tree appears as a left pane inside Pi's own interface, and the host that owns the tree runs in the background.

- **One package.** Installing the pi-lattice bundle into Pi loads the pane, messaging, roles and the tree tools.
- **The pane is there when Pi opens.** In a project that has sessions, the host is started in the background and the pane lists them, with nothing typed. In a project that has none, the pane says so and nothing else happens.
- **`/lattice` starts a tree in a project that has none**, with the open session as its first session. This is the only step a developer takes once per project.
- **A new session joins with its first message.** In a project that has a tree, a freshly opened session becomes a session of the tree when the developer first writes to it, named after what they asked. Opening Pi and closing it again adds nothing.
- **The pane** lists the hierarchy. Each session shows its name and status, who owns it, the repository it works in and its kind. `alt+l` gives the pane the keyboard; `enter` opens the selected session.
- **Opening a session takes it over.** A session file can be driven by only one process, so the host stops its headless copy and this Pi switches to that session. The developer gets all of Pi for whichever session is open: its model picker, `/tree`, autocomplete, themes, tool renderers and other extensions. Leaving a session hands it back; the host runs it headless again when it has mail.
- **Switching works at any time, including mid-turn.** A turn cannot move between processes, so it is stopped on the side being left and the agent is told, on the side taking over, to carry on. Leaving a working session puts it straight back to work in the background; opening a session that is working in the background lets it continue in the terminal. The agent sees a short note saying it was moved, marked as coming from pi-lattice and not from the user.
- **Everything else is headless.** Sessions not open in a terminal are run by the host, so children keep working while the developer is in another session, or has closed Pi.
- **The host exits on its own** after ten minutes with no terminal connected and nothing working. `/lattice` or reopening a session of the tree starts it again.
- **Flows use Pi's own dialogs**: creating a child, approving mail, answering a question a headless session is blocked on, pairing and handoff.

**Why this replaced the standalone app**

The first interface (0006) was a separate program that rendered conversations with Pi's message components. It worked, but it was a second tool to learn, and it could never have Pi's full interface: the model picker, `/tree`, autocomplete, themes, extension widgets and specialised tool renderers all live in Pi's interactive mode, not in the components. Living inside Pi removes the gap instead of chasing it.

**How the pane is drawn**

Pi's interface is a vertical stack and has no API for a side region. In fullscreen mode (Pi's default) the extension wraps Pi's layout root in a horizontal stack with the pane on the left, and re-applies the wrap whenever Pi sets its root again. This reaches into two members of the TUI object that are not part of the documented extension API (`layoutRoot`, `setLayoutRoot`).

- If they are absent (regular, non-fullscreen mode, or a future Pi that changes them), the extension falls back to a compact session list in a widget above the editor, and every action remains available through `/lattice`.
- The pane hides itself on terminals narrower than 90 columns.

**How a key press reaches a command**

Switching sessions is only allowed from a command handler. A key handler has no such context, so it submits `/lattice open <id>` through the input path, which gives it one, and which runs commands even while the agent is working.

**Who is who**

The pane's connection to the host belongs to the terminal, not to a session, so it is kept once per process and survives session switches. It authenticates by reading a token file only the same OS user can read. A session the host runs headless is marked so that the pane extension inside it stays inert.

**Evidence**

- `spikes/pane/` proved the pane and session switching inside real Pi before anything was built.
- `test/integration/pane.test.ts` drives a real Pi through `/lattice`, a spawn, opening the child (takeover), mail waking the root headless, reopening the root, quitting, resuming, creating a child through dialogs, switching away during a thirty-second step in both directions, and a fresh session finding the tree and joining it with nothing but a first message.
- A pseudo-terminal run of real Pi, with the bundle installed through `pi install`, confirmed that the pane is shown on open with nothing typed, lists the project's sessions on a second open, adds the new session on its first message, and switches sessions on `enter` while a forty-second step is running.

**Costs and limits**

- The side pane depends on undocumented TUI internals. The fallback keeps everything usable, but the side-by-side layout could break on a Pi upgrade.
- Moving a session mid-turn interrupts the step in flight: a running command is stopped and its partial output is lost. The agent is told and carries on, but it may redo that step. Work that cannot safely be repeated should be left to finish before switching.
- Quitting Pi mid-turn does not send the work to the background; the session sleeps. Only switching to another session does.
- In a project with a tree, every session that gets a message joins it. `LATTICE_AUTO_JOIN=0` turns that off.
- Reading another person's session shows its text in a read-only viewer, not with Pi's full rendering.
- The pane does not scroll. A tree taller than the terminal is cut off; `/lattice status` lists everything.
- The pane extension must load before the messaging extension, because it sets the node identity the others read at session start. The bundle manifest orders them; loading the packages one by one with `-e` must keep the pane first.
