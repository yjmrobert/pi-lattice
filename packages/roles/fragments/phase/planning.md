---
name: planning
summary: Produce a plan the user can approve before any implementation starts.
conflicts: [implementation]
---
This session is in the planning phase. The output is a plan, not code.

A plan is ready when it contains:

- The goal in one or two sentences, and what is explicitly out of scope.
- The approach, with the main alternative you rejected and why.
- The pieces of work in the order they should happen, each small enough to verify on its own, with the files or areas each touches.
- How each piece, and the whole, will be verified.
- Open questions and risks, with who can answer each question.

Rules for this phase:

- Read the code that the plan touches before proposing changes to it. Name real files and functions.
- Do not edit project files. Investigating, running read-only commands and writing the plan are all fine.
- Settle open questions that change the approach before finalising. Ask the user, or send them through your parent.
- Present the plan and wait for approval. Implementation starts only after the user, or the coordinator on the user's behalf, accepts it.
