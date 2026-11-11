/**
 * The texts pi-lattice itself writes into a session, as a contract: what each is for, what it
 * may mention, and what it says unless someone has replaced it. A person replaces one by
 * putting `<name>.md` in a templates folder: this repository's (`.lattice/templates/`) or their
 * own (`<lattice home>/templates/`). This module does no I/O; the host and the pane read the files.
 */

export interface Template {
	name: string;
	/** When it is used, in one line. */
	summary: string;
	/** The names it may mention as `{{name}}`. */
	vars: readonly string[];
	text: string;
}

/**
 * What an agent is told when its session moved between the background and a terminal in
 * the middle of a turn. The turn itself cannot move between processes, so it is stopped
 * on one side and picked up again on the other.
 */
export const HANDOVER_NOTE =
	"[pi-lattice] This session was moved between the background and a terminal while you were working, which interrupted your last step. This note is from pi-lattice, not from the user. Carry on from where you left off.";

export const TEMPLATES = {
	brief: {
		name: "brief",
		summary: "The first thing a child session is told: who created it, then the brief.",
		vars: ["parent.name", "parent.id", "name", "kind", "branch", "brief"],
		text: [
			'[pi-lattice] This session was created by another agent session, "{{parent.name}}" ({{parent.id}}), as its child "{{name}}" (kind: {{kind}}).',
			"The brief below is from that agent, not typed by the user. The user can see this session and may join it at any time; their instructions take priority.",
			"{{#branch}}You are working in your own git worktree on branch {{branch}}. Commit your work there.",
			"{{/branch}}",
			"",
			"Brief:",
			"{{brief}}",
		].join("\n"),
	},
	handover: {
		name: "handover",
		summary: "What an agent is told when its session moved between the background and a terminal mid-turn.",
		vars: [],
		text: HANDOVER_NOTE,
	},
	reminder: {
		name: "reminder",
		summary: "What a child is told when it ends its turn without reporting to its parent.",
		vars: ["parent.name"],
		text: [
			'[pi-lattice] You ended your turn without reporting to your parent, "{{parent.name}}", which is waiting on you and cannot see this conversation. This note is from pi-lattice, not from the user.',
			'If the work is done, send your report now: send_message to "parent" with intent "result". If you are blocked, send "parent" a message with intent "ask" saying what you need.',
		].join("\n"),
	},
	"child-stopped": {
		name: "child-stopped",
		summary: "What a parent is told when a child stops without reporting.",
		vars: ["name", "id", "reason", "last"],
		text: [
			'[pi-lattice] Your child session "{{name}}" ({{id}}) stopped without reporting: {{reason}}. This note is from pi-lattice, not from the child and not from the user.',
			"Its work may be unfinished. Check what it left, then send it a message to start it again, do the work yourself, or tell the user.",
			"{{#last}}The last thing it said: {{last}}{{/last}}",
		].join("\n"),
	},
} as const satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

export function isTemplateName(value: string): value is TemplateName {
	return value in TEMPLATES;
}

/**
 * Fill a template in. `{{name}}` becomes the value; `{{#name}}…{{/name}}` is kept only when
 * the value is not empty. Values are put in once and never read as template text themselves,
 * so a brief that contains braces stays as it was written.
 */
export function renderTemplate(text: string, values: Record<string, string | undefined | null>): string {
	const has = (name: string): boolean => (values[name] ?? "") !== "";
	const kept = text.replace(/\{\{#([\w.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}\n?/g, (_match, name: string, inside: string) => (has(name) ? inside : ""));
	return kept.replace(/\{\{([\w.-]+)\}\}/g, (match, name: string) => (name in values ? (values[name] ?? "") : match)).trim();
}

/** Where a replacement for a template is looked for, first match wins: this repository's, then the person's own. */
export function templatePaths(name: string, dirs: { stateDir?: string | undefined; userDir: string }): Array<{ path: string; source: "repo" | "user" }> {
	return [
		...(dirs.stateDir ? [{ path: `${dirs.stateDir}/templates/${name}.md`, source: "repo" as const }] : []),
		{ path: `${dirs.userDir}/templates/${name}.md`, source: "user" as const },
	];
}
