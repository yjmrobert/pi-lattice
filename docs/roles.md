# Roles

A role is a list of fragments. A fragment is a piece of guidance in a markdown file. A session has no fixed type: the human, or a coordinator when it spawns a child, chooses the fragments, and they can change at any point in the session.

## Writing a fragment

```markdown
---
name: security-review
summary: Look for vulnerabilities before anything else
requires: [worker]        # advisory
conflicts: [planning]     # advisory
slot: review              # at most one fragment of a slot is applied
keep: true                # setting the roles leaves it applied
includes: [house-rules]   # fragments that are part of this one
when: [board]             # applied only while these facts hold
unless: [issue]           # and none of these do
---
Review the change for injection, authorisation and secret-handling flaws.
Report findings with file and line, most severe first.
```

- `name` is lowercase letters, digits and dashes. Without frontmatter the file name is used.
- `requires` and `conflicts` produce a note when a combination looks odd. They never block anything.
- `slot` says the fragment is one of a kind of which a session has one at a time. Applying it takes off whichever fragment holds the same slot. The built-in slots are `phase` (grilling, planning, implementation, verification), `scope` (feature, story, task) and `stance` (coordinator, worker, reviewer); any name makes a new one.
- `keep` says that replacing the roles leaves this one applied. `protocol` and `reporting` are kept: they tell a session how the tree it is in works, whatever else it is doing.
- `includes` names fragments that are part of this one. Applying it applies them after it, each as a section of its own, and they are not listed separately: `coordinator` is a short core that includes what a coordinator does with and without a server. A part is an ordinary fragment. It can be applied alone, shown, and changed without touching the rest.
- `when` and `unless` name facts (below). The fragment is written into the prompt only while every fact in `when` holds and none in `unless` does, and its parts with it. It stays applied all the while: when the facts change, it comes and goes by itself.
- The body is what the model sees. Write it as instructions to the agent. `{{name}}` in it becomes the text of that fact; name the fact in `when` too, or the braces are shown where the fact is missing.

## Facts

A fact is something that is so for a session and stays so: where it is in the tree, whether the team has a server, which tools it has. A session's host tells it, and the session knows its own tools. A fact holds when it has a text.

| Fact | Its text | For example |
|---|---|---|
| `name` | The session's name in the tree. | `card form` |
| `kind` | The kind of work it was created for. | `task` |
| `parent.name` | The name of the session it reports to. Absent for the first session of a tree. | `checkout` |
| `issue` | The number of the issue it is on. Absent when it is on none. | `38` |
| `board` | The team keeps its work as issues on a server, and this session's host has joined it. | `yes` |
| `levels` | The levels of work, largest first: the team's issue types by level where there is a server, else the `canopy.levels` setting. | `epic, feature, story, task` |
| `types` | Every issue type of the team's scheme. Absent without a server. | `epic, feature, story, task, bug` |
| `tool.<name>` | The session has that tool. | `tool.spawn_session` |

A session with no host has only the tool facts, so a fragment that needs anything else is not applied there. Facts are never a status or a time: a prompt that changed every turn would lose its cache.

Decide whether a paragraph applies by making it a fragment with `when`, not with a condition inside the text. A fragment then stays something a person can read whole and change whole.

## Where fragments live

Looked up in this order; the first match for a name wins:

1. `<project>/.pi/lattice/roles/`, only when the project is trusted, because fragments are prompt text.
2. `~/.pi/agent/lattice/roles/`
3. The fragments shipped in `packages/roles/fragments/`.

Subfolders are searched, so you can group files as `base/`, `phase/`, `scope/`. The folder is organisation only; it is not part of the name. Dropping a file in is all it takes. No code change, no restart: fragments are re-read when roles change.

## Composing

```
/role                      show what is applied
/role list                 show what is available
/role add coordinator planning   apply these as well; planning takes the place of any other phase
/role remove planning
/role set worker implementation  replace the roles, except the ones marked keep
/role clear                      take everything off
/role show worker          print a fragment in full, with the file it comes from
/role edit worker          open it in Pi's editor; saving writes your own copy
/role edit worker project  the same, into this project's folder
```

Saving a fragment empty removes your copy, and the one under it is used again. `/lattice prompt` shows everything the session you are in has been told, roles included.

The model can do the same with the `apply_role` tool, which adds unless told otherwise: a model that names the next phase gets that phase in place of the last one, and keeps its other roles. A session spawned by a host takes its starting fragments from `LATTICE_FRAGMENTS`.

Order matters: fragments are injected in list order, and where two disagree the later one wins.

## How it reaches the model

