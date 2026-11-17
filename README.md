# pi-lattice

Agent-to-agent messaging, session trees, composable roles and shared ownership for [Pi](https://pi.dev).

## Use it

Install it into Pi once:

```bash
pi install npm:pi-lattice
```

From a checkout of this repository, `pi install /path/to/pi-lattice` does the same from source.

Then open `pi` as you always do, in any directory. Where you have sessions, in this repository or any other, Pi opens on the canopy: all the work as a tree, the same one wherever you opened it, with the session you open in a box over it.

- `enter` on a session opens its chat over the tree, with all of Pi. The top of the box says whose session it is and what it is doing. `alt+l` closes it back into the tree. The session carries on either way.
- The arrows move over the tree: along a level, up into what is under an item, down to what it belongs to. `/` goes to an item by part of its name. What is selected has `▸` before its name.
- `f` folds what is under an item into it, and the tree draws in; `f` again unfolds it. A tree that does not fit the terminal draws in by itself before anything has to be scrolled to.
- `?` lists every key, and the foot of the screen always ends with it.
- Colour says whose a piece is, a ring that an agent is on it, amber that it needs someone. `tab` goes to the next thing that does, and what it asks is drawn under the tree with the keys that answer it (`y`/`n`, `a`/`x`). `o` is always among them: type something else instead, and the session reads that rather than an answer.
- `p` lists the sessions in a pane instead, where they are made, stopped, archived and answered:

```
 ◆ shop                3 sessions
▸ ⠹ checkout              feature
  ├ ● payments            ✉1 task
  └ ○ impl           @sam offline
──────────────────────────────────
 alt+l to answer        1 waiting
```

- To open on the chat with that pane always on its left, as before, set `pane.home` to `chat` (`,` in the pane, or `/lattice config`). Then `alt+l` gives the pane the keyboard and `c` opens the canopy.
- In a git repository there is nothing to set up: Pi opens on an empty canopy that says your first message starts the tree, and you type or paste it there. With work in another repository already, that work is drawn and this repository is one item on it, selected: `enter` is the chat, and your first message there starts its tree. Each new session joins with its first message. Elsewhere, run `/lattice` once.
- What needs you is listed above the tree: questions a background session is stuck on, messages to approve. `alt+l` gives the pane the keyboard, and you answer them where they are (`y`/`n`, `a`/`x`, or `o` to say something else instead).
- With the keyboard, the chat steps aside to show the selected session in full. `enter` opens it in this terminal, with all of Pi. You can switch at any time, even mid-turn: the work you leave carries on in the background.
- `n` creates a child session from one form. Agents can also delegate on their own. Children run in the background, each on the model you choose. A child can be told to wait on others: it shows in the tree at once and starts by itself when they have finished.
- `c` opens the canopy: all the work as a tree, the team at the root and tasks at the tips. Colour says whose a piece is, a ring that an agent is on it, amber that it needs someone. Work can be planned before anyone is on it; `s` puts a session on a planned item.
- A project too large for the screen folds around your work: the way to your sessions is open, and everything else is one line each that says how far along it is, what in it needs someone, and whose agents are in it. `enter` unfolds a line; a teammate's number opens the tree around theirs.
- `/lattice server start` starts a board on your machine, where work is tracked as issues: epics, features, stories, tasks and bugs by default, or whatever structure you define with `/lattice scheme edit`. There is nothing to deploy. The canopy then draws the issues, with the sessions on them.
- Agents keep the issues: they file them, break them down, order them, take the next one that is ready, check each other's results and close them. You do not edit issues. You say what you want: `space` on anything in the tree opens a line to the session tending that branch ("this first", "drop this", "ask me before anything here lands"). It changes the work to match and answers in a sentence at the foot of the tree. A line that is a rule stays on the item as a direction (`⚑`), and every session working under it is told.
- `+` beside an item means an agent changed it since you last looked. `u` goes through what changed, with who did it and why; `x` there puts it back.
- Agents that are not Pi sessions use the same work from a shell: `pi-lattice work next` takes the next ready issue and prints its brief and the directions above it; `pi-lattice work prime` prints what to put in such an agent's instructions.
- `/lattice server share` opens your board to teammates and prints the address they join with (`/lattice server <address>`); it is there while your machine is on. For a machine that stays on, run `pi-lattice server` on it instead and have everyone join that.
- `r` renames a session, `d` archives it, `s` stops what it is doing. `?` lists every key, and `/lattice help` every command.
- `,` in the pane, or `/lattice config`, opens the settings: models, roles, limits and the pane itself, for this repository or for all of yours. `/lattice doctor` checks the setup.
- Sessions are told how to talk to each other, and you can read and change all of it: `/lattice prompt` shows what a session has been told and the file each part comes from.
- Work in several repositories shows on one canopy and in one pane, whichever of them the terminal is in. A repository whose host has gone to sleep is one item; `enter` wakes it. Opening a session from another repository moves this terminal there; `-` goes back.
- Once you and a teammate are on the same server, their sessions show in your pane with nothing more to set up, in every repository you share, and the pane's first line says who is around. What teammates are running in repositories you do not have is listed too; a session under the cursor is kept up to date as it goes. `o` offers one of yours to a teammate and `t` asks for one of theirs, on the tree or in the pane, cloning the repository first if you do not have it. The offer and the request go through the server; the session itself goes straight from one machine to the other, so both of you must be online and your machines must be able to reach each other. The server never sees a conversation.

See the [pane readme](packages/pane/README.md) for keys, and [a feature through the full lifecycle](examples/feature-lifecycle/README.md) for a walkthrough.

## What is here

| Package | What it does |
|---|---|
| [`pane`](packages/pane/README.md) | Pi extension. The session trees of every repository as a left pane inside Pi, and the `/lattice` command. |
| [`canopy`](packages/canopy/README.md) | Pi extension. All the work as a tree that grows upward: who owns each piece, which agent is on it, how far along it is. `c` in the pane. `space` says what you want about any item to whatever tends it. |
| [`a2a`](packages/a2a/README.md) | Pi extension. Sessions message each other; inbound mail can require human approval. Also works alone ([try it](examples/minimal-two-agents/README.md)). |
| [`roles`](packages/roles/README.md) | Pi extension. Compose a session's role from markdown fragments and change it mid-session. Also works alone ([guide](docs/roles.md)). |
| [`graph`](packages/graph/README.md) | Pi extension. Lets an agent spawn child sessions and see the tree. |
| [`host`](packages/host/README.md) | Library. Owns the tree and runs the sessions you are not in. |
| [`collab`](packages/collab/README.md) | Library. Shares trees between the people of a team, machine to machine, with signed ownership handoff. |
| [`app`](packages/app/README.md) | Everything assembled: the Pi package, the launcher, the background host, the command line. |
| `protocol` | The contracts everything else shares: envelope, events, wire types, state machines. |

Each package depends only on `protocol` and works on its own; `app` is the one place they are put together. A test enforces this ([ADR 0014](docs/decisions/0014-package-seams.md)).

## Documentation

- [Architecture](docs/architecture.md)
- [Decisions](docs/decisions/README.md)
- [Testing by hand with a real model](docs/testing.md)
- [Envelope specification](docs/envelope-spec.md)
- [Settings, roles files and environment variables](docs/settings.md)
- [Roles](docs/roles.md)
- [Roles, as composed](docs/roles-composed.md)
- [Ownership and handoff](docs/leases.md)

## Development

```bash
npm install
npm run check          # typecheck and tests
npm run dev            # open Pi on this checkout, in a scratch repository under .dev/ (-- --faux for the scripted model)
npm run eval           # the scenarios with a real model: what sessions did, checked against what their roles say (spends tokens)
npm run docs           # rewrite docs/settings.md from the settings table, and docs/roles-composed.md from the role fragments
npm run build          # build the package that is published into dist/pi-lattice
npm run spike:phase0   # re-run the Phase 0 verification against real Pi processes
```

Requires Node 22.19 or newer and git. Tests and spikes run real Pi processes against a scripted model: no network, no tokens, and they do not read your Pi configuration. The canopy is also held to being read: its colours to a contrast on dark and light backgrounds, every line to the width of the terminal, a small project to fitting it, and every key to being listed ([ADR 0042](docs/decisions/0042-the-canopy-is-held-to-being-read.md)). The tests of the pane in Pi's terminal interface need `script` (util-linux) for a pseudo-terminal and are skipped where it is missing.

### Releasing

Pushing to `main` releases. GitHub Actions works out the next version from the [conventional commits](https://www.conventionalcommits.org) since the last release:

| The commits since the last release include | The next version |
|---|---|
| a breaking change (`feat!:`, or a `BREAKING CHANGE:` footer) | a major version; a minor one while the version is `0.x` |
| a `feat` | a minor version |
| a `fix` or a `perf` | a patch |
| only `docs`, `test`, `chore`, `ci`, `refactor` and the like | nothing is released |

The workflow runs the whole suite on the pushed commit, builds the package, publishes it to npm, tags the commit `v1.2.3` and writes a GitHub release that lists the features and fixes. Nothing is committed back, so there is nothing to pull afterwards: the version is in the tags, not in a `package.json`. To see what the next push would release:

```bash
node scripts/release.ts
```

## Not done yet

- **Models of other providers, and larger work.** The mechanics are tested against a scripted model. Whether a model does what the roles, the notes and the tool guidelines say is checked with eleven small scenarios on Claude Haiku 5.5 and Sonnet 5.5, which pass ([ADR 0039](docs/decisions/0039-what-agents-are-told-is-measured.md)). Nothing has been run on another provider's models, or on work the size of a real feature. [The hand test](docs/testing.md) has the steps for the pane.
- **Two real machines.** Sharing is tested with two isolated hosts on one machine ([manual script](docs/two-machine-handoff.md)).
- **Sharing across arbitrary networks.** The two machines must reach each other directly (LAN, VPN, SSH tunnel). Hole-punching is not built ([ADR 0012](docs/decisions/0012-peer-to-peer-collab.md)).
- **The side pane relies on Pi internals.** It falls back to a compact list if they change ([ADR 0013](docs/decisions/0013-pane-inside-pi.md)).
- **Licence.** None has been chosen.
