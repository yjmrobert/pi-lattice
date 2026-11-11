# A feature through the full lifecycle

A coordinator session takes a feature through grilling, planning, implementation and verification, using a child session per phase. You can enter any of them and steer.

## Run it

In the project you want to work on (a git repository with at least one commit, so implementation children can get worktrees):

```bash
node /path/to/pi-lattice/packages/host/src/cli.ts --name checkout --role coordinator,lifecycle,feature
```

Then tell the root session what you want:

> Build one-click checkout for returning customers. Start with grilling.

What to expect:

1. The coordinator spawns a **grilling** child (`worker + grilling`). It reads the code and comes back with questions. Open it from the tree (`ctrl+t`, select, `enter`) and answer there, or answer through the coordinator.
2. With the gaps closed, the coordinator spawns a **planning** child (`worker + planning`). It produces a plan and waits. Approve it, or say what to change.
3. The coordinator spawns one or more **implementation** children (`worker + implementation`), each in its own worktree on a `lattice/...` branch.
4. A fresh **verification** child (`worker + verification`) checks the result and reports a verdict.

Nothing in this sequence is enforced by code. The fragments describe the gates; you can skip a phase, repeat one, or change a session's roles mid-flight:

```
/role remove planning
/role add implementation
```

## Things to try

- Open the grilling child while it is working and add a constraint. The coordinator adapts when the report arrives.
- Create a child yourself with `ctrl+n` and pick its roles.
- Quit with `ctrl+c` twice and start the host again: the tree and every conversation are still there.

## What has been checked

`test/integration/lifecycle.test.ts` runs this flow end to end against a scripted model: the coordinator spawns the four phase children in order with the right roles, each reports through the broker, each output is carried into the next brief, and implementation happens in its own worktree. It checks the mechanics. It does not check how well a real model follows the fragments; that needs a run with your model and your judgement of the result.
