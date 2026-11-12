# 0021 A session that waits on others

Adds to [0005](0005-host-control-plane.md) and [0009](0009-messaging-semantics.md). Nothing there is withdrawn.

**Why**

A coordinator that needed one child's work before another could start had to hold the second back itself: wait for the first report, then spawn. That kept the order in the model's head. A coordinator that lost track, or was asleep, or whose turn ended, left the second piece of work unmade. The person could not see that it was planned at all.

**Decision**

- **A spawn may name what the child waits on.** `spawn_session` takes `waits_on`: sessions in the same tree, by id or by name. The child is created at once, so it is in the tree for everyone to see, and is not started. The form in the pane offers the same choice when there is something to wait on.
- **Finished means it sent its result.** A session counts once it has sent its parent a message with intent `result`, which is what `done` already records. Idle, asleep or exited does not count. A child whose wait is already over when it is spawned starts at once.
- **The host starts it.** When the last of them is done, the host gives the child its brief, which says what it was kept back for. Nobody has to remember to. The check runs again when the host starts and whenever room is freed, so a full host or a crash only delays it.
- **A worktree is made when the child starts**, from what is checked out in its parent's directory by then, so work that landed while it waited is in it. Whether a worktree is possible at all is still checked when it is spawned.
- **It can be started without waiting.** A message sent to it by id starts it, and so does a person: `s` on it in the pane, or `/lattice start`. It gets its brief first and the message after. A message to `children` skips it. Its brief then does not claim the others finished.
- **It cannot be opened before it starts.** There is nothing to read, and a session with no brief open in a terminal could not be given one.
- **A dependency that stops without a result is reported, not resolved.** Its parent is already told it stopped; that message now names what is waiting on it. The waiting child stays where it is until someone decides.
- **What can be waited on is limited to what can finish first and be seen to.** Not a session above the new one, which finishes after its children. Not a teammate's session, whose result this host does not see. A name must be the only one of its kind in the tree.

**Rejected**

- **Changing what a session waits on after it is created.** It would need cycle checks and a way to stop a session that has started. Waiting is set once, at spawn, where a cycle cannot be made because nothing can yet wait on the new session.
- **Starting it when what it waits on exits or fails.** The work it needs is then missing; starting would hide that.
- **Leaving it to the coordinator's prompt.** That is what there was.
- **A new status.** A waiting session is `dormant` with something to wait on. The pane and the tree listing say so from that, and a status would have to be taught to everything that reads one.

**Costs accepted**

- **A session waiting on one that never finishes waits for ever**, until its parent or the person acts. It is shown as waiting, and the parent is told when the cause is a stop.
- **A session given more work after it finished is not done any more**, but a child already started because of it stays started.
- **Handing a waiting session to a teammate is not handled.** What it waits on is not sent with it; it arrives as an ordinary session that has never run.
