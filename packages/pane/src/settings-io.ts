/** Reading and writing the two settings files. What they may hold is the contract's business; this is only the files. */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { latticeHome, parseSettings, repoConfigPath, resolveSettings, type SettingScope, type Settings, type SettingsFile, type SettingValue, type TemplateName, TEMPLATES, templatePaths, userConfigPath, withSetting } from "@pi-lattice/protocol";

/** Where this person's own settings, roles and templates are kept. */
export function userDir(): string {
	return latticeHome(process.env, homedir());
}

export interface SettingsRead {
	settings: Settings;
	/** The files, whether or not they exist yet. There is no repository file outside a repository's tree. */
	paths: { user: string; repo: string | undefined };
	/** What each file sets by itself, so a screen can say what clearing a value would reveal. */
	files: { user: SettingsFile | undefined; repo: SettingsFile | undefined };
	/** Everything wrong with either file, each with the file it is in. */
	problems: string[];
}

let cache: { stamps: string; read: SettingsRead } | undefined;

const stamp = (path: string | undefined): string => {
	if (!path) return "";
	try {
		const stat = statSync(path);
		return `${path}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return `${path}:`;
	}
};

/** The settings in effect for a tree, given its state directory, or for no tree at all. Read again only when a file changes. */
export function readSettings(stateDir: string | undefined): SettingsRead {
	const paths = { user: userConfigPath(userDir()), repo: stateDir ? repoConfigPath(stateDir) : undefined };
	const stamps = `${stamp(paths.user)}|${stamp(paths.repo)}`;
	if (cache?.stamps === stamps) return cache.read;
	const problems: string[] = [];
	const load = (path: string | undefined): SettingsFile | undefined => {
		if (!path || !existsSync(path)) return undefined;
		try {
			const file = parseSettings(readFileSync(path, "utf8"));
			problems.push(...file.problems.map((problem) => `${path}: ${problem}`));
			return file;
		} catch (error) {
			problems.push(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};
	const files = { user: load(paths.user), repo: load(paths.repo) };
	const read: SettingsRead = { settings: resolveSettings({ ...files, env: process.env }), paths, files, problems };
	cache = { stamps, read };
	return read;
}

/** Change one setting in one of the files, or clear it with `undefined`. Returns the file written. */
export function writeSetting(scope: SettingScope, stateDir: string | undefined, key: string, value: SettingValue | undefined): string {
	const path = scope === "user" ? userConfigPath(userDir()) : stateDir ? repoConfigPath(stateDir) : undefined;
	if (!path) throw new Error("There is no session tree here to keep a repository setting in.");
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
		JSON.parse(text);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${path} is not valid JSON, so it was left alone. Fix or delete it first.`);
		text = undefined;
	}
	mkdirSync(dirname(path), { recursive: true });
	// The file can hold credentials for background sessions, so only this person may read it.
	writeFileSync(path, withSetting(text, key, value), { mode: 0o600 });
	cache = undefined;
	return path;
}

/** A template as it is used here: the text, and whose it is. */
export interface TemplateRead {
	name: TemplateName;
	text: string;
	source: "builtin" | "user" | "repo";
	/** The file it was read from, when someone has replaced the built-in text. */
	path: string | undefined;
}

/** The text pi-lattice uses for a template in a tree: this repository's, else the person's own, else the built-in one. */
export function readTemplate(name: TemplateName, stateDir: string | undefined): TemplateRead {
	for (const { path, source } of templatePaths(name, { stateDir, userDir: userDir() })) {
		try {
			const text = readFileSync(path, "utf8");
			if (text.trim() !== "") return { name, text, source, path };
		} catch {
			// Not replaced there.
		}
	}
	return { name, text: TEMPLATES[name].text, source: "builtin", path: undefined };
}

/** Where a person's replacement for a template goes. */
export function templatePath(name: TemplateName, scope: SettingScope, stateDir: string | undefined): string {
	const found = templatePaths(name, { stateDir, userDir: userDir() }).find((entry) => entry.source === scope);
	if (!found) throw new Error("There is no session tree here to keep a repository's template in.");
	return found.path;
}

/** Replace a template's text, or with `undefined` remove the replacement so the one under it is used again. */
export function writeTemplate(name: TemplateName, scope: SettingScope, stateDir: string | undefined, text: string | undefined): string {
	const path = templatePath(name, scope, stateDir);
	if (text === undefined) rmSync(path, { force: true });
	else {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
	}
	return path;
}
