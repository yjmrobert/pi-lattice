/**
 * A tree's settings, as a contract: one JSON file in its state directory, read by the host
 * each time it starts a session, so a change applies to the next session without a restart.
 * This module says what the file holds; the host reads it and the pane edits it.
 */
import { APPROVAL_POLICIES } from "./inbound.ts";

export const CONFIG_FILE = "config.json";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface TreeConfig {
	/** The model background sessions run on, as Pi's `--model` takes it. A session's own model wins. */
	model?: string;
	/** Thinking level for background sessions. */
	thinking?: (typeof THINKING_LEVELS)[number];
	/** Which inbound agent messages need a person's approval. */
	approval?: (typeof APPROVAL_POLICIES)[number];
	/** Extra environment for background sessions, for example an API key. */
	env?: Record<string, string>;
}

/** The settings a person can change by name, with what each accepts. */
export const CONFIG_KEYS = {
	model: "a model as `pi --model` takes it, for example anthropic/claude-haiku-4-5",
	thinking: THINKING_LEVELS.join(" | "),
	approval: APPROVAL_POLICIES.join(" | "),
} as const;
export type ConfigKey = keyof typeof CONFIG_KEYS;

/** Check one setting. Returns what is wrong with it, or undefined when it is fine. */
export function configProblem(key: string, value: string): string | undefined {
	if (!(key in CONFIG_KEYS)) return `Unknown setting "${key}". Settings: ${Object.keys(CONFIG_KEYS).join(", ")}.`;
	if (key === "thinking" && !(THINKING_LEVELS as readonly string[]).includes(value)) return `thinking is one of: ${THINKING_LEVELS.join(", ")}.`;
	if (key === "approval" && !(APPROVAL_POLICIES as readonly string[]).includes(value)) return `approval is one of: ${APPROVAL_POLICIES.join(", ")}.`;
	if (value.trim() === "") return `${key} needs a value.`;
	return undefined;
}

/**
 * Read settings from the file's text. Throws on text that is not a JSON object; settings with
 * a value of the wrong kind are left out and named in `problems`.
 */
export function parseConfig(text: string): { config: TreeConfig; problems: string[] } {
	const raw = JSON.parse(text) as unknown;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the settings must be a JSON object");
	const record = raw as Record<string, unknown>;
	const config: TreeConfig = {};
	const problems: string[] = [];
	for (const key of Object.keys(CONFIG_KEYS) as ConfigKey[]) {
		const value = record[key];
		if (value === undefined || value === null || value === "") continue;
		const problem = typeof value === "string" ? configProblem(key, value) : `${key} must be text.`;
		if (problem) problems.push(problem);
		else (config as Record<string, unknown>)[key] = value;
	}
	if (record.env !== undefined) {
		if (typeof record.env !== "object" || record.env === null || Array.isArray(record.env)) problems.push("env must be an object of names to text.");
		else config.env = Object.fromEntries(Object.entries(record.env as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string>;
	}
	return { config, problems };
}

/** The file's text with one setting changed, or removed when `value` is undefined. Everything else is kept. */
export function withSetting(text: string | undefined, key: ConfigKey, value: string | undefined): string {
	let record: Record<string, unknown> = {};
	if (text !== undefined && text.trim() !== "") {
		const raw = JSON.parse(text) as unknown;
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) record = { ...(raw as Record<string, unknown>) };
	}
	if (value === undefined) delete record[key];
	else record[key] = value;
	return `${JSON.stringify(record, null, 2)}\n`;
}
