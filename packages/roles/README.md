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

Add your own fragment by dropping a markdown file into `~/.pi/agent/lattice/roles/` or `<project>/.pi/lattice/roles/`.

See [docs/roles.md](../../docs/roles.md) for the fragment format, lookup order and how composition works.

| For | Name | Does |
|---|---|---|
| Human | `/role` | Show, list, add, remove, set or clear the applied fragments |
| Model | `apply_role` | The same, as a tool |
| Other extensions | `lattice:roles:set`, `lattice:roles:changed` | Set the list; observe changes |
