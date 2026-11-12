# 0025 One published package, built

Settles what [0001](0001-packaging-and-scope.md) left unverified.

**Decision**

- **One package is published: `pi-lattice`.** `pi install npm:pi-lattice` gets everything. The workspace packages (`@pi-lattice/*`, and `packages/app`, which carries the same name) are marked private so none of them can be published by mistake: none works from a tarball.
- **It is built by `scripts/pack.mjs`** (`npm run build`) into `dist/pi-lattice/`, and published from there:
  - `extensions/*.js`: each extension as one file, with `protocol` inside it and what Pi provides (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) left as imports.
  - `host/cli.js`: the host as one file with everything inside, `typebox` included. It is a Node program of its own, so nothing is provided to it.
  - `fragments/`: the roles. The roles extension looks one directory above its own file, which is right in both layouts.
  - A manifest with no `dependencies`.
- **The host finds Pi's library when it needs it.** It uses two functions of Pi's to read the file of a session that is not running. It cannot carry a copy (Pi's library with its providers is 7 MB bundled, and a second copy is what Pi's documentation warns against), so it loads the installed one: `LATTICE_PI_PACKAGE` names its directory outright; else the launcher passes the file its Pi ran from and the host finds the package around it; else the host looks for `pi` on the PATH. If there is none, reading such a session fails with a message that says what to set; everything else works.
- **The launcher and the host know both layouts.** From source the host is `cli.ts` beside the launcher; built, it is `../host/cli.js`. A session the host starts is given the package directory itself, checkout or installed, so Pi sees the package it already loaded and does not load it twice.
- **The version is `packages/app`'s, and follows semantic versioning.** While it is `0.x`, a minor version may break things and a patch may not. Pushing a tag `v<version>` publishes it: `.github/workflows/release.yml` refuses a tag that is not the version, runs the whole suite, builds and publishes with provenance. It publishes as a trusted publisher, with no stored token, except while an `NPM_TOKEN` secret exists, which the first release needs.
- **MIT.** The licence file and the link to the repository are copied into the published package.

**Evidence**

- `npm pack` of `packages/app` with `bundledDependencies` wrote 8 files: its own sources and nothing of the eight packages it bundles. npm looks for bundled packages in the package's own `node_modules`, and workspace packages are linked at the root.
- Node refuses to strip types under `node_modules` (0001, phase 3), so the host could not run from an installed tarball even with the packages in it.
- `test/integration/published.test.ts` builds the package, packs it with npm, installs it with `--omit=peer` into an empty directory outside the repository, and runs a real Pi with it: the pane and canopy load, the launcher starts `host/cli.js`, and a child session the host starts loads the package and gets its roles from `fragments/`. The host's error log stays empty.
- `packages/host/test/pi-library.test.ts` runs the lookup from a copy outside the repository, where the bare import fails: it loads Pi from `LATTICE_PI_PACKAGE` and from the path of a `pi`, and names the fix when there is neither.

**Not verified**

- The release workflow has not run: it runs only on a tag, and no tag has been pushed.
- `pi install npm:pi-lattice` itself, which needs the package on the registry. The test does what Pi's documentation says Pi does (an npm install without peers), not Pi's own command.
- A Pi that is a single compiled executable rather than a Node package: there is no library file for the host to load, so reading a stopped session's messages would fail there.
- Windows: the lookup of `pi` on the PATH does not try `pi.cmd`.

**Costs**

- Stack traces from an installed package point into bundled files. No source maps are shipped.
- The six extension files each hold their own copy of `protocol`, as they did when Pi loaded the packages with separate module roots (0001).
