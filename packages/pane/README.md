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
- **A project with none**: the pane says so. Run `/lattice` once to start a tree from the session you are in.

| Key or command | Does |
|---|---|
| `alt+l` | Give the pane the keyboard, and back |
| `↑` `↓` | Move through what is waiting on you, then the sessions |
| `1`–`9` | Jump to a waiting item |
| `enter` | Open the selected session here; on a question, answer it with Pi's prompt |
| `y` `n` | Answer the selected yes/no question, where it is |
| `a` `x` | Approve or reject the selected message; accept or decline an offered session |
| `n` / `/lattice new` | Create a child: name, kind, roles, workspace, brief |
| `o` / `/lattice share` | Pair with someone, offer or accept a session, confirm a release |
| `-` / `/lattice back` | Go back to the session you were in before, in any repository |
| `/lattice open <name>` | Open a session by name, from any repository |
| `/lattice answer <name>` | Answer the questions a background session is waiting on |
| `/lattice approvals` | Review messages waiting for your approval |
| `/lattice status` | List the whole tree |
| `/lattice stop` | Stop the background host |

While the pane has the keyboard, the chat steps aside for an inspector: everything about what the cursor is on. For a session that is its state and how long it has been in it, its place in the tree, its brief, roles, workspace, branch and directory, and anything it is waiting on you for. For a waiting item it is the full text, with the session it concerns. The keys that act on it are listed along the bottom. `esc` puts the chat back as it was.

Marks: a spinner for working, `●` in the attention colour for waiting on you, dim `●` idle, `○` asleep or offline, `✓` finished, `✗` failed, `▸` open in this terminal, `?n` questions waiting on you, `✉n` messages to approve. The attention colour is used for nothing else.

Each session is one line. The kind is on the right, or the owner when the session is someone else's. What is waiting on you is listed above the tree. The design, with drawings of every screen, is [ADR 0015](../../docs/decisions/0015-pane-design.md).

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
- A repository whose background host has stopped is listed as `asleep`; `enter` on it starts the host again.
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

The tree for a project is kept in `<repository>/.lattice/`. Each host also records its tree in `~/.pi/agent/lattice/trees/`, which is how a terminal in one repository finds the others. The background host starts on demand and stops by itself after ten minutes with nothing to do. Its log is `.lattice/daemon.log`.

How this is built, and its limits, are in [ADR 0013](../../docs/decisions/0013-pane-inside-pi.md).
