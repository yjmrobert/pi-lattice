# Manual check: handoff between two machines

The automated tests run two isolated hosts on one machine. This script checks the same thing across two real machines. It needs two people (or two machines), a private git repository both can push to for sharing, and the project checked out on both.

Call the people **A** and **B**.

## Setup, both machines

1. Check out pi-lattice and run `npm install`.
2. Check out the project you will work on. It must be a git repository with at least one commit.
3. Create an empty private repository for sharing, for example `git@example.com:team/lattice-share.git`. Do not reuse the project repository.

## Steps

1. **A** starts a tree and shares it:

   ```bash
   cd ~/project
   node ~/pi-lattice/packages/host/src/cli.ts --as alice --name checkout --role coordinator --share git@example.com:team/lattice-share.git
   ```

2. **A** creates a child with its own worktree (`ctrl+n`, workspace `worktree`), lets it do some work, and has it commit.

3. **B** joins, without `--name`:

   ```bash
   cd ~/project
   node ~/pi-lattice/packages/host/src/cli.ts --as bob --share git@example.com:team/lattice-share.git
   ```

   Expected: B's tree is empty, with a notice that alice joined.

4. **Both** press `ctrl+o`, choose "Trust ...", and read the fingerprint to each other over a call. Each confirms only if it matches.

   Expected: A's sessions appear in B's tree, marked `@alice`. B cannot type into them.

5. **A** selects the child (`ctrl+t`, move, then `o`), chooses "Offer ... to someone", picks bob.

6. **B** sees "alice offers you ..." within a few seconds, presses `ctrl+o`, chooses "Accept".

   Expected: on A's machine the child still belongs to alice.

7. **A** sees "bob accepted ...; confirm the release", presses `ctrl+o`, chooses "Confirm release", reads the warning, chooses "Release it".

   Expected on A: the child is marked `@bob`; typing into it is refused.
   Expected on B, after a few seconds: the child is B's; a worktree exists under `~/project/.lattice/worktrees/`, on the same branch, with A's commits.

8. **B** opens the child and asks what it was working on.

   Expected: it answers from the conversation it had on A's machine.

9. **A** asks the root agent to message the child.

   Expected on B: a notice that a message is waiting for approval (`ctrl+a`). The child's agent does not see it until B approves.

## Things to try on purpose

- **Cancel.** Repeat steps 5 and 6, then have B choose "Cancel the handoff". A's "Confirm release" should no longer be offered, and the node stays with A.
- **Crash mid-handoff.** After step 6, kill A's host (`kill -9`). Restart it. The handoff should still be open and step 7 should work.
- **Both at once.** Have A offer a node while B, from an earlier accepted handoff, hands another node back. Both should land.
- **Changed key.** On B, delete `~/.pi/agent/lattice/identity/bob.key` and restart. A should see bob's key reported as changed, and B's new activity should not be believed until A deliberately trusts the new key.

Record what you find, especially anything that depends on network latency, the git host's behaviour on concurrent pushes, or path differences between the machines.
