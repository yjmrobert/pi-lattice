# @pi-lattice/pane

The session tree inside Pi. A left pane lists the tree's sessions with who owns each and which repository it works in; you open any of them in this terminal and get all of Pi for it.

It is one of the extensions in the pi-lattice bundle, and that is the usual way to get it. On its own it depends only on the shared contracts: it shows the tree of any host already running for the project, and asks on the event bus for one to be started. If nothing answers, it says what is missing.

## Use it

Open `pi` in a project as usual. The pane is on the left as soon as it opens:

```
 ◆ shop                3 sessions
▸ ⠹ checkout              feature
  ├ ● payments            ✉1 task
  └ ○ impl           @sam offline
──────────────────────────────────
 alt+l to answer        1 waiting
```

- **A project with sessions**: they are listed straight away, with nothing typed. A session you just opened joins the list with your first message, named after what you asked.
- **A git repository with none**: your first message starts a tree, with that session as its root. Nothing to type.
- **Any other directory**: the pane says so. Run `/lattice` once to start a tree from the session you are in.

| Key or command | Does |
|---|---|
| `alt+l` | Give the pane the keyboard, and back |
| `↑` `↓` | Move through what is waiting on you, then the sessions |
| `1`–`9` | Jump to a waiting item |
| `enter` | Open the selected session here; on a question, answer it with Pi's prompt |
| `y` `n` | Answer the selected yes/no question, where it is |
| `a` `x` | Approve or reject the selected message; accept or decline an offered session; hand over or keep a session a teammate asks for |
| `n` | Create a child under the selected session, in one form: name, kind, model, roles, what it waits on, workspace, brief |
| `/lattice new` | The same, as a series of prompts |
| `r` / `/lattice rename <name> [new name]` | Rename a session |
| `s` `s` / `/lattice interrupt <name>` | Stop what a session's agent is doing. The key is pressed twice. The session stays, idle |
| `s` / `/lattice start <name>` | On a session that is waiting on others: start it now, without waiting for them |
| `d` / `/lattice archive <name>` | Hide a session and everything under it, and stop their processes. Nothing is deleted |
| `/lattice restore [name]` | Bring archived sessions back |
| `?` | List every key |
| `/lattice create [network] [your name]` | Start a network. Answers with the line teammates paste. Asks once what teammates should call you |
| `/lattice join <code> [your name]` | Join a teammate's network. Says who was found, or which addresses were tried and why they did not answer |
| `/lattice network` | Create a network or join a teammate's, once for every repository. Then: who is in it, the join code, what is being handed over, leaving |
| `o` / `/lattice offer <name> [person]` | Offer one of your sessions to a teammate. It is theirs as soon as they accept. Outside a network, `o` opens `/lattice network` |
| `t` / `/lattice take <name>` | Ask a teammate for one of their sessions. It is yours as soon as they approve. `t` again takes the request back. For a session in a repository that is not on this machine, the repository is cloned first, after showing you where from and where to |
| `enter` on a teammate's session | Read its conversation. While it is under the cursor, what it last did is shown beside the pane and kept up to date |
| `/lattice approve <name> [person]` | Hand a session to the teammate who asked for it |
| `/lattice release <name>` | Send a session its new owner accepted now, leaving it if it is open here |
| `-` / `/lattice back` | Go back to the session you were in before, in any repository |
| `/lattice open <name>` | Open a session by name, from any repository |
| `/lattice answer <name>` | Answer the questions a background session is waiting on |
| `/lattice approvals` | Review messages waiting for your approval |
| `/lattice status` | List the whole tree |
| `,` / `/lattice config` | Open the settings: every setting on one screen, edited in place |
| `/lattice config [user] <setting> [value]` | Show or change one setting, for this repository or (`user`) for all of yours |
| `/lattice prompt` | Show what this session is told beyond what you type, and the file each part comes from |
| `/lattice template [name]` | List or edit the texts pi-lattice writes into a session |
| `/lattice doctor` | Check credentials, the repository, the host, the settings and the roles |
| `/lattice restart` | Restart the background host, keeping your session open |
| `/lattice stop` | Stop the background host |
| `/lattice help` | List every command |

`/lattice inbox`, `role`, `peers`, `node` and `children` do what `/inbox`, `/role`, `/peers`, `/node` and `/children` do, so there is one command to remember.

While the pane has the keyboard, the chat steps aside for an inspector: everything about what the cursor is on. For a session that is its state and how long it has been in it, its place in the tree, its brief, roles, workspace, branch and directory, its model, the tokens and cost it has used, the last few things it said and did, and anything it is waiting on you for. For a waiting item it is the full text, with the session it concerns. The keys that act on it are listed along the bottom. `esc` puts the chat back as it was.

Marks: a spinner for working, `●` in the attention colour for waiting on you, dim `●` idle, `○` asleep or offline, `✓` done (it sent its parent its result) or finished, `✗` failed, `▸` open in this terminal, `?n` questions waiting on you, `✉n` messages to approve. The attention colour is used for nothing else.

Each session is one line. The kind is on the right, or the owner when the session is someone else's. A session that has not started because it waits on others says so there instead: `waits on schema`, or `waits on 2`. It starts by itself when they have sent their results, and cannot be opened until then. What is waiting on you is listed above the tree. The design, with drawings of every screen, is [ADR 0015](../../docs/decisions/0015-pane-design.md).

