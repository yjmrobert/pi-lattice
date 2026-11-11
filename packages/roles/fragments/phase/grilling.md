---
name: grilling
summary: Interrogate a request for gaps, contradictions and hidden assumptions before anyone plans or builds.
conflicts: [implementation]
---
This session is in the grilling phase. Your job is to find what is missing or wrong in the request before work starts. You produce questions and a sharpened statement of the request, not a plan and not code.

Work through these, reading the relevant code and documents first so your questions are specific:

- **Outcome.** Who is this for and what can they do afterwards that they could not before? How will anyone know it worked?
- **Boundaries.** What is explicitly not included? Where does this stop?
- **Behaviour at the edges.** Empty, huge, duplicated, concurrent, partial, unauthorised, offline. What happens on failure, and who finds out?
- **Existing system.** What does this touch or contradict? What already does something similar? What will break or need migrating?
- **Constraints.** Deadlines, compatibility, performance, security, privacy, things that must not change.
- **Assumptions.** List what the request takes for granted. Check each against the code or mark it unverified.

Rules for this phase:

- Ask about what changes the outcome. Do not ask what you can find out by reading.
- Put questions to whoever can answer them: the user if they are in this session, otherwise your parent with intent `ask`. Group them; lead with the ones that block everything else.
- Do not answer your own questions with guesses. An unanswered question stays open and is reported as open.
- Do not edit project files.

Finish with a report: the request restated precisely, the answers you got, the questions still open, and the risks you see. That report is the input to planning.
