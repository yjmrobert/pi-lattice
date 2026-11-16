# 0038 Roles are composed in steps

Builds on [0003](0003-roles-as-prompt-sections.md) and [0017](0017-settings-and-orchestration.md). Status: built. [The plan](../design/roles-plan.md) has the analysis.

A role is a list of fragments, and composing them had one operation: join them in order. Everything else a role needed was worked around. A phase was one of four, and nothing said so: `apply_role` replaced the whole list unless told otherwise, the `lifecycle` role tells a coordinator to change phase with it, and one call naming the next phase took `protocol`, `coordinator` and `reporting` off the session. What depended on the setup was prose inside a fragment: `coordinator` carried three setups in thirteen bullets. Text could not name what the team had configured: it said "epic, feature, story, task" to a team with other types. And a person's change to a role was a full copy of the file, which nothing the built-in gained afterwards reached.

**Decision**

A role stays a list of fragments. Each thing it could not say is one optional line of a fragment's header, and one pure function.

- **`slot`: one of these.** At most one fragment of a slot is applied; applying one takes the other off. The built-ins have `phase`, `scope` and `stance`. Every `conflicts` between built-ins was within one slot, and is gone.
- **`keep`: stays.** Replacing the roles leaves a kept fragment applied; removing it by name, or clearing, takes it off. `protocol` and `reporting` are kept. The rule is the same for a person and for an agent.
- **`apply_role` adds unless told otherwise.**
- **`includes`: made of these.** Applying a fragment applies its parts after it, each as a section of its own. `coordinator` is a core of eight bullets and two parts.
- **`when`, `unless`: only where this is so.** A fragment is written into the prompt only while the facts it names hold, and its parts with it. It stays applied: it comes and goes by itself as the facts do.
- **`{{name}}`: with this value.** A fact's text is filled in. Whether a paragraph applies is decided per fragment, never by a condition inside the text.
- **`mode: append`: on top of that one.** A person's or a project's file adds its text after the role beneath it and changes nothing else. A full copy says what it was copied from (`base`), and is said to be stale when what is beneath has changed.
- **Facts are a contract** (`protocol/src/facts.ts`): a name and a text, holding when the text is not empty, as in templates. A session's host says where it is in the tree, whether the team has a server, and the team's levels and types; the session knows its own tools. They are asked for before each turn with an ask-and-fill event whose answers may be fetched, and the host answers one new request. Facts are never a status or a time, so the prompt does not change from turn to turn.
- **The steps are pure and in one place** (`roles/src/compose.ts`, `catalog.ts`): files are layered into a catalog; applied names are expanded into fragments, less the ones that do not apply; each is rendered. Reading files and asking Pi stay at the edge.

**Evidence**

- `packages/roles/test/pipeline.test.ts`, `roles.test.ts`: each step alone. `packages/protocol/test/facts.test.ts`: the contract.
- `test/integration/roles.test.ts`, real Pi on the scripted model: a model that names the next phase with `apply_role` keeps `protocol`, `coordinator` and `lifecycle`; a role's parts are applied with it and only where their conditions hold; `/role edit` adds, `/role edit <name> replace` copies, and a copy that fell behind is said to be.
- `test/integration/host.test.ts`, `work.test.ts`: every session of a tree is given the same three roles, and each is in the prompt only where it fits: one for a session with a parent, one for the first session, one for a team with a server.
- `docs/roles-composed.md` did not change by a byte when the steps were built and the built-in text was not yet touched. That is the check that they are neutral.
- With a real model (see [0039](0039-what-agents-are-told-is-measured.md)): a session told to move to the next phase did, and kept its roles, in 18 runs of 18.

**Not done**

- The host still knows `coordinator` by name where it finds what tends an issue. A person's own coordinating role is not seen as tending.
- A session running in the background does not take up a role it is given after it started ([0036](0036-a-board-is-tended.md)).
- A copy is marked stale; nothing merges what changed into it.

**Costs**

- Five header keys to learn. All are optional, and `/role show` prints what a fragment declares.
- One request to the host at the start of each turn, on a local socket, waited for at most 1.5 seconds.
