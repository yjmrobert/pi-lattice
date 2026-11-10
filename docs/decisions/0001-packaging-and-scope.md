# 0001 Packaging, npm scope and shared code

**Decision**

- npm scope is `@pi-lattice` (fallback `@halflight-pi`). Availability could not be confirmed without an npm login: the registry has no public packages under either scope, which is consistent with both being free but does not prove it. Claim the org before the first publish; a rename is a mechanical search and replace.
- Each package is a Pi package: a `package.json` with a `pi` key listing its extensions, and `keywords: ["pi-package"]`.
- Validators use TypeBox. Pi supplies `typebox` to extensions, so it is a `peerDependency` with range `*`, as are the `@earendil-works/pi-*` packages. They are never listed in `dependencies`.
- `@pi-lattice/protocol` ships TypeScript source (`exports` points at `src/index.ts`). Pi loads extensions through jiti, so no build step is needed for extensions. The host runs on Node's native type stripping, which is why the codebase sticks to erasable syntax (no enums, no parameter properties).
- Pi loads installed packages with separate module roots. Every package therefore gets its own copy of `protocol`. `protocol` must stay pure data and pure functions: no singletons, no `instanceof` checks across packages, no module-level state.
- `host` and `tree` are one package (`host`) until a second UI exists.

**Evidence (spike S2, S7)**

A package with a `pi.extensions` manifest loaded with `pi -e <dir>`; its extension imported the workspace-linked `@pi-lattice/protocol` TypeScript source and `typebox`; an event it emitted on `pi.events` was received by a separately loaded extension.

**Not yet verified**

Published tarballs. Pi's docs say other Pi packages used as dependencies must be included in the published tarball, so `protocol` will need `bundledDependencies` in each dependant. Verify with `npm pack` + `pi install` before the first publish.
