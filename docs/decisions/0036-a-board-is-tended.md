# 0036 A board is tended: the root coordinates, and a result nobody checks is said

Builds on [0033](0033-agents-keep-the-issues.md). Status: built.

With a board, agents keep the issues: a result moves its issue to review, and the session tending the branch, the nearest with the `coordinator` role, checks it or has a reviewer started. A tree whose first session was a plain Pi session had nothing with that role. `roles.root` is empty by default, and a person who starts with a brief ("plan it as a tree and delegate") gets a root that delegates well and files issues, and is nothing to the host. Seven features were built, merged and reported, and all seven stayed in review: the host found nobody to hand each result to and returned without a word. The canopy said 0 of 7 done, correctly, and nothing said why.

**Decision**

- **A result nobody can check is said.** When a result lands on an issue a session here worked on, and no session here or of a teammate tends it, the host says so, to the person's terminals and in its log: the result has nobody to check it, it stays where it is, and how to put something on it.
- **With a board, the root of a tree is its coordinator unless the person chose otherwise.** Where `roles.root` is empty and no session of this person here has the role:
  - a tree's first session is given `coordinator` as it starts the tree;
  - the root of a tree that already exists is given it once sessions of that tree are on the board's issues. That is the tree that came before its board. A tree with nothing on the board is left alone: a board being there says nothing about what a repository's sessions are for.
- **What waited is handed on.** When the root is given the role, results already in review on issues its sessions are on are handed on as they would have been: a reviewer for the types the scheme names, the root itself for the rest. Before that moment nothing could have been handed anything, so nothing is checked twice.
- **The session takes the role up.** A session reads its roles when it starts. The pane sees the roles its host has for the session open here, and applies what is gained to it (`lattice:roles:add`); the role is in its prompt from the next turn that starts. A root seen for the first time that its host has as coordinator, and that has not applied the role, is given it too: the host may have given it while the terminal was closed.
- **The person is told.** A session's role changed without their asking: the host says which session and why, in the terminal.
- **`roles.root` still decides.** Set to anything, it is what the first session gets, and nothing is added. To have a root that does not coordinate on a board, set it.

**Not done**

- A root running in the background when it is given the role does not take it up until it is opened in a terminal: the host has it as the tender, and hands it results with what to do about each, but the role's text is not in its prompt.
- Roles changed inside a session (`/role`) are still not told to its host. A root that dropped `coordinator` there is still the tender to the host, and is given the role again when next opened.

**Evidence**

- `test/integration/work.test.ts`, with a real server, a real host and real Pi sessions on the scripted model: a plain root delegates a feature to a child on its issue, is given the role, is said to have been, and the result gets its reviewer; with `roles.root` chosen, the root is left as it is and the host says the result has nobody to check it.
- `test/integration/tui.test.ts`, in real Pi in a pseudo-terminal: the tree first and the board after; the session open in the terminal is told it has the role, shows it, and has it in its prompt from the next turn.