A list of names becomes prompt sections in steps: each fragment and then its parts, less the ones whose `when` and `unless` do not hold, with the facts filled in. Each fragment that is left becomes one system prompt section, `<lattice-role-NAME>`, after an index section `<lattice-roles>` that lists them and says they are guidance the user can overrule. Pi patches only the sections that changed, so changing roles mid-session keeps the prompt cache where the provider supports it ([ADR 0003](decisions/0003-roles-as-prompt-sections.md)).

The applied list is stored in the session, survives resume, and carries over `/new`.

[Roles, as composed](roles-composed.md) has the whole text for the usual combinations and what each costs in words. It is written from the fragments by `npm run docs`, and a test fails when it is out of date, so a change to a fragment shows there as the prompts it changes.

## Checking a change to a fragment

A fragment is text a model reads, so a change to one is checked three ways, cheapest first.

1. **As text.** `npm run check` fails when a built-in fragment names a tool that does not exist, when a combination grows past its ceiling in words, or when two fragments of one combination say the same sentence. `npm run docs` rewrites [roles, as composed](roles-composed.md), so the change shows in review as the prompts it changes.
2. **With a real model.** `npm run eval` gives real sessions small pieces of work and checks what happened, never how it was worded: a child reported once without being reminded, a session that changed phase kept its other roles, a reviewer closed what was done and sent back what was not. `npm run eval -- --changed` runs the scenarios that test what differs from `origin/main`, `--runs 3` repeats each, and `--compare` sets two runs side by side. It uses your Pi login and spends tokens; `npm run eval -- --list` says what there is.
3. **In use.** The host counts the child sessions that had to be reminded to report, that stopped without reporting, and whose result was sent back. `/lattice doctor` says how many, for each combination of roles and model.

## Built-in fragments

| Name | Folder | Use it for |
|---|---|---|
| `protocol` | base | Given to every session in a tree: who is speaking and how messages work |
| `reporting` | base | Given to every child: how to answer the session that created it |
| `coordinator` | base | Breaking work down, delegating to children, tracking, reporting. Made of the two below, of which one applies |
| `tending` | base | Part of `coordinator` where the team has a server: keeping the issues under the one it is on, and acting on what people and sessions say about them |
| `plan-items` | base | Part of `coordinator` where it has not: laying the work out on the tree before any of it starts |
| `worker` | base | One bounded piece of work, reported back when done or blocked |
| `reviewer` | base | Checking one result against what its issue says done means, then closing it, sending it back, or asking |
| `lifecycle` | base | Moving work through the four phases below, with the user steering |
| `grilling` | phase | Finding gaps and contradictions in a request before planning |
| `planning` | phase | Producing a plan for approval; no code yet |
| `implementation` | phase | Building an agreed plan in small verified steps |
| `verification` | phase | Independently checking finished work against the request |
| `feature` | scope | A user-visible capability spanning several stories |
| `story` | scope | One demonstrable slice of a feature |
| `task` | scope | One concrete change with a checkable finish line |

Typical combinations: `coordinator + lifecycle + feature` for the root of a feature; `worker + grilling + story` for a child that interrogates one story; `worker + implementation + task` for a child that builds one piece. See [the lifecycle example](../examples/feature-lifecycle/README.md).

The lifecycle is not a state machine. It is the `lifecycle` fragment explaining to a coordinator how to move between phase fragments, and each phase fragment describing its own gate.

## Roles a session gets without being asked

A session in a tree is given some roles when it is created, so that sessions know how to talk to each other without anyone having to remember:

| Setting | Default | Given to |
|---|---|---|
| `roles.tree` | `protocol` | Every session in a tree |
| `roles.children` | `reporting` | Every child, whatever roles were chosen for it |
| `roles.root` | none | The session that starts a tree |
| `roles.child` | `worker` | A child created with no roles |

With a server, the team's scheme can name the roles for a type of issue, and a child put on such an issue with no roles chosen gets those in place of `roles.child`. The default scheme names `worker + implementation + task` for a task and for a bug, so a coordinator that puts a session on a task does not have to remember what a task wants. `/lattice scheme edit` changes it: a type takes `"roles": ["worker", "implementation", "task"]`. What whoever creates the session chooses still wins, and a name a machine has no fragment for adds nothing there.

They are ordinary fragments: they show in the inspector, `/role remove protocol` takes one off a session, and `/role edit protocol` changes what it says. The settings are on the settings screen (`,` in the pane). See [ADR 0017](decisions/0017-settings-and-orchestration.md).

## What roles are not

There is no enum of agent types, no validation that a combination makes sense beyond one fragment per slot, and no gate the code enforces. The gates a fragment describes (for example "do not implement before the plan is approved") are guidance the agent follows and the human can overrule.
