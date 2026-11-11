# Roles

A role is a list of fragments. A fragment is a piece of guidance in a markdown file. A session has no fixed type: the human, or a coordinator when it spawns a child, chooses the fragments, and they can change at any point in the session.

## Writing a fragment

```markdown
---
name: security-review
summary: Look for vulnerabilities before anything else
requires: [worker]        # advisory
conflicts: [planning]     # advisory
suggests: [worker]        # hint about children this role tends to spawn
---
Review the change for injection, authorisation and secret-handling flaws.
Report findings with file and line, most severe first.
```

- `name` is lowercase letters, digits and dashes. Without frontmatter the file name is used.
- `requires` and `conflicts` produce a note when a combination looks odd. They never block anything.
- The body is what the model sees. Write it as instructions to the agent.

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
/role add coordinator planning
/role remove planning
/role set worker implementation
/role clear
```

The model can do the same with the `apply_role` tool. A session spawned by a host takes its starting fragments from `LATTICE_FRAGMENTS`.

Order matters: fragments are injected in list order, and where two disagree the later one wins.

## How it reaches the model

Each applied fragment becomes one system prompt section, `<lattice-role-NAME>`, after an index section `<lattice-roles>` that lists them and says they are guidance the user can overrule. Pi patches only the sections that changed, so changing roles mid-session keeps the prompt cache where the provider supports it ([ADR 0003](decisions/0003-roles-as-prompt-sections.md)).

The applied list is stored in the session, survives resume, and carries over `/new`.

## Built-in fragments

| Name | Folder | Use it for |
|---|---|---|
| `coordinator` | base | Breaking work down, delegating to children, tracking, reporting |
| `worker` | base | One bounded piece of work, reported back when done or blocked |
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

## What roles are not

There is no enum of agent types, no validation that a combination makes sense, and no gate the code enforces. The gates a fragment describes (for example "do not implement before the plan is approved") are guidance the agent follows and the human can overrule.
