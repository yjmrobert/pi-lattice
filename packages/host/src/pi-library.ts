/**
 * Pi's own library, for the one thing the host reads the way Pi does: a session file.
 *
 * In this repository the library resolves like any dependency. Installed as a Pi package it does
 * not: Pi gives its library to extensions, and the host is a separate Node program with no copy
 * of its own. So the host looks for the Pi that is installed: the one it is told about, the one
 * whose launcher started it (`LATTICE_PI_STARTED`, the file that Pi ran from), then the `pi` on the PATH.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const NAME = "@earendil-works/pi-coding-agent";

export interface PiLibrary {
	parseSessionEntries(text: string): Array<{ type: string }>;
	buildSessionContext(entries: never): { messages: unknown[] };
}

/** The directory of Pi's package that a file inside it belongs to. */
export function piPackageOf(file: string | undefined): string | undefined {
	if (!file) return undefined;
	try {
		for (let dir = dirname(realpathSync(file)), up = dirname(dir); ; dir = up, up = dirname(dir)) {
			const manifest = join(dir, "package.json");
			if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === NAME) return dir;
			if (up === dir) return undefined;
		}
	} catch {
		return undefined;
	}
}

function onPath(env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir && existsSync(join(dir, "pi"))) return join(dir, "pi");
	}
	return undefined;
}

function entryOf(dir: string): string {
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { main?: string; exports?: Record<string, string | { import?: string; default?: string }> };
	const root = manifest.exports?.["."];
	return join(dir, (typeof root === "string" ? root : (root?.import ?? root?.default)) ?? manifest.main ?? "dist/index.js");
}

let loaded: Promise<PiLibrary> | undefined;

export function piLibrary(env: NodeJS.ProcessEnv = process.env): Promise<PiLibrary> {
	loaded ??= (async () => {
		try {
			return (await import(NAME)) as unknown as PiLibrary;
		} catch {
			const dir = (env.LATTICE_PI_PACKAGE && existsSync(env.LATTICE_PI_PACKAGE) ? env.LATTICE_PI_PACKAGE : undefined) ?? piPackageOf(env.LATTICE_PI_STARTED) ?? piPackageOf(env.LATTICE_PI_BIN) ?? piPackageOf(onPath(env));
			if (!dir) throw new Error("Pi's library was not found, so a session that is not running cannot be read. Put `pi` on the PATH, or set LATTICE_PI_PACKAGE to the directory of @earendil-works/pi-coding-agent.");
			return (await import(pathToFileURL(entryOf(dir)).href)) as PiLibrary;
		}
	})();
	loaded.catch(() => {
		loaded = undefined;
	});
	return loaded;
}
