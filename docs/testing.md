# Testing the pane by hand, with a real model

A script for trying the pane ([ADR 0015](decisions/0015-pane-design.md)) against Claude Haiku at low thinking, which is fast and cheap enough to leave several sessions running.

The automated tests use a scripted model. This is the first run with a real one, so two kinds of problem can show up: the pane doing the wrong thing, and the model not doing what the prompt asked. Each step says what the pane should show; if the model simply did not call the tool, repeat the prompt more bluntly before treating it as a pane bug.

Allow about 20 minutes. Cost is a few cents.

## 1. Set up

### Credentials

Pi has no provider configured on this machine yet. Either export the key in the shell you will start Pi from:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

or store it once (`~/.pi/agent/auth.json`):

```bash
pi auth login anthropic --api-key
```

Storing it is the safer choice here: background sessions are started by a host process, and the host only has the environment of whichever Pi started it.

### Model

See which Haiku models Pi offers and take the newest:

```bash
pi update            # refreshes the model catalogue
pi --list-models haiku
```

Pi 1.5.2 ships knowing `claude-haiku-4-5`. If the list shows `claude-haiku-5-5`, use that instead in what follows.

Make it the default, so that every session uses it, including the background ones you never start yourself. Edit `~/.pi/agent/settings.json` and add three keys, keeping the ones already there:

```json
{
  "lastChangelogVersion": "1.5.2",
  "packages": ["../../source/repos/pi-lattice"],
  "defaultProvider": "anthropic",
  "defaultModel": "claude-haiku-4-5",
  "defaultThinkingLevel": "low"
}
```

Check it:

```bash
pi auth check --provider anthropic     # prints: ready
pi -p "Reply with the single word ok"  # prints: ok
```

### The bundle

It is already installed from this checkout (`pi list` shows it). Nothing to do.

### A question-asking tool (for step 5 only)

Nothing in the bundle makes a background session ask you a yes/no question, so step 5 needs a small helper tool. Install it for the duration of the test:

```bash
mkdir -p ~/.pi/agent/extensions
cp ~/source/repos/pi-lattice/test/manual/ask-human.ts ~/.pi/agent/extensions/
```

### Two scratch repositories

```bash
mkdir -p ~/lattice-test && cd ~/lattice-test
for r in shop billing-api; do
  mkdir $r && cd $r && git init -q
  echo "# $r" > README.md && git add . && git commit -qm init
  cd ..
done
```

### Terminal

Use a terminal at least 110 columns wide and 30 rows tall. Step 8 narrows it on purpose.

## 2. The rail

```bash
cd ~/lattice-test/shop && pi
```

1. The pane is on the left and says the project has no sessions.
2. Run `/lattice`. The pane shows `◆ shop` and one session, marked `▸`.
3. Send:

   > Use spawn_session twice. First: name "payments", kind "task", brief "List the files in this directory, then send your parent a one-line summary with send_message." Second: name "cart", kind "task", brief "Write a haiku about shopping carts to cart.txt, then send your parent a one-line summary with send_message."

Check:

- [ ] Two children appear under the open session, with tree lines (`├`, `└`).
- [ ] Each shows a spinner while it works, then a dim `●` when idle.
- [ ] The kind (`task`) is at the right edge of each line.
- [ ] The footer stays on the last row and the divider between pane and chat is unbroken.
- [ ] **Colours**: the spinner is in the accent colour, idle marks are dim, and nothing is in the attention colour yet. I could not see colours in my own runs, so look closely here.

## 3. Focus and the inspector

1. Press `alt+l`.

- [ ] The chat is replaced by an inspector for the session under the cursor: state and how long, place in the tree, brief, roles, workspace, directory.
- [ ] The cursor row has a highlighted background.
- [ ] The footer lists the keys that work on the selected row.

2. Move with `↑` `↓`. The inspector follows.
3. Press `enter` on `payments`.

- [ ] Pi switches to that session and shows its history. `▸` moves to it.

4. Press `alt+l`, then `-`.

- [ ] You are back in the first session.

5. Press `alt+l` then `esc`.

- [ ] The chat is back exactly as it was and the editor accepts typing.

## 4. Messages to approve

Messages between your own sessions skip approval by default. To see the approval flow, the host has to be restarted with a different setting. Run `/lattice stop`, quit Pi (`/quit`), and start again:

```bash
cd ~/lattice-test/shop
LATTICE_APPROVAL=always pi -c
```

The pane starts the host again by itself; the host and every background session inherit the variable.

