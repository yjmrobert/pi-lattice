#!/usr/bin/env node
/**
 * Open Pi on this checkout, without installing it.
 *
 *   npm run dev                  your own model and login, in a scratch repository under .dev/
 *   npm run dev -- --faux        the scripted model the tests use: no network, no tokens
 *   npm run dev -- --cwd <dir>   in a repository of yours instead of the scratch one
 *   npm run dev -- --fresh       throw away the scratch state first
 *   npm run dev -- -- <args>     anything after a second -- goes to Pi
 *
 * The session trees, settings, roles and templates it makes live under .dev/, so nothing it
 * does reaches the trees and settings you really use. Pi's own extension discovery is switched
 * off, so an installed copy of pi-lattice is not loaded beside this one.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dev = join(root, ".dev");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const extension = (path) => join(root, path);
const foreground = ["packages/app/src/launcher.ts", "packages/pane/src/extension.ts", "packages/canopy/src/extension.ts", "packages/a2a/src/extension.ts", "packages/roles/src/extension.ts", "packages/graph/src/extension.ts"].map(extension);
const background = ["packages/a2a", "packages/roles", "packages/graph"].map(extension);
const faux = extension("test/support/faux-provider.ts");

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split < 0 ? argv : argv.slice(0, split);
const passed = split < 0 ? [] : argv.slice(split + 1);
const flag = (name) => own.includes(name);
const value = (name) => (own.includes(name) ? own[own.indexOf(name) + 1] : undefined);

if (flag("--help") || flag("-h")) {
	console.log("npm run dev [-- --faux] [--cwd <dir>] [--fresh] [-- <pi arguments>]\n\nOpens Pi with the pi-lattice extensions from this checkout. State is kept under .dev/.");
	process.exit(0);
}
if (!existsSync(cli)) {
	console.error("Pi is not installed here yet. Run npm install first.");
	process.exit(1);
}
if (flag("--fresh")) rmSync(dev, { recursive: true, force: true });

let cwd = value("--cwd");
if (cwd) cwd = resolve(cwd);
else {
	cwd = join(dev, "work");
	if (!existsSync(join(cwd, ".git"))) {
		mkdirSync(cwd, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "--allow-empty", "-m", "scratch"], { cwd });
	}
}
mkdirSync(join(dev, "lattice"), { recursive: true });

const model = flag("--faux") ? ["-e", faux, "--provider", "lattice-faux", "--model", "scripted"] : [];
const env = {
	...process.env,
	// Trees, settings, roles' user copies and templates: all under .dev/, away from the real ones.
	LATTICE_HOME: join(dev, "lattice"),
	// Background sessions run this checkout's Pi and extensions, and nothing that is installed.
	LATTICE_PI_COMMAND: JSON.stringify([process.execPath, cli]),
	LATTICE_PI_ARGS: JSON.stringify(["--no-extensions", ...model]),
	LATTICE_EXTENSION_PATHS: JSON.stringify(background),
	...(flag("--faux") ? { PI_CODING_AGENT_DIR: join(dev, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", LATTICE_FAUX_SCRIPT: extension("test/support/director.mjs") } : {}),
};
const args = [cli, "--no-extensions", ...foreground.flatMap((path) => ["-e", path]), ...model, ...passed];
console.error(`pi-lattice dev: ${cwd}${flag("--faux") ? " (scripted model)" : ""}; state in ${dev}`);
const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
