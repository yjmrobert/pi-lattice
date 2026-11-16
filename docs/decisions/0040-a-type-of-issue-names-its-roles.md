# 0040 A type of issue names the roles for a session put on it

Builds on [0017](0017-settings-and-orchestration.md) and [0026](0026-a-server-for-the-work.md). Status: built.

Which roles suit which work was a paragraph in the guide: `worker + implementation + task` for a child that builds one piece. A coordinator had to remember it each time it created a child, and a fragment could hint at it with `suggests`, which nothing read.

**Decision**

- **A type in the team's scheme may carry `roles`.** A child put on an issue of that type, with no roles chosen for it, is given them.
- **The order is: what whoever creates the session chose, then the type's roles, then `roles.child`.** `roles.tree` and `roles.children` are added as before.
- **It is in the scheme, beside `rules.review`,** because it says how this team works, and a scheme is the team's. It is not a setting of a person's.
- **The default scheme names roles for `task` and `bug` only:** `worker`, `implementation`, `task`. Larger types are left to the coordinator.
- **A scheme a team already has is not changed.** It gains roles when someone edits it (`/lattice scheme edit`).
- **A name a machine has no fragment for adds nothing there,** as with any role.
- **`suggests` is removed.**

**Evidence**

- `packages/protocol/test/work.test.ts`, `config.test.ts`: the order; a scheme with roles is valid, kept when saved, and said with the scheme.
- `test/integration/work.test.ts`, with a real server and host: a child put on a bug gets the three roles without being given any; one given roles keeps those; a child on a feature, or on no issue of its own, gets the default; after the team's scheme names roles for a feature, the next child on one gets them.

**Not done**

- Roles by kind where there is no server. A planned item has a kind and no type.
- A model for a type. Which model a session runs on is a person's choice and a cost, not the team's scheme.
