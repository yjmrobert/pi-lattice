# 0023 Planned work, and what a session is working on

The model under [the canopy](../design/canopy-plan.md). Adds to [0021](0021-waiting-on-other-sessions.md); nothing there is withdrawn. Status: accepted and built.

**Why**

The tree held sessions. Work that nobody had started was not in it, so a plan lived in a coordinator's head, and a view of the work had nothing to draw but who was running. And nothing said which piece a coordinator was attending to at a given moment.

**Decision**

- **An item can be planned.** A node with `planned` set has no session and has not been given its brief. Nothing starts it but a person (`s` in the pane, `/lattice start`) or a message sent to it by id. Until then it cannot be opened. Starting it clears `planned`.
- **A plan is laid out by one session.** `plan_item` puts an item in the tree; `under` names the item it belongs to, which must be the session asking or something below it. `spawn_session` takes `under` too, so a task can start two planned items down.
- **Levels are a setting.** `canopy.levels`, by default `epic feature story task`. Kinds stay free-form.
- **A report passes the items nobody is on.** "parent" means the nearest session above. A task under a planned story answers the session above the story, and that is who its brief names, who reminds it, and whose answer marks it done. Otherwise a report would have to wake a session on every item it passed.
- **Planned items are not sessions for the limits.** The limit on sessions in a tree counts what runs. A tree may hold ten planned items for each session it may run, and an item cannot be started once the tree runs as many sessions as it may. Depth and children per item are limited as before.
- **The host says who just wrote to whom.** The state carries `traffic`: sender, recipient, intent and time for the last ten seconds, never the text.
- **The host says what a session is working on.** The state carries a `focus` per session: the item below it that it last placed, wrote to, or heard from. It is read from what the session does through the host, not asked of it, so a session open in a terminal is covered the same way. It is left out after five minutes. Writing upward is not a focus: a worker reporting is still on its own task.

**Rejected**

- **A separate store of work items.** Ownership, sharing, archiving and the pane would each have needed a second path. A planned item is a node, and gets all of it.
- **A status for planned.** As with waiting: it is `dormant` with a reason, and a status would have to be taught to everything that reads one.
- **Starting a planned item when its children report.** It would put a session on every level of a plan the moment a task finished.
- **Asking agents what they are working on.** They would forget, and "who is on what" would be a guess.

**Costs accepted**

- **A focus is coarse.** It moves only when a session does something through the host. A coordinator reading files about one story while its last message went to another is drawn on the other. Whether an agent should also be able to say so is left open in the plan.
- **Planned items are not told to teammates as planned.** A teammate sees one as a session that has never run. Sharing the plan is for the phase that puts the canopy on the network.
- **A planned item that waits on others** does not start when they finish. Planned wins: someone starts it.

**Evidence**

`test/integration/host.test.ts`, "planned work": items planned and started through a host with real Pi processes, laid out under each other, reports passing the items nobody is on, the limits, a model planning and starting an item with a message, and the focus and traffic in the state. `packages/pane/test/view.test.ts` covers what the pane shows and `s`.
