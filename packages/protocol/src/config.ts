/**
 * Settings, as a contract. One table says every setting there is: what it is called, what it
 * accepts, what it defaults to and which environment variable overrides it. The settings
 * screen, the `/lattice config` command, validation and the checks all read this table.
 *
 * A setting's value comes from the first of these that has one: the environment, the
 * repository's file (`<repository>/.lattice/config.json`), the person's file
 * (`<lattice home>/config.json`), the default. This module does no I/O: the host and the pane
 * read the files and hand their text in.
 */
import { APPROVAL_POLICIES } from "./inbound.ts";
import { DEFAULT_LIMITS, type Limits } from "./limits.ts";

export const CONFIG_FILE = "config.json";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SettingValue = string | number | boolean | string[];
export type SettingKind = "text" | "choice" | "number" | "toggle" | "list";
/** Where a value came from. `repo` and `user` are the two files a person edits. */
export type SettingSource = "default" | "user" | "repo" | "env";
/** The two files, by who they are for. */
export type SettingScope = "user" | "repo";

export interface Setting {
	/** The name used in commands and, split at the dots, the path in the file. */
	key: string;
	section: string;
	label: string;
	/** One sentence a person reads when the cursor is on it. */
	help: string;
	kind: SettingKind;
	choices?: readonly string[];
	/** Absent means "not set": the setting has no value until someone gives it one. */
	default?: SettingValue;
	/** The environment variable that overrides both files. */
	env?: string;
	min?: number;
	max?: number;
	/** When a change is felt. */
	applies: string;
}

const NEXT_SESSION = "Applies to background sessions started from now on; /lattice restart applies it to the ones running.";
const NEW_SESSIONS = "Applies to sessions created from now on.";
const AT_ONCE = "Applies at once.";

const limit = (name: keyof Limits, section: string, label: string, help: string, env: string, applies: string): Setting => ({
	key: `limits.${name}`, section, label, help, kind: "number", default: DEFAULT_LIMITS[name], env, min: 1, applies,
});

/** Every setting, in the order the settings screen shows them. */
export const SETTINGS: readonly Setting[] = [
	{ key: "model", section: "Background sessions", label: "Model", help: "The model background sessions run on, as `pi --model` takes it. A session given its own model keeps it.", kind: "text", applies: NEXT_SESSION },
	{ key: "thinking", section: "Background sessions", label: "Thinking", help: "How much background sessions think before they answer.", kind: "choice", choices: THINKING_LEVELS, applies: NEXT_SESSION },

	{ key: "roles.tree", section: "Roles", label: "Every session", help: "Role fragments every session in a tree is given. `protocol` is what tells sessions how to talk to each other.", kind: "list", default: ["protocol"], applies: NEW_SESSIONS },
	{ key: "roles.children", section: "Roles", label: "Every child", help: "Role fragments every child session is given as well, whatever roles were chosen for it. `reporting` is what tells a child how to answer its parent.", kind: "list", default: ["reporting"], applies: NEW_SESSIONS },
	{ key: "roles.root", section: "Roles", label: "First session", help: "Roles for the session that starts a tree, for example coordinator. Empty leaves it as a plain Pi session.", kind: "list", default: [], applies: NEW_SESSIONS },
	{ key: "roles.child", section: "Roles", label: "Child with no roles", help: "Roles for a child that was created without any.", kind: "list", default: ["worker"], applies: NEW_SESSIONS },

	{ key: "approval", section: "Messaging", label: "Approval", help: "Which messages between agents wait for you: those from other people's sessions (cross-owner), all of them (always), or none (never).", kind: "choice", choices: APPROVAL_POLICIES, default: "cross-owner", env: "LATTICE_APPROVAL", applies: "Applies at once to the session open here, and to background sessions started from now on." },
	{ key: "reports.remind", section: "Messaging", label: "Remind a child", help: "When a background child ends its turn without reporting to its parent, remind it once; if it still says nothing, tell its parent.", kind: "toggle", default: true, applies: AT_ONCE },
	limit("maxHops", "Messaging", "Hops", "How many times an exchange may pass between agents before a person has to speak. Stops two agents answering each other forever.", "LATTICE_MAX_HOPS", NEXT_SESSION),
	limit("maxSendsPerMinute", "Messaging", "Sends a minute", "How many messages one session may send in a minute.", "LATTICE_MAX_SENDS_PER_MINUTE", NEXT_SESSION),
	limit("maxPayloadBytes", "Messaging", "Message size", "The largest message, in bytes. Anything bigger should travel as a file.", "LATTICE_MAX_PAYLOAD_BYTES", NEXT_SESSION),

	limit("maxDepth", "Tree", "Depth", "How many levels of children a tree may have below its first session.", "LATTICE_MAX_DEPTH", AT_ONCE),
	limit("maxChildren", "Tree", "Children", "How many children one session may have.", "LATTICE_MAX_CHILDREN", AT_ONCE),
	limit("maxNodes", "Tree", "Sessions", "How many sessions one tree may hold.", "LATTICE_MAX_NODES", AT_ONCE),
	limit("maxRunning", "Tree", "Running", "How many background sessions run at the same time. The least recently used idle one sleeps to make room.", "LATTICE_MAX_RUNNING", AT_ONCE),

	{ key: "network.share", section: "Network", label: "Share this tree", help: "Show this tree to the people in your network, and theirs here. Off, set for one repository, keeps that repository to yourself.", kind: "toggle", default: true, applies: AT_ONCE },
	{ key: "network.cloneDir", section: "Network", label: "Clone into", help: "The folder a teammate's repository is cloned into when you take a session from one you do not have. Asked for the first time it is needed.", kind: "text", applies: AT_ONCE },

	{ key: "pane.autoStart", section: "Pane", label: "Start a tree", help: "In a git repository, the first message starts a session tree without anything being typed.", kind: "toggle", default: true, env: "LATTICE_AUTO_START", applies: AT_ONCE },
	{ key: "pane.autoJoin", section: "Pane", label: "Join the tree", help: "A new session joins its repository's tree with its first message.", kind: "toggle", default: true, env: "LATTICE_AUTO_JOIN", applies: AT_ONCE },
	{ key: "pane.bell", section: "Pane", label: "Bell", help: "Ring the terminal when one more thing starts waiting on you.", kind: "toggle", default: true, env: "LATTICE_BELL", applies: AT_ONCE },
	{ key: "pane.width", section: "Pane", label: "Width", help: "How many columns the pane takes.", kind: "number", default: 34, min: 24, max: 60, applies: "Applies the next time Pi starts." },
];

