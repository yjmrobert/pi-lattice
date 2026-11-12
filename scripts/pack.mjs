#!/usr/bin/env node
/**
 * Build the one package people install: `pi install npm:pi-lattice`.
 *
 * The repository is workspaces of TypeScript that Pi and Node run from source. That does not
 * survive publishing: npm does not put workspace packages into a tarball, and Node will not run
 * TypeScript from under `node_modules`. So this writes `dist/pi-lattice/`, a package with no
 * dependencies: each extension as one JavaScript file with what Pi provides left out, the host as
 * one JavaScript file with everything it needs inside, and the role fragments beside them.
 *
 *   node scripts/pack.mjs [directory]     build it there (default dist/pi-lattice)
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "dist", "pi-lattice"));
const app = JSON.parse(readFileSync(join(root, "packages/app/package.json"), "utf8"));
const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** What Pi gives every extension; a second copy would not be the one Pi uses. */
const PROVIDED = Object.keys(app.peerDependencies);
const EXTENSIONS = { launcher: "packages/app/src/launcher.ts", pane: "packages/pane/src/extension.ts", canopy: "packages/canopy/src/extension.ts", a2a: "packages/a2a/src/extension.ts", roles: "packages/roles/src/extension.ts", graph: "packages/graph/src/extension.ts" };

const provided = (id) => PROVIDED.some((name) => id === name || id.startsWith(`${name}/`));
async function bundle(input, file, external) {
	const build = await rolldown({ input: join(root, input), platform: "node", external, logLevel: "warn" });
	await build.write({ file, format: "esm", codeSplitting: false });
	await build.close();
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [name, input] of Object.entries(EXTENSIONS)) await bundle(input, join(out, "extensions", `${name}.js`), provided);
// The host is a Node program of its own: nothing is provided to it, so only Pi's library, which it finds when it runs, stays out.
await bundle("packages/app/src/cli.ts", join(out, "host", "cli.js"), (id) => id.startsWith("@earendil-works/"));
cpSync(join(root, "packages/roles/fragments"), join(out, "fragments"), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
try {
	cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
} catch {
	// No licence file yet.
}

writeFileSync(
	join(out, "package.json"),
	`${JSON.stringify(
		{
			name: "pi-lattice",
			version: app.version,
			description: top.description,
			type: "module",
			keywords: top.keywords,
			...(top.license ? { license: top.license } : {}),
			...(top.repository ? { repository: top.repository } : {}),
			...(top.homepage ? { homepage: top.homepage } : {}),
			engines: app.engines,
			bin: { "pi-lattice": "./host/cli.js" },
			files: ["extensions", "host", "fragments", "README.md", "LICENSE"],
			pi: { extensions: Object.keys(EXTENSIONS).map((name) => `./extensions/${name}.js`) },
			peerDependencies: app.peerDependencies,
		},
		null,
		2,
	)}\n`,
);
process.stdout.write(`${out}\n`);