## Creating a session

`n` opens a form where the chat was, with every field visible at once: name, kind, model, roles, what it waits on, workspace and brief. The session it will create is drawn in the tree as you type. `tab` and `shift+tab` move between fields. In a text field `←` `→` `home` `end` move the caret, and `backspace` and `delete` work beside it; paste works. Roles are chosen from the fragments that exist (`←` `→` to move, `space` to choose, in the order you want them applied). When the tree has unfinished sessions the new one could wait on, they are offered the same way under "Waits on": with any chosen, the session is created now and starts when each of them has sent its result. The model is as `pi --model` takes it; leave it empty for the default. `ctrl+s` creates the session from anywhere in the form; `esc` cancels.

## Settings

`,` while the pane has the keyboard, or `/lattice config`, opens the settings where the chat was:

```
 Settings   changes go to  this repository   all your repositories
 /work/shop/.lattice/config.json

 BACKGROUND SESSIONS
   Model                anthropic/claude-haiku-4-5                   yours
   Thinking             not set                                    default

 ROLES
   Every session        protocol                                   default
   Every child          reporting                                  default
   First session        none                                       default
   Child with no roles  worker                                     default

 MESSAGING
 ▸ Approval             always                             this repository
 ───────────────────────────────────────────────────────────────────────────
 approval · Which messages between agents wait for you: those from other
 people's sessions (cross-owner), all of them (always), or none (never).
 ───────────────────────────────────────────────────────────────────────────
 ↑↓ move  ←→ choose  x clear here  tab yours  esc close
```

Every setting shows its value and where the value comes from, and the one under the cursor says what it does and when a change applies. A change is written at once. `tab` switches between this repository's file and your own, which every repository uses; `x` clears a value from the file you are editing, so what is under it shows again. Below the settings, every role fragment and template is a row: `enter` opens it in Pi's editor.

A value comes from the environment, then `<repository>/.lattice/config.json`, then `~/.pi/agent/lattice/config.json`, then the default. Every setting, its default and its environment variable are listed in [the settings reference](../../docs/settings.md).

In a terminal with no room beside the pane, `/lattice config` prints the settings as text; `/lattice config approval always` sets one for this repository, `/lattice config user approval always` for all of yours, and `-` as the value clears it.

## Noticing from another window

When something starts waiting on you the terminal bell rings and the terminal's title shows how many things are waiting. The `Bell` setting silences it.

## Several repositories

Each repository keeps its own tree. The pane shows all of them: the one this terminal is in first, marked `◆`, then every other repository where you have a tree, marked `◇`. What is waiting on you is listed for all of them together, with the repository each item is from.

```
 NEEDS YOU                      1
 ? pdf-renderer       billing-api
   Overwrite fixtures/invoice.pdf?
──────────────────────────────────
 ◆ shop                        ⠹1
▸ ⠹ checkout              feature
  └ ● payments               task
 ◇ billing-api              ⠹1 ●1
  ⠹ invoice-export        feature
  └ ● pdf-renderer        ?1 task
 ◇ docs-site               2 idle
```

- A repository where nothing is working or waiting folds to one line. Giving the pane the keyboard opens them all.
- `enter` on a session in another repository opens it here like any other. Pi moves to that repository: its tools, settings and project files are that repository's from then on, and a notice says where you now are. The session you left carries on in the background.
- `-` (with the pane focused) or `/lattice back` returns to the session you were in before.
- A repository whose background host has stopped is listed as `asleep`; `enter` on it starts the host again. A host stops by itself ten minutes after the last terminal working in its repository has gone and its sessions have gone quiet; a terminal that only shows it from another repository does not keep it running.
- Quitting Pi leaves your shell in the directory you started Pi from.

## Narrow terminals

Below 90 columns there is no room to keep the pane beside Pi. Two rows above the editor carry the same information: this repository's sessions with the open one first, the other repositories counted, and the first thing waiting on you.

```
  ◆ shop  ▸● checkout ✉1 │ ⠹ payments │ +3  ◇ billing-api ⠹1
  ✉ cart-api → payments  Totals endpoint is live…   alt+l to answer
```

`alt+l` still gives you the pane and the inspector, in place of the chat, until you leave them.

## What opening a session does

Sessions you are not in keep running in the background. Opening one hands it to this terminal: the background copy is stopped and Pi switches to that session, with its history. Leaving hands it back.

You can switch at any time, including while an agent is working. The step in flight is interrupted, the session moves, and the agent is told to carry on: the one you left keeps working in the background, and one that was working in the background keeps working in front of you. If a step must not be repeated (a deploy, a migration), let it finish before switching.

A session waiting on a question (a permission prompt, for example) can be answered from here without opening it.

Sessions owned by someone else open read-only, fetched from them while they are online.

## Where things live

The tree for a project is kept in `<repository>/.lattice/`. Each host also records its tree in `~/.pi/agent/lattice/trees/`, which is how a terminal in one repository finds the others. The directory ignores itself in git. The background host starts on demand and stops by itself after ten minutes with nothing to do. Its log is `.lattice/daemon.log`. `LATTICE_AUTO_START=0` stops a first message from starting a tree.

How this is built, and its limits, are in [ADR 0013](../../docs/decisions/0013-pane-inside-pi.md). The reasons behind archiving, stopping, settings and the automatic start are in [ADR 0016](../../docs/decisions/0016-working-in-the-pane.md).
