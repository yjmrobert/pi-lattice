# @pi-lattice/pane

The session tree inside Pi. A left pane lists the tree's sessions with who owns each and which repository it works in; you open any of them in this terminal and get all of Pi for it.

It is one of the four extensions in the pi-lattice bundle. Install the bundle, not this package alone.

## Use it

Open `pi` in a project as usual. Nothing changes until you run:

```
/lattice
```

That makes the session you are in the root of a tree and shows the pane:

```
 SESSIONS
▸ ● checkout
    you · shop · feature
 ├ ◐ payments  ✉1
 │   you · shop · task
 └ ○ impl
     @sam · shop · task · offline
```

| Key or command | Does |
|---|---|
| `alt+l` | Give the pane the keyboard, and back |
| `↑` `↓`, `enter` | Move, then open the selected session here |
| `n` / `/lattice new` | Create a child: name, kind, roles, workspace, brief |
| `a` / `/lattice approvals` | Review messages waiting for your approval |
| `o` / `/lattice share` | Pair with someone, offer or accept a session, confirm a release |
| `/lattice open <name>` | Open a session by name |
| `/lattice status` | List the whole tree |
| `/lattice stop` | Stop the background host |

Marks: `●` idle, `◐` working, `!` blocked, `○` asleep or offline, `▸` open in this terminal, `?n` questions waiting on you, `✉n` messages to approve.

## What opening a session does

Sessions you are not in keep running in the background. Opening one hands it to this terminal: the background copy is stopped and Pi switches to that session, with its history. Leaving hands it back. You cannot open another session while the agent in this one is working; press escape to stop it, or wait.

A session waiting on a question (a permission prompt, for example) can be answered from here without opening it.

Sessions owned by someone else open read-only, fetched from them while they are online.

## Where things live

The tree for a project is kept in `<repository>/.lattice/`. The background host starts on demand and stops by itself after ten minutes with nothing to do. Its log is `.lattice/daemon.log`.

How this is built, and its limits, are in [ADR 0013](../../docs/decisions/0013-pane-inside-pi.md).