const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));

export function settingOf(key: string): Setting | undefined {
	return BY_KEY.get(key);
}

/** What a setting accepts, in a few words. */
export function settingAccepts(setting: Setting): string {
	if (setting.kind === "choice") return (setting.choices ?? []).join(" | ");
	if (setting.kind === "toggle") return "on | off";
	if (setting.kind === "list") return "names separated by spaces, or none";
	if (setting.kind === "number") return `a whole number${setting.min !== undefined ? ` from ${setting.min}` : ""}${setting.max !== undefined ? ` to ${setting.max}` : ""}`;
	return "text";
}

/** A value as a person reads and types it. */
export function formatSetting(value: SettingValue | undefined): string {
	if (value === undefined) return "not set";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (Array.isArray(value)) return value.length > 0 ? value.join(" ") : "none";
	return String(value);
}

const ON = ["on", "true", "yes", "1"];
const OFF = ["off", "false", "no", "0"];

/** Check a value of any shape against a setting. Returns the value in its proper type, or what is wrong with it. */
function check(setting: Setting, raw: unknown): { value: SettingValue } | { problem: string } {
	const bad = { problem: `${setting.key} takes ${settingAccepts(setting)}.` };
	if (setting.kind === "toggle") {
		if (typeof raw === "boolean") return { value: raw };
		if (typeof raw !== "string") return bad;
		const word = raw.trim().toLowerCase();
		return ON.includes(word) ? { value: true } : OFF.includes(word) ? { value: false } : bad;
	}
	if (setting.kind === "number") {
		const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
		if (!Number.isInteger(number) || number < (setting.min ?? Number.MIN_SAFE_INTEGER) || number > (setting.max ?? Number.MAX_SAFE_INTEGER)) return bad;
		return { value: number };
	}
	if (setting.kind === "list") {
		const names = Array.isArray(raw) ? raw : typeof raw === "string" ? (raw.trim().toLowerCase() === "none" ? [] : raw.split(/[\s,+]+/)) : undefined;
		if (!names || names.some((name) => typeof name !== "string")) return bad;
		return { value: [...new Set((names as string[]).map((name) => name.trim()).filter(Boolean))] };
	}
	if (typeof raw !== "string" || raw.trim() === "") return bad;
	if (setting.kind === "choice" && !(setting.choices ?? []).includes(raw.trim())) return bad;
	return { value: raw.trim() };
}

/** Read what a person typed for a setting. */
export function parseSettingInput(key: string, text: string): { value: SettingValue } | { problem: string } {
	const setting = BY_KEY.get(key);
	if (!setting) return { problem: `Unknown setting "${key}". Settings: ${SETTINGS.map((entry) => entry.key).join(", ")}.` };
	return check(setting, text);
}

