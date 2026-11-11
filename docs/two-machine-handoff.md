# Manual check: handoff between two machines

The automated tests run two isolated hosts on one machine. This script checks the same thing across two real machines that can reach each other directly: the same LAN, the same VPN, or an SSH tunnel.

Call the people **A** and **B**.

## Setup, both machines

1. Check out pi-lattice and run `npm install`.
2. Check out the project you will work on. It must be a git repository with at least one commit.
3. Pick a port each, for example 47610, and make sure the other machine can reach it. `nc -vz <host> 47610` from the other side should connect once the host is running.

## Steps

1. **A** starts a tree and listens:

   ```bash
   cd ~/project
   node ~/pi-lattice/packages/host/src/cli.ts --as alice --name checkout --role coordinator --listen 47610
   ```

   If the address A's machine guesses for itself is not the one B should use (several network interfaces, a VPN address), add `--advertise <host>`.

2. **A** creates a child with its own worktree (`ctrl+n`, workspace `worktree`), lets it do some work, and has it commit.

3. **A** presses `ctrl+o`, chooses "Show my invite", and sends the invite to B.

4. **B** joins with it, without `--name`:

   ```bash
   cd ~/project
   node ~/pi-lattice/packages/host/src/cli.ts --as bob --listen 47610 --peer '<A's invite>'
   ```

   Expected on B: an empty tree. Expected on A: a notice that bob wants to connect.

5. **A** presses `ctrl+o`, chooses "Pair with bob", and reads the fingerprint to B over a call. B checks it against "Who is here" on their side. A confirms only if it matches.

   Expected on B, within a few seconds: A's sessions appear, marked `@alice`. Opening one shows its conversation, read-only. Typing into it is refused.

6. **A** selects the child (`ctrl+t`, move, then `o`), chooses "Offer ... to someone", picks bob.

7. **B** sees "alice offers you ..." at once, presses `ctrl+o`, chooses "Accept".

   Expected: on A's machine the child still belongs to alice.

8. **A** sees "bob accepted ...; confirm the release", presses `ctrl+o`, chooses "Confirm release", reads the warning, chooses "Release it".

   Expected on A: the child is marked `@bob`; typing into it is refused; it can still be opened and read.
   Expected on B: the child is B's; a worktree exists under `~/project/.lattice/worktrees/`, on the same branch, with A's commits.

9. **B** opens the child and asks what it was working on.

   Expected: it answers from the conversation it had on A's machine.

10. **A** asks the root agent to message the child.

    Expected on B: a notice that a message is waiting for approval (`ctrl+a`). The child's agent does not see it until B approves.

11. **B** quits.

    Expected on A: B's child turns grey and says offline. Opening it says bob is offline.

## Things to try on purpose

- **Cancel.** Repeat steps 6 and 7, then have B choose "Cancel the handoff". A's "Confirm release" should no longer be offered, and the node stays with A.
- **Drop the connection mid-release.** After step 7, disconnect B's network, then have A try to confirm: it should refuse, saying bob is offline. Reconnect, confirm, and pull B's cable during the transfer if you can: A should show the node as released and waiting to reach bob, and it should arrive when B is back.
- **Crash mid-handoff.** After step 7, kill A's host (`kill -9`). Restart it. The handoff should still be open and step 8 should work.
- **Changed key.** On B, delete `~/.pi/agent/lattice/identity/bob.key` and restart. A should be told that someone tried to connect as bob with a different key, and B should not get in until A deliberately accepts the new key.
- **Mail while offline.** With B offline, have A's agent message B's node. It should be delivered when B returns, and then wait for B's approval.

Record what you find, especially anything that depends on which address each machine advertises, firewalls, or path differences between the machines.