Send:

> Use spawn_session: name "totals", kind "task", brief "Send your parent the message 'Totals endpoint is live' with send_message, then stop."

Check:

- [ ] A `NEEDS YOU` section appears at the top of the pane with the message, and the session it is for shows `✉1`.
- [ ] The item is in the attention colour, and nothing else in the pane is.
- [ ] `alt+l`: the cursor starts on the item and the inspector shows the full message text.
- [ ] `a` approves it. The item disappears, the cursor lands somewhere sensible, and the open session receives the message.
- [ ] Repeat the prompt with another name, and reject with `x`. The session does not receive it.

## 5. A yes/no question

Needs the helper tool from step 1.

Send:

> Use spawn_session: name "cleanup", kind "task", brief "Call the ask_human tool with the question 'Delete cart.txt?'. If the answer is yes, delete cart.txt. Then send your parent a one-line summary with send_message."

Check:

- [ ] `cleanup` turns to `●` in the attention colour with `?1`, and the question is listed under `NEEDS YOU`.
- [ ] `alt+l`, select the question: the inspector shows it in full.
- [ ] `y` answers it without opening the session. The item goes, the session works again, and `cart.txt` is deleted.
- [ ] Run it again and answer `n`. The file (recreate it first) stays.

## 6. Creating a session from the form

1. `alt+l`, put the cursor on the top session, press `n`.

- [ ] A form replaces the chat with every field visible: name, kind, roles, workspace, brief.

2. Fill it in: name `notes`, kind `task`, choose the `worker` role (`←` `→` to move, `space` to choose), leave the workspace, brief `Write three bullet points about this repository to NOTES.md.`
3. `tab` and `shift+tab` move between fields. `ctrl+s` creates.

- [ ] `notes` appears in the tree and starts working.
- [ ] Open the form again and press `esc`: nothing is created and the chat returns.

Known gaps, not bugs: there is no preview row in the tree while the form is open, and text can only be edited at its end.

## 7. Several repositories

Leave the first Pi running. In a **second terminal**:

```bash
cd ~/lattice-test/billing-api && pi
```

Run `/lattice`, then send:

> Use spawn_session: name "invoice-export", kind "feature", brief "Write a short plan for exporting invoices as CSV to PLAN.md, then send your parent a one-line summary with send_message."

Back in the **first terminal** (shop), within a few seconds:

- [ ] `◇ billing-api` appears below `◆ shop`, with its sessions while something there is working.
- [ ] Once billing-api goes quiet it folds to one line with a count.
- [ ] `alt+l` unfolds every repository.
- [ ] `enter` on `invoice-export`: Pi moves to it, a notice says `Now in billing-api · <path>`, and `◆` is now on billing-api.
- [ ] Send `Run pwd with bash and tell me the result.` The answer is the billing-api directory.
- [ ] `alt+l` then `-`: you are back in the shop session, and `pwd` there is shop.

Then test a sleeping repository. In the second terminal, run `/lattice stop` and quit Pi.

- [ ] In the first terminal, billing-api is listed as `asleep` with a dim `○`.
- [ ] `alt+l`, cursor on it, `enter`: its host starts again and its sessions come back.

## 8. Narrow terminal

Resize the first terminal to under 90 columns.

- [ ] The side pane is gone. Two rows above the editor show this repository's sessions with the open one first, other repositories as counts, and the first waiting item if there is one.
- [ ] `alt+l` shows the pane and inspector in place of the chat; `esc` returns.
- [ ] Widen the terminal again: the side pane comes back with no leftover rows.

## 9. Under a real workload (optional)

Follow [a feature through the full lifecycle](../examples/feature-lifecycle/README.md) in `shop`. Haiku at low thinking will follow the role fragments loosely; what matters for this test is that the pane stays readable with four or five sessions changing state, and that you can always tell which one needs you.

## Clean up

Run `/lattice stop` in each Pi and quit it, then:

```bash
rm ~/.pi/agent/extensions/ask-human.ts
rm -rf ~/lattice-test
rm -f ~/.pi/agent/lattice/trees/*.json   # forgets the scratch repositories; real ones re-register when their host next starts
```

Remove the three `default…` keys from `~/.pi/agent/settings.json` if you do not want Haiku as your everyday default. Hosts left running stop by themselves after ten idle minutes.

## Reporting what you find

For anything wrong, the most useful things are: the step number, a screenshot (colours matter), the terminal size, and the tail of `<repository>/.lattice/daemon.log`.