/** What one settings file holds. */
export interface SettingsFile {
	values: Record<string, SettingValue>;
	/** Extra environment for background sessions, for example an API key. */
	env: Record<string, string>;
	problems: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const at = (record: Record<string, unknown>, key: string): unknown => {
	let value: unknown = record;
	for (const part of key.split(".")) {
		if (!isRecord(value)) return undefined;
		value = value[part];
	}
	return value;
};

/**
 * Read a settings file's text. Throws on text that is not a JSON object; a setting with a
 * value it cannot take is left out and named in `problems`.
 */
export function parseSettings(text: string): SettingsFile {
	const raw = JSON.parse(text) as unknown;
	if (!isRecord(raw)) throw new Error("the settings must be a JSON object");
	const file: SettingsFile = { values: {}, env: {}, problems: [] };
	for (const setting of SETTINGS) {
		const value = at(raw, setting.key);
		if (value === undefined || value === null || value === "") continue;
		const checked = check(setting, value);
		if ("problem" in checked) file.problems.push(checked.problem);
		else file.values[setting.key] = checked.value;
	}
	if (raw.env !== undefined) {
		if (!isRecord(raw.env)) file.problems.push("env must be an object of names to text.");
		else file.env = Object.fromEntries(Object.entries(raw.env).filter(([, value]) => typeof value === "string")) as Record<string, string>;
	}
	return file;
}

/** A file's text with one setting changed, or removed when `value` is undefined. Everything else is kept. */
export function withSetting(text: string | undefined, key: string, value: SettingValue | undefined): string {
	let record: Record<string, unknown> = {};
	if (text !== undefined && text.trim() !== "") {
		const raw = JSON.parse(text) as unknown;
		if (isRecord(raw)) record = structuredClone(raw);
	}
	const parts = key.split(".");
	const last = parts.pop() as string;
	const path: Array<Record<string, unknown>> = [record];
	for (const part of parts) {
		const here = path[path.length - 1] as Record<string, unknown>;
		if (!isRecord(here[part])) {
			if (value === undefined) return `${JSON.stringify(record, null, 2)}\n`;
			here[part] = {};
		}
		path.push(here[part] as Record<string, unknown>);
	}
	const leaf = path[path.length - 1] as Record<string, unknown>;
	if (value === undefined) delete leaf[last];
	else leaf[last] = value;
	// A group left empty by a removal goes too.
	for (let index = path.length - 1; index > 0; index--) {
		if (Object.keys(path[index] as object).length === 0) delete (path[index - 1] as Record<string, unknown>)[parts[index - 1] as string];
	}
	return `${JSON.stringify(record, null, 2)}\n`;
}

/** Every setting with the value in effect and where it came from. */
export interface Settings {
	values: Record<string, SettingValue | undefined>;
	sources: Record<string, SettingSource>;
	/** Extra environment for background sessions: the person's, then the repository's on top. */
	env: Record<string, string>;
	problems: string[];
}

/** Put the layers together. Anything missing or wrong in one layer falls through to the next. */
export function resolveSettings(layers: { user?: SettingsFile | undefined; repo?: SettingsFile | undefined; env?: Record<string, string | undefined> | undefined } = {}): Settings {
	const settings: Settings = { values: {}, sources: {}, env: { ...layers.user?.env, ...layers.repo?.env }, problems: [...(layers.user?.problems ?? []), ...(layers.repo?.problems ?? [])] };
	for (const setting of SETTINGS) {
		const fromEnv = setting.env !== undefined ? layers.env?.[setting.env] : undefined;
		const checked = fromEnv !== undefined && fromEnv !== "" ? check(setting, fromEnv) : undefined;
		if (checked && "value" in checked) {
			settings.values[setting.key] = checked.value;
			settings.sources[setting.key] = "env";
		} else if (layers.repo?.values[setting.key] !== undefined) {
			settings.values[setting.key] = layers.repo.values[setting.key];
			settings.sources[setting.key] = "repo";
		} else if (layers.user?.values[setting.key] !== undefined) {
			settings.values[setting.key] = layers.user.values[setting.key];
			settings.sources[setting.key] = "user";
		} else {
			settings.values[setting.key] = setting.default;
			settings.sources[setting.key] = "default";
		}
	}
	return settings;
}

/** The limits in effect. */
export function limitsOf(settings: Settings): Limits {
	const limits = { ...DEFAULT_LIMITS };
	for (const name of Object.keys(limits) as Array<keyof Limits>) {
		const value = settings.values[`limits.${name}`];
		if (typeof value === "number") limits[name] = value;
	}
	return limits;
}

export const textSetting = (settings: Settings, key: string): string | undefined => (typeof settings.values[key] === "string" ? (settings.values[key] as string) : undefined);
export const listSetting = (settings: Settings, key: string): string[] => (Array.isArray(settings.values[key]) ? (settings.values[key] as string[]) : []);
export const toggleSetting = (settings: Settings, key: string): boolean => settings.values[key] === true;
export const numberSetting = (settings: Settings, key: string, fallback: number): number => (typeof settings.values[key] === "number" ? (settings.values[key] as number) : fallback);

/** The person's own settings file, given their lattice home. It applies to every repository. */
export const userConfigPath = (home: string): string => `${home}/${CONFIG_FILE}`;
/** A repository's settings file, given its tree's state directory. */
export const repoConfigPath = (stateDir: string): string => `${stateDir}/${CONFIG_FILE}`;

/**
 * The roles a new session is given: the ones every session gets, the ones every child gets,
 * then the ones chosen for it, or the default for its place when none were chosen.
 */
export function rolesFor(settings: Settings, place: "root" | "child", chosen: readonly string[] = []): string[] {
	const own = chosen.length > 0 ? chosen : listSetting(settings, place === "root" ? "roles.root" : "roles.child");
	return [...new Set([...listSetting(settings, "roles.tree"), ...(place === "child" ? listSetting(settings, "roles.children") : []), ...own])];
}
