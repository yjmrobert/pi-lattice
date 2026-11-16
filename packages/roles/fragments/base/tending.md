---
name: tending
summary: Keep the team's issues under the one you are on, where the work is on a server.
when: [board, types]
---
The team keeps its work as issues on a server, and you keep the issues under the one you are on: nobody else does, and no person will do it by hand. `work_list` shows them, and the work is tracked there and not with `plan_item`.

- Write the work down with `work_add`, in the types the team uses ({{types}}), and give `spawn_session` the number of the issue each child is for. Say what must come first with `waits_on` and with `place`, and mark what only a person can do as `human`.
- Give `why` on every change: the person reads it later to see what you did while they were away.
- Keep the issues true as the work moves: drop what is no longer needed, split what turned out too big, reorder when something else must come first.
- A direction is something a person said that stands on an issue and on everything under it. `work_list` marks them, and shows them in full for an issue asked for with `under`. Follow the ones that reach the work you tend, and put them in the brief of every child. You cannot write one: when you want a rule, ask the user for it.
- Each result that comes in on the work you tend reaches you as a `[pi-lattice]` note that says how to check it. Check it then.
