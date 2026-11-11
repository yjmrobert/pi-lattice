# 0015 The pane: a rail, an inbox, an inspector, and every repository

Builds on [0013](0013-pane-inside-pi.md). Status: accepted as the destination; built in the steps listed below.

The coloured drawings of every screen are in [`docs/design/pane.html`](../design/pane.html).

**Decision**

The pane is one thing at three depths.

- **At rest it is a rail.** One line per session: tree, status, name, and on the right what is waiting on you and the session's kind. The owner is shown only when it is not you. The repository is named once, as the header of its group.
- **What needs you goes on top.** Questions a background session is blocked on, messages waiting for approval and sharing requests are listed above the tree with a line of their content. The section is absent when there is nothing.
- **With the keyboard, it shows the selected thing in full.** `alt+l` gives the pane the keyboard; the chat steps aside for an inspector showing the selected session's brief, roles, workspace and branch, or the selected item's full text. Items are answered in place: `y`/`n` for a yes/no question, `a`/`x` to approve or reject a message.
- **It covers every repository you have work in.** Sessions are grouped by repository, the one this terminal is in first. The inbox spans all of them. A repository with nothing working or waiting folds to one line.
- **`enter` goes there, whichever repository it is in.** Opening a session in another repository moves this terminal to it: Pi's tools, settings and project context follow, and a notice names where you now are. `-` returns to the session you were in before.
- **A new child is one form**, replacing five prompts in a row.
- **Below 90 columns** the same information is two lines above the editor.

Nothing waiting, one repository:

```
 ◆ shop                6 sessions
▸ ⠹ checkout              feature
  ├ ⠹ payments               task
  │ └ ⠹ stripe-webhooks      task
  ├ ● cart-api               task
  ├ ○ impl           @sam offline
  └ ○ e2e-tests            verify

──────────────────────────────────
 alt+l sessions   nothing waiting
```

Two things waiting:

```
 NEEDS YOU                      2
 ? stripe-webhooks
   Run `stripe listen`?
 ✉ cart-api → payments
   “Totals endpoint is live…”
──────────────────────────────────
 ◆ shop                6 sessions
▸ ⠹ checkout              feature
  ├ ⠹ payments            ✉1 task
  │ └ ● stripe-webhooks   ?1 task
  ├ ● cart-api               task
  ├ ○ impl           @sam offline
  └ ○ e2e-tests            verify

──────────────────────────────────
 alt+l to answer        2 waiting
```

Three repositories:

```
 NEEDS YOU                      3
 ? stripe-webhooks
   Run `stripe listen`?
 ✉ cart-api → payments
   “Totals endpoint is live…”
 ? pdf-renderer       billing-api
   Overwrite fixtures/invoice.pdf?
──────────────────────────────────
 ◆ shop                     ⠹2 ●1
▸ ⠹ checkout              feature
  ├ ⠹ payments            ✉1 task
  │ └ ● stripe-webhooks   ?1 task
  ├ ● cart-api               task
  ├ ○ impl           @sam offline
  └ ○ e2e-tests            verify
 ◇ billing-api              ⠹1 ●1
  ⠹ invoice-export        feature
  └ ● pdf-renderer        ?1 task
 ◇ docs-site               2 idle

──────────────────────────────────
 alt+l to answer        3 waiting
```

With the keyboard, cursor on a session:

```
 NEEDS YOU                      2 │ payments                                            ⠹ working · 14m
 1 ? stripe-webhooks              │ checkout › payments
     Run `stripe listen`?         │
 2 ✉ cart-api → payments          │ BRIEF
     “Totals endpoint is live…”   │ Integrate Stripe payment intents behind payments.createIntent(cart).
──────────────────────────────────│ Cover create, confirm and refund with tests.
 ◆ shop                6 sessions │
▸ ⠹ checkout              feature │ owner      you
  ├ ⠹ payments            ✉1 task │ kind       task
  │ └ ● stripe-webhooks   ?1 task │ roles      worker · implementation
  ├ ● cart-api               task │ workspace  own worktree · branch lattice/payments
  ├ ○ impl           @sam offline │
  └ ○ e2e-tests            verify │ WAITING ON YOU
                                  │ ✉ cart-api says
                                  │ │ Totals endpoint is live at /cart/totals, schema attached.
                                  │ │ a approve   x reject
                                  │
                                  │
                                  │
                                  │
                                  │
                                  │
                                  │
                                  │
──────────────────────────────────│─────────────────────────────────────────────────────────────────────
 ↑↓ move  1-2 jump  esc back      │ ⏎ open here   n new child   z sleep   h hand over   o sharing
```

