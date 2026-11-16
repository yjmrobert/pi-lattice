# 0039 What agents are told is measured, and each rule has one place

Builds on [0002](0002-testing-with-faux-provider.md) and [0038](0038-roles-are-composed-in-steps.md). Status: built, and run on two models.

Three things tell an agent what to do: a tool's guidelines, a note pi-lattice sends with an event, and a role fragment. No rule said which owned what, so a rule was written wherever it seemed to belong. A child building a task was told what its report holds four times, in four wordings. And nothing closed the loop: the tests use a scripted model, which checks mechanics, and every wording was a judgement nobody checked.

**Decision**

- **Each rule has one owner.**

  | Carrier | Owns | Is in the prompt |
  |---|---|---|
  | A tool's guidelines | how to use that tool | exactly when the tool is |
  | A template | what to do about an event, with its data | when it happens |
  | A fragment | a standing stance: what you are here for, what is yours, what done means | every turn |

- **With one exception that was measured.** A rule about how to answer, which goes against a model's habit, stays in the role even when the note that arrives says it too. "Answer a person who steers in one sentence" was moved out of `coordinator`, since the `steer` note asks for exactly that. On Sonnet the answer then ran to three sentences in 3 runs of 11. Back in the role: 0 of 11.
- **A change to a fragment is checked three ways.**
  1. **As text**, in `npm run check`: the tools and facts a fragment names exist; a role's parts exist and hold no slot twice; a combination does not pass its ceiling in words; no two fragments of a combination share a sentence. `docs/roles-composed.md` is written from the fragments, so a change shows in review as the prompts it changes.
  2. **With a real model**, on demand: `npm run eval` runs scenarios, each a small piece of work given to real sessions and a list of what must then be true. A scenario says which fragments, templates and tools it tests; `--changed` runs the ones for what differs from `origin/main`; `--runs` repeats; `--compare` sets two runs side by side.
  3. **In use**: the host counts the child sessions it had to remind to report, that stopped without reporting, and whose result was sent back, and `/lattice doctor` says how many for each combination of roles and model.
- **The scenarios run on the model children usually run on and on a stronger one.** Here: Haiku 5.5 and Sonnet 5.5.

**Evidence**

- Eleven scenarios: delegation, laying out a plan, changing phase, grilling, a worker staying inside its brief, steering with an errand and with a rule, a result on a task that holds and one that does not, a review that passes and one that fails.
- Before the text was changed, three runs each: Haiku 26 of 27, Sonnet 27 of 27 (nine scenarios; the two for a result on a task were added later and passed 8 of 8 on each model with the old text). After: 33 of 33 on each.
- The one failure before: on Haiku a coordinator thanked its child for a result, in 1 run of 3. `protocol` now says a result needs no answer: 0 of 6.
- The roles of a first session went from 1100 words to 785, a task child's from 1051 to 893, a reviewer's from 755 to 684.
- The first run with a real model found three defects the scripted model could not, each fixed with a test that fails without the fix:
  - No tool showed an issue's description. The reviewer role and its brief both say to read the issue for what done means; a reviewer found nothing to check against.
  - A parent's thanks for a result made its child owe a report again. The child was reminded, sent its result twice, and was reported as having stopped.
  - A reviewer's own report counted as a new result on the issue it had just sent back, and the host started another reviewer for it: seven in a minute.
- `test/fragments.test.ts`, `test/docs.test.ts`: the checks as text. `test/integration/host.test.ts`, `work.test.ts`: the counts.

**Not verified**

- Models of other providers, and work larger than a scenario.
- That the counts from use are read by anyone. They are in `/lattice doctor` only.

**Costs**

- One pass of every scenario, three runs each, on both models: about $0.70 and under three minutes. The role packages must not be edited while it runs: each session loads them when it starts.
- Scenarios show a regression. They do not prove a wording is good.
