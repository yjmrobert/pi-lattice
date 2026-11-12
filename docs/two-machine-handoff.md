# Manual check: a team across two machines

The automated tests run isolated hosts on one machine. This script checks the same thing across two real machines that can reach each other directly: the same LAN, or the same VPN.

Call the people **A** and **B**.

## Setup, both machines

1. Check out pi-lattice, run `npm install`, and install the bundle into Pi: `pi install /path/to/pi-lattice`.
2. Check out the same project on both. It must be a git repository with at least one commit, and a full clone, not a shallow one.

There is no port to choose. If a firewall asks whether to let `node` accept connections, allow it.

## Steps

1. **A** opens `pi` in the project and runs `/lattice server start`, then `/lattice server share`.

   Expected: a line to send, `/lattice server http://<A's address>:<port>/#<code>`, one for each network A's machine is on.

2. **A** creates a child with its own worktree (`alt+l`, `n`, workspace `worktree`), lets it do some work, and has it commit.

3. **A** sends that line to B over a channel they trust.

4. **B** opens `pi` in their checkout and pastes the line for the network both are on. B is asked what to be called. If both machines log in with the same user name, B must answer with a different name than A's.

   Expected on B, within a few seconds: "Joined ...", then "Found A", and A's sessions appear in the pane, marked `@A`. Opening one shows its conversation read-only. If A is not found, `/lattice team`, "Look for teammates again" shows each address that was tried and why it did not answer; record that.
   Expected on A: a note that B joined. A did nothing.

5. **B** moves to A's child in the pane (`alt+l`, move) and presses `t`.

   Expected on B: the session is marked `asked`.
   Expected on A, at once: "B asks for ..." above the tree.

6. **A** presses `a` on the request, reads what will be sent, and confirms.

   Expected on A: the child is marked `@B`; it can still be opened and read, not run.
   Expected on B, with nothing more to do: the child is B's; a worktree exists under `.lattice/worktrees/` in B's checkout, on the same branch, with A's commits.

7. **B** opens the child (`enter`) and asks what it was working on.

   Expected: Pi switches to that session, and it answers from the conversation it had on A's machine.

8. **B** goes to another session, selects the child, presses `o` and picks A. **A** presses `a` on the offer.

   Expected: the child is A's again, with nothing more for B to do.

9. **A** asks the root agent to message a session B owns (repeat step 5 and 6 first so that B owns one).

   Expected on B: the pane shows a message to approve. The agent does not see it until B approves.

10. **B** quits Pi and stops the host (`/lattice stop` before quitting).

    Expected on A: B's sessions are marked offline. Opening one says B is offline.

## Things to try on purpose

- **A server that stays on.** Run `pi-lattice server` on a third machine and have both join that instead. Expected: the same, and A's machine can be off without B losing the team's work.
- **A wrong address.** A sets `LATTICE_ADVERTISE` to an address where nothing listens and runs `/lattice restart`. Expected on B: A's sessions do not appear in the pane, though the canopy shows them on the server's work; `/lattice team`, "Look for teammates again" names the address and "nothing is listening there".
- **Another repository.** On both machines, open `pi` in a second project both have. Expected: each sees the other's sessions there too, with nothing more to set up.
- **A repository only one of you has.** B opens `pi` in a project A does not have, and starts a session. Expected on A: the pane's first line names B; after A's own repositories there is the project's name with "not here"; with the pane focused, B's session is under it. A moves onto it: what it last did shows beside the pane, and changes as B's session works. A moves away, B's session works some more, A moves back: it has caught up.
- **Take with a clone.** A presses `t` on that session. Expected: A is asked once which folder to clone into, shown the address B's checkout has as `origin`, and after confirming the project is cloned there and B sees A's request. B approves; the session is A's, in the clone. Note whether the clone needed credentials and how that went.
- **A repository kept private.** B sets `network.share` off for one repository (`,` in the pane, on this repository's settings). Expected on A: that repository's sessions disappear from the pane, and B's other repositories stay.
- **A third person.** C joins with the same line. Expected: C sees both A's and B's sessions, with nobody doing anything. With the server on A's machine and A's machine off, C cannot join; note what C is told.
- **Open in a terminal.** A opens a session, B asks for it, A approves from another terminal's pane. Expected: A's pane says it goes when A leaves it, and it does.
- **Decline and withdraw.** B asks; A presses `x`. B is told, and nothing moved. B asks again, then presses `t` again: the request disappears from A's pane.
- **Away.** B asks, then stops their host. A approves. Expected: nothing moves until B is back, then it does by itself.
- **Drop the connection mid-release.** After A approves, pull B's cable during the transfer if you can: A's pane should show it is still sending, and it should arrive when B is back.
- **Changed key.** On B, delete `~/.pi/agent/lattice/identity/<B>.key` and restart the host. A should be told someone connected as B with a different key, and B should not get in until A accepts the new key in `/lattice team`. Note also what the server says to B: it refuses a second key under one name.
- **Someone without the code.** A third machine that joins the server's address with the code changed should be refused, see nothing and appear nowhere.
- **Mail while offline.** With B's host stopped, have A's agent message B's node. It should be delivered when B returns, and then wait for B's approval.
- **VPN.** Repeat steps 1 to 6 with the machines on different networks joined by a VPN. If the address a machine gives the server is not the one the other should use, set `LATTICE_ADVERTISE` to its VPN address and restart the host (`/lattice restart`).
- **Reachable server, unreachable machines.** Put the server where both reach it, and the two machines where neither reaches the other. Expected: each sees the other's sessions on the server's work and in the canopy; an offer arrives and can be accepted; the session does not move until the machines can connect.

Record what you find, especially which addresses each machine gave the server, firewalls, and path differences between the machines.