Narrow terminal:

```

 › Wire the checkout flow to the new payments service

 I'll split this in two: payments takes the Stripe
 integration, cart-api exposes the totals endpoint.

 ┌ lattice_spawn
 │ payments · task · own worktree
 └ started in the background

 ┌ edit src/checkout/session.ts
────────────────────────────────────────────────────────────────────────
 ◆ shop  ▸ ⠹ checkout  ⠹ payments ✉1 │ ● stripe-webhooks ?1 │ +3
 ? stripe-webhooks Run `stripe listen`?                  alt+l sessions
────────────────────────────────────────────────────────────────────────
 › Ask anything
────────────────────────────────────────────────────────────────────────
 ~/src/shop (main)                                 sonnet · 42% context
```

**Status language**

| Mark | Means |
|---|---|
| spinner | working or starting |
| `●` in the attention colour | waiting on you |
| `●` dim | idle |
| `○` dim | asleep, or its owner is offline |
| `✓` / `✗` | finished / failed |
| `▸` | open in this terminal; it has its own column, and the cursor is a row highlight |
| `?n` `✉n` | questions and messages waiting on you |

The attention colour is used only for things waiting on a person. A working session is never shown in it. Calm states are dim. When a row runs out of room the kind goes first, then the name is cut; the attention marks are never dropped.

**Why**

The pane before this spent two lines per session, the second repeating owner, repository and kind. Idle was green and working was the warning colour, the same as the attention marks. The cursor and the open-here mark shared a column. Things waiting on the developer were a count at the bottom, handled through menus. Nothing on screen said the pane took keys. And it showed one repository, when a developer may have agents working in several.

**Switching repositories**

Each repository keeps its own tree and its own background host (`<repository>/.lattice/`). That stays. What changes is that a terminal's pane connects to every running host, found through a per-user list that each host adds itself to when it starts.

The list is one small file per tree in `<lattice home>/trees/`, so hosts never write the same file. The contracts say where an entry goes and what it holds; the host writes it and the pane reads it. The pane looks every three seconds, links to hosts that have started, and drops the ones that have stopped. A tree whose host is not running is shown as one line, and opening it starts the host.

The terminal's "home" is the repository of the session it has open. When a session from another repository is opened, the home changes with it: the pane, `/lattice new` and sharing then act on that repository.

Pi already moves with a session: `switchSession` rebuilds its runtime in the directory the session was created in. Tried against Pi 1.5.2 in RPC mode: a Pi started in one repository switched to a session from another, and its `bash` tool then ran in the other repository. The process directory does not change, so the shell Pi was started from stays where it was.

**Build order**

1. The rail.
2. The inbox, with items answered in place.
3. Several repositories, and opening a session in any of them.
4. The inspector while the pane has the keyboard.
5. The strip for narrow terminals.
6. The new-child form.

Later, and needing more from the host: what each session is doing right now, and a list of its recent events.

**Costs and limits**

- The inspector hides the chat while the pane has the keyboard.
- Every open terminal is connected to every running host, so a host stops on its own only once no Pi of this user is open anywhere and nothing in its tree is working.
- Entering a repository for the first time can raise Pi's project trust prompt.
- Quitting Pi after moving leaves the shell in the directory Pi was started from.
- An extension that reads the process directory, and not the directory Pi gives it, looks in the wrong repository after a move.

**Evidence**

- `packages/pane/test/view.test.ts` covers the drawing and the keys, which are pure.
- `test/integration/repos.test.ts` runs real Pi in two git repositories: a terminal in one opens a session of the other, its tools then run in the other repository, a child it spawns joins the other repository's tree, and `/lattice back` returns.
- A pseudo-terminal run of real Pi confirmed, in the interactive interface: the rail with its pinned footer and divider; a message waiting for approval listed with its text and approved with one key; a second repository folded to one line, opened with `enter`, the arrival notice, and `-` to return.
