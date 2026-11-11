# Manual check: handoff between two machines

The automated tests run two isolated hosts on one machine. This script checks the same thing across two real machines that can reach each other directly: the same LAN, the same VPN, or an SSH tunnel.

Call the people **A** and **B**.

## Setup, both machines

1. Check out pi-lattice, run `npm install`, and install the bundle into Pi: `pi install /path/to/pi-lattice`.
2. Check out the project you will work on. It must be a git repository with at least one commit.
3. Pick a port each, for example 47610, and make sure the other machine can reach it. `nc -vz <host> 47610` from the other side should connect once sharing is on.

## Steps

1. **A** opens `pi` in the project, runs `/lattice`, then `/lattice share` and accepts port 47610. The invite is shown.

   If the address A's machine guesses for itself is not the one B should use (several network interfaces, a VPN address), stop the host (`/lattice stop`) and start it by hand with `pi-lattice daemon --listen 47610 --advertise <host>`.

2. **A** creates a child with its own worktree (`alt+l`, `n`, workspace `worktree`), lets it do some work, and has it commit.

3. **A** sends the invite to B.

4. **B** opens `pi` in their checkout, runs `/lattice`, then `/lattice share`, turns sharing on, and chooses "Pair using someone's invite".

   Expected on A: the pane says bob wants to pair.

5. **A** runs `/lattice share`, chooses "Pair with bob", and reads the fingerprint to B over a call. B checks it against "Who is here". A confirms only if it matches.

   Expected on B, within a few seconds: A's sessions appear in the pane, marked `@alice`. Opening one shows its conversation read-only.

6. **A** selects the child in the pane (`alt+l`, move), presses `o`, chooses "Offer ... to someone", picks bob.

7. **B** sees "alice offers ..." in the pane at once, runs `/lattice share`, chooses "Accept".

   Expected: on A's machine the child still belongs to alice.

8. **A** sees "confirm ... → bob" in the pane, runs `/lattice share`, chooses "Confirm release", reads the warning, confirms.

   Expected on A: the child is marked `@bob`; it can still be opened and read, not run.
   Expected on B: the child is B's; a worktree exists under `~/project/.lattice/worktrees/`, on the same branch, with A's commits.

9. **B** opens the child (`alt+l`, select, `enter`) and asks what it was working on.

   Expected: Pi switches to that session, and it answers from the conversation it had on A's machine.

10. **A** asks the root agent to message the child.

    Expected on B: the pane shows a message to approve. The child's agent does not see it until B approves (`/lattice approvals`).

11. **B** quits Pi and stops the host (`/lattice stop` before quitting).

    Expected on A: B's child is marked offline. Opening it says bob is offline.

## Things to try on purpose

- **Cancel.** Repeat steps 6 and 7, then have B choose "Cancel the handoff". A's "Confirm release" should no longer be offered, and the node stays with A.
- **Drop the connection mid-release.** After step 7, disconnect B's network, then have A try to confirm: it should refuse, saying bob is offline. Reconnect, confirm, and pull B's cable during the transfer if you can: A's pane should show it is still sending, and it should arrive when B is back.
- **Crash mid-handoff.** After step 7, kill A's host (the pid is in `.lattice/host.json`). Run `/lattice status` so it restarts. The handoff should still be open and step 8 should work.
- **Changed key.** On B, delete `~/.pi/agent/lattice/identity/bob.key` and restart the host. A should be told bob's key changed, and B should not get in until A deliberately accepts the new key.
- **Mail while offline.** With B's host stopped, have A's agent message B's node. It should be delivered when B returns, and then wait for B's approval.

Record what you find, especially anything that depends on which address each machine advertises, firewalls, or path differences between the machines.
