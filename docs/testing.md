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

Make it the default, so that every session uses it, including the background ones you never start yourself. Edit `~/.pi/agent/settings.json` and add three keys, keeping the ones already there. (Step 9 sets a different model for one repository's background sessions instead.)

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

1. The pane is on the left and says your next message starts a session here.
2. Send `Say hello in five words.` Within a second or two the pane shows `◆ shop` and one session named after the message, marked `▸`. You did not run any command.
3. `git status` in another terminal shows nothing new: `.lattice/` ignores itself.
4. Send:

   > Use spawn_session twice. First: name "payments", kind "task", brief "List the files in this directory, then send your parent a one-line summary with send_message." Second: name "cart", kind "task", brief "Write a haiku about shopping carts to cart.txt, then send your parent a one-line summary with send_message."

Check:

- [ ] Two children appear under the open session, with tree lines (`├`, `└`).
- [ ] Each shows a spinner while it works, then a dim `●` when idle.
- [ ] The kind (`task`) is at the right edge of each line.
- [ ] The footer stays on the last row and the divider between pane and chat is unbroken.
- [ ] **Colours**: the spinner is in the accent colour, idle marks are dim, and nothing is in the attention colour yet. I could not see colours in my own runs, so look closely here.

## 3. Focus and the inspector

Sections 3 onwards are about the pane beside the chat: set `pane.home` to `chat` first, or reach the same screen with `alt+l` then `p`. The canopy as what Pi opens on is section 3a.

1. Press `alt+l`.

- [ ] The chat is replaced by an inspector for the session under the cursor: state and how long, place in the tree, brief, roles, workspace, directory.
- [ ] The cursor row has a highlighted background.
- [ ] The footer lists the keys that work on the selected row.
- [ ] For a child, the inspector shows `used` (tokens and cost) and `RECENT` with the last things it said and did. While one is working, the last line changes as it goes.

2. Move with `↑` `↓`. The inspector follows.
3. Press `enter` on `payments`.

- [ ] Pi switches to that session and shows its history. `▸` moves to it.

4. Press `alt+l`, then `-`.

- [ ] You are back in the first session.

5. Press `alt+l` then `esc`.

- [ ] The chat is back exactly as it was and the editor accepts typing.

## 3a. Pi opens on the canopy

With `pane.home` at its default, in a terminal at least 120 columns wide, in a project that already has sessions:

1. Start `pi`.

- [ ] The canopy has the whole screen. Its last line starts with `alt+l chat` and `p sessions`.

2. Move to a session and press `enter`.

- [ ] Its chat grows out of the node into a box over the tree, and the editor accepts typing. The tree is still drawn behind it, dimmer.
- [ ] The top edge of the box names the session, its owner in their colour, and what it is doing, and ends with `alt+l tree`.

3. Send a message, then press `alt+l` while the agent works.

- [ ] The box closes back into the node and the arrows move in the tree; the session's ring keeps turning.
- [ ] Pressing and letting go of `alt+l` once closes it once. This is the check for terminals that report key releases (kitty, ghostty, wezterm).

4. Move to an item with something under it and press `f`, then `f` again.

- [ ] What is under it folds into it and the rest of the tree draws in; the item becomes one line on the frond of what it is under, and says what is in it (`⠋ payments 2/9 ●2 y`). The second `f` grows it back.
- [ ] The branches move smoothly, without a jump at the start or the end.
- [ ] With more work than the screen is wide (a second or third repository's, or a narrower terminal), the tree folds by itself: the way to your sessions is open and the rest is a line each. Nothing that needs someone is missing from the lines' `●` counts.
- [ ] `enter` on a teammate's line unfolds it one level, and it stays open when you move away. Their number in the bar at the top opens the tree around their work; `0` is back to yours.
- [ ] `/` and part of a name that is folded away selects the line it is in; `enter` unfolds the way to it.

5. Narrow the terminal below 120 columns and press `alt+l` a few times.

- [ ] The chat and the tree take turns with the whole width.

## 3b. Steering the work

This is the part no automated test covers: whether a real model does what a line said on the tree means. It needs a board (`/lattice server start`) and the canopy.

1. In a session, ask for some work to be written down: "Plan a small checkout feature as issues: an epic, two features, a story under each, and two tasks under each story. Start nothing."

- [ ] The canopy draws the issues on their levels as they are filed. The top of the screen counts what agents changed (`+N changed by agents`), and new items have `+` beside them.

2. Press `u` a few times.

- [ ] Each press goes to a changed item, and the foot of the tree says which agent did it, what, and why. The reason reads like a reason, not like the title again.
- [ ] After the last one it says that is everything, and the `+` marks and the count are gone.

3. Select the second feature and press `space`.

- [ ] The foot says who the line goes to (a coordinator and the item it sits on, or "a session that is started to tend it") and what it is about, before anything is typed.

4. Type `this first` and press `enter`.

- [ ] The foot shows your line and that it is being read, then one sentence from the session saying what it did.
- [ ] The feature moves to the left of the other, and the tree moves there, not jumps.
- [ ] `/lattice issue <its number>` shows the change as the agent's, with why.

5. On the epic, say `ask me before anything here lands`.

- [ ] The answer says it was kept as a direction. `⚑` appears beside the epic in your colour, and the panel lists it under DIRECTIONS on the epic and on everything under it.

6. On a task, say `why is this not started?`.

- [ ] It answers, changes nothing, and keeps no direction.

7. Say something that cannot be done, such as `put this task under the other epic` where there is none.

- [ ] It says what is wrong and changes nothing.

8. In another terminal, in the same repository: `pi-lattice work next --agent tester`, then `pi-lattice work done <n> --summary "did it" --check "looked"`.

- [ ] `next` prints the issue and the direction from step 5 above it. The canopy draws `tester` on that task with a ring.
- [ ] After `done`, the session tending the branch is told of the result. Because of the direction, it asks you before closing it: the item turns amber and the question is at the foot.

9. Have a session finish a story or a feature (a result on something larger than a task).

- [ ] A session named `review-<n>` appears under the one tending the branch, with the reviewer role, and closes the issue, sends it back with a comment, or asks you.

10. Press `x` on a change while walking with `u`.

- [ ] The session that tends the item is told to put it back, does, and says so.

## 3c. In another terminal, and with someone else

The automated tests hold the canopy to being read ([ADR 0042](decisions/0042-the-canopy-is-held-to-being-read.md)): colours against dark and light backgrounds, widths, what fits, the arrows, the keys. This is what they cannot see: another person's machine.

1. In a terminal with a **light** background, start `pi` in a project with sessions.

- [ ] Names are dark and read easily. What is selected has `▸` before its name and a tint behind it. Nothing is near-white.
- [ ] `/lattice config canopy.palette dark` makes it unreadable again, on purpose; `auto` puts it back.

2. Shrink the terminal to 80 by 24 with a small tree (a dozen items).

- [ ] The whole tree is on the screen, its levels closer together. The foot ends with `?  keys`.
- [ ] `?` lists every key in place of the tree; `↓` reads on; `?` closes it.

3. Move with the arrows across the tree and back.

- [ ] An arrow and then its opposite is where you started. Left and right stay on a level. `/` and a few letters of a name goes there.

4. Give a session a name in Chinese or with an emoji in it (`r` in the pane).

- [ ] Pi keeps running, the name is drawn whole or cut with `…`, and the panel's edge stays straight.

5. Start `pi` in a second repository with nothing in it, then in a directory that is not a repository.

- [ ] Both show the first repository's work. The second repository is one item, selected, with `nothing here yet`; `enter` is the chat.
- [ ] Ten minutes after the first repository goes quiet (or after `/lattice stop` there), it is one item marked `asleep`; `enter` wakes it.

6. With a teammate, on their machine: a fresh clone, `pi`, and the address from `/lattice server share` typed where the cursor is.

- [ ] The chat opens with `Joined …`, and behind it the team's issues are already drawn. `alt+l` is the tree.
- [ ] Unstarted work hangs on unbroken lines, and every name reads. If anything looks broken, a screenshot and the terminal's name are what is needed: fonts are the one thing no test here sees.
- [ ] `o` on one of your sessions offers it; `t` on one of theirs asks for it.

## 4. Messages to approve

Messages between your own sessions skip approval by default. Turn approval on for this repository:

```
/lattice config approval always
```

It applies to this session at once and to background sessions started from now on. Put this terminal behind another window before sending the next prompt, to check the bell and the title.

Send:

> Use spawn_session: name "totals", kind "task", brief "Send your parent the message 'Totals endpoint is live' with send_message, then stop."

Check:

- [ ] A `NEEDS YOU` section appears at the top of the pane with the message, and the session it is for shows `✉1`.
- [ ] The terminal bell rings, and the terminal's title starts with `● 1 waiting`. The title goes back once it is answered.
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

- [ ] A form replaces the chat with every field visible: name, kind, model, roles, workspace, brief.

2. Fill it in: name `notes`, kind `task`, leave the model empty, choose the `worker` role (`←` `→` to move, `space` to choose), leave the workspace, brief `Write three bullet points about this repository to NOTES.md.`
3. `tab` and `shift+tab` move between fields. `ctrl+s` creates.

- [ ] While you type the name, a dim row with that name appears in the tree under its parent.
- [ ] In the name, `←` moves the caret back and typing inserts there; `home`, `end`, `backspace` and `delete` behave as in any editor.
- [ ] `notes` appears in the tree and starts working.
- [ ] Open the form again and press `esc`: nothing is created, the dim row goes, and the chat returns.

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
- [ ] (Slow, optional.) Without `/lattice stop`: quit the second terminal's Pi and leave the first one open. Ten minutes after billing-api's sessions go quiet it turns to `asleep` by itself, even though the first terminal is still showing it.
- [ ] `alt+l`, cursor on it, `enter`: its host starts again and its sessions come back.

## 8. Narrow terminal

Resize the first terminal to under 90 columns.

- [ ] The side pane is gone. Two rows above the editor show this repository's sessions with the open one first, other repositories as counts, and the first waiting item if there is one.
- [ ] `alt+l` shows the pane and inspector in place of the chat; `esc` returns.
- [ ] Widen the terminal again: the side pane comes back with no leftover rows.

## 9. Tidying, stopping and settings

In `shop`:

1. `alt+l`, cursor on `notes`, press `r`, type `repo notes`, `enter`.

- [ ] The row is renamed.

2. Give a session something long: send `Use spawn_session: name "counter", kind "task", brief "Count from 1 to 300 with bash, one number per command."` Then `alt+l`, cursor on `counter` while it is working, press `s`.

- [ ] The footer of the inspector says `s again to stop`. Pressing another key withdraws it.
- [ ] `s` `s` stops it: the spinner becomes a dim `●` and a notice says it was stopped.

3. Cursor on `counter`, press `d`.

- [ ] It leaves the tree, with a notice saying how to bring it back.
- [ ] `/lattice restore` lists it; choosing it puts it back.
- [ ] `d` on the session marked `▸` does nothing, and its footer does not offer it.

4. Press `?` in the pane.

- [ ] Every key is listed where the inspector was. `?` or `esc` closes it.

5. Settings and health:

```
/lattice config model anthropic/claude-haiku-4-5
/lattice config thinking low
/lattice config
/lattice doctor
/lattice help
```

- [ ] `/lattice config` opens the settings where the chat was. `Model` and `Thinking` show what you set, marked `this repository`, and `.lattice/config.json` holds them.
- [ ] `↓` to `Bell` and `space`: it switches to off at once. `tab`: the path at the top changes to your own file. `x` on a row clears it from the file being edited. `esc` returns to the chat.
- [ ] A child created now shows that model nowhere (it is the repository's default), but one created from the form with a model typed in shows `model` in the inspector.
- [ ] `/lattice doctor` shows a tick for the model, credentials, repository, tree, host, settings and roles.
- [ ] `/lattice config thinking loud` is refused with what the setting takes.
- [ ] `/lattice restart` restarts the host and leaves you in the same session.

6. What sessions are told:

```
/lattice prompt
/role show reporting
/lattice template
```

- [ ] `/lattice prompt` opens a read-only page: the `protocol` role in full with the file it comes from, then the brief, handover, reminder and child-stopped texts.
- [ ] In the settings, `↓` past the last setting reaches the role fragments and templates. `enter` on `worker` opens it in Pi's editor; change a line and save. The row now says `yours`, and `/role show worker` prints your text. Open it again, save it empty: the row says `built in` again.
- [ ] Create a child with `n`, no roles chosen, brief `Reply here with the word done and nothing else. Do not send any message.` Its inspector shows `roles  protocol · reporting · worker`. It is reminded once that its parent is waiting; if it still sends nothing, the session you are in receives a message saying the child stopped without reporting.
- [ ] Create a child with brief `Write the word done to DONE.txt, then report.` It sends a result, and its row shows `✓`.

## 10. Under a real workload (optional)

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
