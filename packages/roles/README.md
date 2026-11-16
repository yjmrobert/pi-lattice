# @pi-lattice/roles

Composable roles for Pi sessions. A role is a list of markdown fragments that a human assigns, combines and changes mid-session, instead of a fixed set of agent profiles.

```bash
pi install ./packages/roles        # or: pi -e ./packages/roles
```

Then, in a session:

```
/role add coordinator planning
/role remove planning
/role list
```

Add your own fragment by dropping a markdown file into `~/.pi/agent/lattice/roles/` or `<project>/.pi/lattice/roles/`. `/role edit <name>` adds to a role that exists without copying it; `/role edit <name> replace` makes a copy of your own.

See [docs/roles.md](../../docs/roles.md) for the fragment format, lookup order and how composition works.

| For | Name | Does |
|---|---|---|
| Human | `/role` | Show, list, add, remove, set or clear the applied fragments |
| Model | `apply_role` | Add (the default), remove or set, as a tool. A fragment with a `slot`, such as a phase, takes the place of the one applied; fragments marked `keep` stay when the list is set |
| Other extensions | `lattice:roles:set`, `lattice:roles:changed` | Set the list; observe changes |
