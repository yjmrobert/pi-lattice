# Manual check: a network across two machines

The automated tests run isolated hosts on one machine. This script checks the same thing across two real machines that can reach each other directly: the same LAN, or the same VPN.

Call the people **A** and **B**.

## Setup, both machines

1. Check out pi-lattice, run `npm install`, and install the bundle into Pi: `pi install /path/to/pi-lattice`.
2. Check out the same project on both. It must be a git repository with at least one commit, and a full clone, not a shallow one.

There is no port to choose. If a firewall asks whether to let `node` accept connections, allow it.

## Steps

1. **A** opens `pi` in the project, sends a message so the tree starts, and runs `/lattice network`. A chooses "Create a network" and names it `team`.

   Expected: a join code, `team.<secret>@<A's addresses>`.

2. **A** creates a child with its own worktree (`alt+l`, `n`, workspace `worktree`), lets it do some work, and has it commit.

3. **A** sends the join code to B over a channel they trust.

4. **B** opens `pi` in their checkout, sends a message, runs `/lattice network`, chooses "Join with a teammate's code" and pastes it.

   Expected on B, within a few seconds: A's sessions appear in the pane, marked `@A`. Opening one shows its conversation read-only.
   Expected on A: a note that B joined `team`. A did nothing.

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

- **Another repository.** On both machines, open `pi` in a second project both have. Expected: each sees the other's sessions there too, with no code and no setup.
- **A third person.** C joins with the code A gave B, while A's machine is off. If C is on the same LAN as B they find each other anyway; over a VPN they do not until C has met someone, so C should use a code from someone who is online ("Show the join code").
- **Open in a terminal.** A opens a session, B asks for it, A approves from another terminal's pane. Expected: A's pane says it goes when A leaves it, and it does.
- **Decline and withdraw.** B asks; A presses `x`. B is told, and nothing moved. B asks again, then presses `t` again: the request disappears from A's pane.
- **Away.** B asks, then stops their host. A approves. Expected: nothing moves until B is back, then it does by itself.
- **Drop the connection mid-release.** After A approves, pull B's cable during the transfer if you can: A's pane should show it is still sending, and it should arrive when B is back.
- **Changed key.** On B, delete `~/.pi/agent/lattice/identity/<B>.key` and restart the host. A should be told someone connected as B with a different key, and B should not get in until A accepts the new key in `/lattice network`.
- **Someone without the code.** A third machine that joins a different network named `team` should see nothing and appear nowhere.
- **Mail while offline.** With B's host stopped, have A's agent message B's node. It should be delivered when B returns, and then wait for B's approval.
- **VPN.** Repeat steps 1 to 6 with the machines on different networks joined by a VPN. If the address A's machine puts in the code is not the one B should use, set `LATTICE_ADVERTISE` to the VPN address on A and restart the host (`/lattice restart`).

Record what you find, especially which addresses ended up in the join code, firewalls, whether the machines found each other by beacon or by the code, and path differences between the machines.
