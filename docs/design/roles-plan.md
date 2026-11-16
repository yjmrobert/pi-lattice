# Roles: composed in steps, one owner per rule, measured

What the role instructions needed next, and how it was built. Status: built, all six phases. The decisions are [0038](../decisions/0038-roles-are-composed-in-steps.md), [0039](../decisions/0039-what-agents-are-told-is-measured.md) and [0040](../decisions/0040-a-type-of-issue-names-its-roles.md), which have the evidence; [what differed from this plan](#what-differed-when-it-was-built) is at the end. It builds on [0003](../decisions/0003-roles-as-prompt-sections.md), [0017](../decisions/0017-settings-and-orchestration.md) and [0036](../decisions/0036-a-board-is-tended.md), and keeps what [the roles guide](../roles.md) says a role is: a list of fragments, chosen by a person or a coordinator, changeable at any time.

## What was looked at

Every built-in fragment, `packages/roles/src`, the templates in `packages/protocol/src/templates.ts`, the tool guidelines in `packages/graph/src/extension.ts`, how the host gives roles out, and `scripts/eval.ts`.

| # | Finding | Where |
|---|---|---|
| 1 | `apply_role` replaces the whole list unless told otherwise, and `lifecycle` tells a coordinator to change phase with it. One call with `["planning"]` takes `protocol`, `coordinator` and `reporting` off the session. | `packages/roles/src/extension.ts:263`, `fragments/base/lifecycle.md:7` |
| 2 | No fragment has been run against a real model. The host sees the failures (a child reminded, a child that stopped without reporting) and counts none of them. | `README.md:109`, `host.ts` `afterTurn`, `tellParent` |
| 3 | A fragment is all or nothing, so what depends on the setup is written as prose branches. `coordinator` has three ("when `plan_item` is available", "when the team has a server", "when `spawn_session` is available") in 13 bullets. `protocol` gives every leaf worker a section on delegating while `task` says not to split further. | `fragments/base/coordinator.md`, `protocol.md` |
| 4 | The same rule is said in several fragments in different words. A default implementation child is told the shape of its report four times (`reporting`, `worker`, `implementation`, `task`). "A report is a claim" is in three, "the brief must stand on its own" in two, and again in the guidelines of `spawn_session`. | the fragments, `graph/src/extension.ts:101` |
| 5 | What to do about an event is said twice: in the standing fragment, and in the template that arrives with the event. `result` and `steer` restate two of the longest `coordinator` bullets. | `protocol/src/templates.ts` |
| 6 | Fragments are fixed text. `coordinator` names "epic, feature, story, task", but `canopy.levels` and the team's scheme are settings, so a team with other types is told the wrong ones. | `coordinator.md:11` |
| 7 | Which roles suit which work is prose in the guide. The coordinator has to remember that a task wants `worker + implementation + task`. `suggests` is parsed and read by nothing. | `docs/roles.md`, `roles/src/fragments.ts` |
| 8 | A person's change to a role is a full copy of the file. The first match by name wins, so a later improvement to the built-in never reaches them, and nothing says so. | `roles/src/fragments.ts` `loadFragments` |

## Analysis: three causes

**Composition has one operation.** Fragments are joined in list order. There is no way to say *one of these* (a phase), *made of these* (a coordinator), *only when* (there is a board), *with this value* (the team's types), or *on top of that one* (my addition to `worker`). Findings 1, 3, 6 and 8 are each a missing operation, worked around in prose or not at all.

**Three things carry instructions and no rule says which owns what.** A tool's guidelines, a template sent with an event, and a role fragment all tell the agent what to do. With no rule, each new behaviour was written into all the places it seemed to belong. That is findings 4 and 5.

**Nothing closes the loop.** The scripted model checks mechanics. Wording is changed on judgement and never checked. That is finding 2, and it is why 3 to 5 cannot be fixed safely yet.

## Design

### Principles

1. **A role stays a list of fragments.** No agent types, no enum. Every addition below is one optional line of frontmatter. A fragment written today works unchanged.
2. **Small pure steps, composed.** Each operation is one function from data to data, tested alone. Reading files and asking Pi happen at the edge, as `config.ts` and `templates.ts` already do it.
3. **Structure by files, values by names.** Whether a paragraph applies is decided per fragment. Inside a fragment only values are filled in. A fragment stays something a person can read and edit whole.
4. **One owner per rule.** A table below says which carrier says what.
5. **No wording change without a before and an after.**
6. **The seams hold.** `roles` still imports only `protocol` and still works alone ([0014](../decisions/0014-package-seams.md)).

### The steps

```
files ──layer──▶ catalog                                  (finding 8)
applied names ──expand──▶ ──select──▶ ──render──▶ sections
                (parts)    (when)     (values)             (3, 6)
applied names ──edit(op)──▶ applied names                  (1)
```

```ts
// packages/roles/src/compose.ts: all pure
type Facts = Readonly<Record<string, string>>;           // a fact holds when it is not empty
type Catalog = ReadonlyMap<string, Fragment>;

layer(files: FragmentFile[]): Catalog                    // builtin, then user, then project
expand(applied: string[], catalog: Catalog): Fragment[]  // a fragment, then its parts; once each; cycles ignored
select(fragments: Fragment[], facts: Facts): Fragment[]  // drops those whose `when` does not hold
render(fragment: Fragment, facts: Facts): string         // renderTemplate from protocol, reused
roleSections = (applied, catalog, facts) => sectionsOf(select(expand(applied, catalog), facts).map(render))
editRoles(current, op, names, catalog): EditResult       // now knows slots and `keep`
```

`roleSections` keeps its name and its output shape, so [0003](../decisions/0003-roles-as-prompt-sections.md) is untouched: one section per fragment, and Pi patches only the sections that changed.

### Frontmatter

| Key | Status | Means |
|---|---|---|
| `name`, `summary` | as now | |
| `requires`, `conflicts` | as now | advisory notes |
| `slot: phase` | new | at most one fragment per slot is applied; adding one takes the other off |
| `keep: true` | new | a `set` leaves it applied; only `remove` and `clear` take it off |
| `includes: [a, b]` | new | applying this applies its parts after it; they are not listed separately |
| `when: [board]`, `unless: [board]` | new | applied only while every fact in `when` holds and none in `unless` does |
| `mode: append` | new | in a person's or project's file: add this body to the one beneath, do not replace it |
| `base: <hash>` | new, written by `/role edit` | what a full copy was copied from, to tell when the built-in has moved on |
| `suggests` | removed | read by nothing; replaced by roles per issue type |

### Editing: slots and keep (finding 1)

| Operation | Now | Proposed |
|---|---|---|
| `add planning` | appended | appended, and `grilling` (same slot) is taken off |
| `set worker task` | everything else removed | everything else removed except fragments marked `keep` |
| `remove protocol` | removed | removed: naming it is explicit |
| `clear` (a person only) | all removed | all removed |
| `apply_role` with no mode | `set` | `add` |

Built-ins: `protocol` and `reporting` get `keep: true`. The four phases get `slot: phase`, the three scopes `slot: scope`, and `coordinator`, `worker`, `reviewer` get `slot: stance`. Every `conflicts` line in the built-ins today is between two fragments of one slot, so they all go. `lifecycle` then reads: "apply the next phase with `apply_role`; it takes the place of the one before."

### Parts and conditions (finding 3)

`coordinator` becomes a short core that includes its parts. The name still means the whole role, so `roles.root`, the host's `crownRoot` and every existing session keep working.

```markdown
---
name: coordinator
summary: Break work down, delegate it, track it, and report upward.
slot: stance
includes: [plan-items, tending]
---
```

```markdown
---
name: tending
summary: Keep the issues under the one you are on.
when: [board]
---
```

```markdown
---
name: plan-items
summary: Lay the work out on the tree before starting it.
when: [tool.plan_item]
unless: [board]
---
…each with a kind that says its level ({{levels}})…
```

A part is an ordinary fragment: it can be applied alone, shown, and changed by a person without touching the rest of `coordinator`.

### Facts (findings 3 and 6)

A fact is a name and a text. One flat table, one rule (empty means it does not hold), shared with templates.

| Fact | From | Example |
|---|---|---|
| `tool.<name>` | the roles extension, from Pi's registered tools | `tool.spawn_session` |
| `board` | the host: a server is joined | `yes` |
| `levels`, `types` | the host: the scheme's types, or `canopy.levels` without a board | `epic, feature, story, task` |
| `issue`, `name`, `kind`, `parent.name` | the host: the session's node | `38` |

They are gathered the way settings and the prompt inspector already are: an ask-and-fill event, `lattice:facts:query`, in `protocol/src/events.ts`. The roles extension asks before each turn and adds the tool facts itself. The graph extension, which already holds the session's connection to its host, fills in the rest from one new host request. Alone, with no host, only tool facts exist, and every built-in that uses a host fact is guarded by `when`, so it is simply not applied.

Facts are things that stay put for a session. No status, no time. When one does change (a board is joined), the sections that mention it are patched and the rest of the prompt cache stands.

### Layers (finding 8)

`layer` goes through the roots from the built-in up. A file with `mode: append` adds its body to what is beneath; any other file replaces it, as now.

- `/role edit worker` opens an **addition** by default: an empty file with `mode: append`. "In this repository, run `npm run check` before you report" is three lines, and the built-in keeps improving under it.
- `/role edit worker replace` makes the full copy, with `base:` set to a hash of the body it copied.
- A copy whose `base` no longer matches the built-in is marked in `/role list`, `/role show`, `/lattice prompt` and `/lattice doctor`: "your copy replaces a built-in that has changed since".

### Which carrier says what (findings 4 and 5)

| Carrier | Owns | Is in the prompt |
|---|---|---|
| A tool's guidelines | how to use that tool well | exactly when the tool is |
| A template | what to do about an event, with the event's data | at the moment it happens |
| A fragment | a standing stance: what you are here for, what is yours, what done means | every turn |

Applied to the rules that are duplicated today:

| Rule | Owner | Comes out of |
|---|---|---|
| Who is speaking; how messages work | `protocol` | |
| A brief must stand on its own; worktrees; `waits_on` | `spawn_session` guidelines | `protocol` (the whole Delegating section), `coordinator` |
| When to delegate and when not | `coordinator` | `protocol` |
| A report is a claim | `coordinator`; `reviewer` and `verification` keep their own form of it, since it is their whole job | `protocol` |
| How a child answers its parent: one `result`, an `ask` when blocked, no progress notes | `reporting` | `worker` |
| The shape of a report: outcome first, where, how checked, what is open | `worker` | `reporting`, `task`; `implementation` keeps only what is its own (the checks and their results) |
| The user outranks the brief | the `brief` template, which already says it on arrival | `reporting`, `worker` keep one clause: say what changed in the report |
| What to do when a result lands | the `result` template | `tending` keeps one sentence: results on tasks under you are yours to check |
| What to do when a person steers | the `steer` template | `tending` keeps one sentence |

### Roles by issue type (finding 7)

An issue type in the scheme may name the roles a session put on such an issue gets:

```json
{ "name": "task", "level": 3, "under": ["story"], "roles": ["worker", "implementation", "task"] }
```

`rolesFor` in `protocol/src/config.ts` gains one argument. The order is: what the spawner chose, then the type's roles, then `roles.child`. `roles.tree` and `roles.children` are added as now. It applies only when a child is given an issue of its own. A name this machine has no fragment for adds nothing, as now. The coordinator can still choose; it no longer has to remember.

### Measuring (finding 2)

Three layers, cheapest first.

**Checks that cost nothing**, in `test/fragments.test.ts`, part of `npm run check`:

- Every tool a built-in fragment or template names in backticks is a tool some extension registers. Found by reading the sources, as `test/docs.test.ts` does for `LATTICE_` variables.
- Every `{{name}}` in a built-in is a known fact, and is guarded by `when` unless it is always there.
- `includes` names exist and do not loop; no two parts of one role share a slot.
- A word ceiling per default combination, written in the test. It can fall freely; raising it is an edit someone has to make.
- No sentence of more than six words appears in two fragments of one default combination. This catches copies, not rewordings.
- `docs/roles-composed.md`: the whole prompt for each default combination, with and without a board, written by `npm run docs` and checked like `docs/settings.md`. A change to one fragment then shows in review as the prompts it changes.

**Scenarios with a real model**, on demand, in `scripts/eval/`. `scripts/eval.ts` becomes a runner and a table:

```ts
interface Scenario {
	name: string;
	/** The fragments and templates it puts to the test. */
	exercises: string[];
	needs?: "board";
	run(world: World): Promise<void>;
	checks(seen: Seen): Check[];        // what happened, never how it was worded
}
```

| Scenario | Checks |
|---|---|
| `delegation` (exists) | one child, a brief that stands alone, one result, nobody reminded |
| `phase-change` | after moving to planning: `protocol` and `coordinator` still applied, one phase, no file changed |
| `steer-errand`, `steer-rule` | "this first" reorders and leaves no direction; "ask me before anything here lands" becomes one |
| `review-pass`, `review-fail` | closed with a reason; sent back with a comment a session can act on; the work untouched |
| `grilling-reads` | no file changed; ends with questions, grouped |
| `worker-stays` | a planted unrelated fault is in the report and not fixed |

`npm run eval -- <names> --model <m>` runs them and writes the result under `.dev/eval/`. `--compare` sets two runs side by side. `--changed` runs the scenarios whose `exercises` include a fragment that differs from `origin/main`.

**Signals from real use**, in the host. When a child is reminded, when a parent is told a child stopped, and when a result is sent back, the host writes one row: the session, its roles, its model, what happened. `/lattice doctor` and `pi-lattice roles report` print them by combination: "worker implementation task on haiku: 14 sessions, 5 reminded". It stays on the machine.

## Where the code goes

| Piece | Package and file | Kind |
|---|---|---|
| `Fragment` with the new keys, `parseFragment` | `roles/src/fragments.ts` | changed |
| `layer` | `roles/src/catalog.ts` | new, pure |
| `expand`, `select`, `render`, `editRoles` | `roles/src/compose.ts` | changed, pure |
| Gathering facts | `roles/src/facts.ts` | new, the one place that asks Pi and the bus |
| Wiring, `/role`, `apply_role` | `roles/src/extension.ts` | changed, thinner |
| `lattice:facts:query`, `renderTemplate` reused | `protocol/src/events.ts`, `templates.ts` | one event added |
| `rolesFor` with a type's roles, `IssueType.roles` | `protocol/src/config.ts`, `work.ts` | changed |
| The `facts` request; the type's roles at spawn; signals | `host/src/host.ts`, `store.ts` | changed |
| Answering the facts query | `graph/src/extension.ts` | changed |
| Checks and the composed prompts | `test/fragments.test.ts`, `scripts/roles-doc.ts` | new |
| Scenarios | `scripts/eval/` | new |

No arrow is added to `test/architecture.test.ts`.

## Phases

Each phase ends green on `npm run check`, with small conventional commits, and is pushed. The commit type decides whether it releases.

**1. Slots and keep.** Fixes finding 1. `slot` and `keep` in the parser; `editRoles` honours them; `apply_role` defaults to `add`; the built-ins are marked; `lifecycle` is reworded in that one line. Tests: unit tests on `editRoles`; one integration test with the scripted model that changes phase and still has `protocol`. Done when a session cannot lose `protocol` by changing phase. `fix(roles)`: a patch release.

**2. A baseline.** `test/fragments.test.ts`, `docs/roles-composed.md`, the eval runner with `delegation` moved into it and `phase-change` added, the signals table. Then one real run on the models chosen, kept under `.dev/eval/` as the before. Done when a fragment change shows as a prompt diff and a scenario table. `test`, `docs`, `chore`, and `feat(host)` for signals.

**3. Parts, conditions and facts, with no text changed.** `includes`, `when`, `unless`, `{{name}}`, `lattice:facts:query`, the host request. The built-ins are not touched, so `docs/roles-composed.md` must not change: that is the proof the mechanism is neutral. `feat(roles)`.

**4. The text.** Split `coordinator` into its core, `plan-items` and `tending`. Take Delegating out of `protocol`. Apply the ownership table. Fill `{{levels}}`. Each commit changes one fragment and shows its diff in the composed prompts; the phase ends with the scenarios run again and compared with the baseline. A fragment whose scenarios get worse goes back. `feat(roles)`.

**5. Roles by issue type.** `IssueType.roles`, `schemeProblems`, `rolesFor`, the host at spawn, `/lattice scheme edit`. `suggests` is removed. Tests in `test/integration/work.test.ts`: a child put on a task gets the task's roles; a spawner's choice still wins. `feat(protocol)`, `feat(host)`.

**6. Layers.** `layer`, `mode: append`, `base`, `/role edit` with an addition as the default, the stale mark. Tests: unit tests on `layer`; the existing override test extended. `feat(roles)`.

Phases 5 and 6 depend on nothing after 1 and can swap. A decision record is written as each is built, with its evidence: roles are composed in steps (1, 3, 6), what tools, templates and roles each say (4), roles by issue type (5).

## Decisions that were yours

All five were taken as recommended. For the fifth, the baseline ran on Haiku 5.5, which is what Pi was set up with here and what children run on, and on Sonnet 5.5 as the stronger one.


1. **`/role set` keeps `keep` fragments for a person too.** Recommended: yes, one rule for person and agent. Today `/role set worker` silently takes `protocol` off a session in a tree. `/role remove` and `/role clear` still take anything off.
2. **A type's roles live in the team's scheme.** Recommended: yes, beside `rules.review`, since it says how this team works. The other place is a person's settings, which would let each person differ and would need a setting whose keys are not fixed.
3. **The default scheme names roles for `task` and `bug` only.** Recommended: yes. Larger types are left to the coordinator until the scenarios say what suits them.
4. **`coordinator`, `worker` and `reviewer` share a slot.** Recommended: yes. They already conflict pairwise.
5. **Which models the baseline runs on.** It spends tokens. One strong and one cheap model would show whether the fragments hold on the model children usually run on.

## Risks

- **Defaults change behaviour.** Phases 1, 4 and 5 change what an existing setup does. Each is a visible diff in `docs/roles-composed.md`, and 4 is gated on the scenarios.
- **More frontmatter to learn.** All of it is optional, and `/role show` prints what a fragment declares.
- **A fact that flaps would patch the prompt every turn.** Tool facts come from the tools registered, not the ones active at the moment, and no fact is a status. This needs checking against Pi's tool search before phase 3 lands.
- **Scenarios are few and models vary.** They show a regression; they do not prove a wording is good. The signals from real use are the longer measure.

## Not in this plan

- **The host knows `coordinator` by name** (`host.ts`, where it finds what tends an issue). A person's own coordinating role is not seen as tending. A `provides` key would fix it, but the host does not read fragments today, and that is a seam to decide by itself.
- **A background session does not take up a role it is given after it started** ([0036](../decisions/0036-a-board-is-tended.md), not done). The facts request gives the graph extension the channel to carry it; it is a small follow-up.
- **Roles for agents that are not Pi sessions.** `pi-lattice work prime` stays as it is.

## What differed when it was built

- **The first run with a real model found three defects before any wording was looked at.** No tool showed an issue's description, though the reviewer is told to read it. A parent's thanks for a result made its child owe a report again. A reviewer's report counted as a new result on the issue it had just sent back, and another reviewer was started, and another. Each is fixed, with a test. The baseline was taken after them, so that it measures the text.
- **One rule went back where it was** (finding 5). "Answer a person who steers in one sentence" was moved out of `coordinator`, since the note that arrives asks for it. Sonnet then answered in three sentences, 3 runs in 11. With the line back, none in 11. The rule of thumb is now in [0039](../decisions/0039-what-agents-are-told-is-measured.md): what to do about an event belongs to the note, but how to answer, against a model's habit, also stands in the role.
- **`select` is not a step of its own.** A fragment that does not apply takes its parts with it, so applying is decided while expanding: `expand(applied, catalog, facts)`.
- **Eleven scenarios, not eight.** Laying out a plan, and a result on a task that holds and one that does not, were added for the text that was moved. A scenario's `run` both sets the world up and checks it.
- **`pi-lattice roles report` was not built.** The command line has no connection to a running host. The counts are in `/lattice doctor`, which has one.
- **`tool.<name>` facts come from the tools registered, not the ones active,** which settles the risk named above: a tool search that switches tools on and off does not change them.
- **A copy's mark is written quoted.** A hash of digits only was read from the header as a number.
- **Three tests of the pane and of sharing timed out in some full runs** while this was built (`teammates`, `home`, `tui`), each passing alone and in most runs. They wait on a fixed number of seconds, and the suite is now seventy tests longer. Nothing here changed what they test.
