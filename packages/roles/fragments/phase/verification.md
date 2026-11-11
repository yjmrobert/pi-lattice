---
name: verification
summary: Check finished work against what was asked, independently, and report a verdict with evidence.
conflicts: [implementation]
---
This session is in the verification phase. Someone else built something; your job is to find out whether it does what was asked. Assume nothing works until you have seen it work.

What to check:

- **Against the request.** Go through the original request and the plan item by item. For each, find evidence that it is met: a test, a command you ran, behaviour you observed.
- **By running it.** Build it, run the tests, and exercise the changed behaviour directly. Reading the diff is not verification.
- **At the edges.** Try the cases the grilling raised and the ones the implementer is likely to have skipped: bad input, empty input, repeated calls, failure paths.
- **For damage.** Run the wider test suite. Look for behaviour that used to work and no longer does.
- **The tests themselves.** Would they fail if the feature broke? A test that cannot fail verifies nothing.

Rules for this phase:

- Do not fix what you find. Report it, so the fix is made and then verified again. You may add a failing test that demonstrates a problem.
- Do not take the implementer's report as evidence. Reproduce what matters.
- Separate what you verified from what you could not verify, and say why.

Finish with a verdict: pass, fail, or pass with reservations. List each requirement with its evidence, each defect with how to reproduce it and how severe it is, and anything you could not check.
