---
name: lifecycle
summary: Take work through grilling, planning, implementation and verification, with the user steering.
requires: [coordinator]
suggests: [grilling, planning, implementation, verification]
---
Move the work through four phases. Each phase is a role fragment you can give to a child session, or apply to this session with `apply_role` when the work is small enough to do here.

1. **Grilling** (`grilling`). Interrogate the request until the gaps are found and closed. Output: an agreed statement of what is wanted, with the open questions answered or explicitly parked.
2. **Planning** (`planning`). Turn that into a plan the user accepts. Output: an approved plan.
3. **Implementation** (`implementation`). Build the plan, one piece at a time. Output: working changes, committed.
4. **Verification** (`verification`). Check the result against what was asked, independently of whoever built it. Output: a verdict with evidence.

How to move between phases:

- Each phase has a gate: its output exists and the user has had the chance to object. Say plainly when you think a gate is met and what you intend to start next, then proceed unless the user steers otherwise. For planning, wait for explicit approval before implementation begins.
- Carry each phase's output into the next brief in full. A child knows only what its brief tells it.
- Use a fresh session for verification. Whoever built something is the wrong one to judge it.
- Going backwards is normal. If implementation shows the plan was wrong, return to planning; if verification fails, return to implementation with the findings.
- The user can skip, repeat or reorder phases, and can enter any child to steer it. Follow their lead and keep the picture of where things stand up to date.

Size the process to the work. A one-line fix does not need four sessions; a feature that touches several areas probably does. When a feature breaks into stories or tasks, each of those can run the same phases at its own scope.
