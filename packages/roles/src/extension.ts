/**
 * pi-lattice roles: composable roles for a session.
 *
 * A session has no fixed type. It has a list of applied fragments that the human (or a
 * coordinator, at spawn time) chooses and can change mid-session. Each applied fragment
 * becomes one system prompt section.
 */
import { readFileSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { emitEvent, onEvent, PROTOCOL_VERSION } from "@pi-lattice/protocol";
import { Type } from "typebox";
import { advisories, editRoles, INDEX_SECTION, type RoleEdit, roleSections, SECTION_PREFIX } from "./compose.ts";
import { type Fragment, fragmentRoots, loadFragments } from "./fragments.ts";

const ROLES_ENTRY = "lattice:roles";

function rolesIn(entries: Iterable<{ type?: string; customType?: string; data?: unknown }>): string[] | undefined {
	let found: string[] | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ROLES_ENTRY) continue;
		const fragments = (entry.data as { fragments?: unknown } | undefined)?.fragments;
		if (Array.isArray(fragments)) found = fragments.filter((name): name is string => typeof name === "string");
	}
	return found;
}

function rolesInFile(sessionFile: string | undefined): string[] | undefined {
	if (!sessionFile) return undefined;
	try {
		const entries = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.includes(ROLES_ENTRY))
			.map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown });
		return rolesIn(entries);
	} catch {
		return undefined;
	}
}

export default function rolesExtension(pi: ExtensionAPI): void {
	let applied: string[] = [];
	let available = new Map<string, Fragment>();
	let context: ExtensionContext | undefined;

	const reload = (ctx: ExtensionContext): void => {
		available = loadFragments(fragmentRoots({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() }));
	};

	const describe = (): string => (applied.length > 0 ? applied.join(" + ") : "none");

	const refreshStatus = (): void => {
		if (context?.hasUI) context.ui.setStatus("lattice-roles", applied.length > 0 ? `roles: ${describe()}` : undefined);
	};

	/** Change the applied list, persist it, and tell other extensions. Returns text for the caller. */
	const change = (edit: RoleEdit, names: string[]): { ok: boolean; text: string } => {
		if (context) reload(context);
		const result = editRoles(applied, edit, names, available);
		if (result.unknown.length > 0) {
			return {
				ok: false,
				text: `Unknown role fragment${result.unknown.length > 1 ? "s" : ""}: ${result.unknown.join(", ")}. Available: ${[...available.keys()].join(", ") || "none"}.`,
			};
		}
		if (result.changed) {
			applied = result.fragments;
			pi.appendEntry(ROLES_ENTRY, { fragments: applied });
			emitEvent(pi.events, "lattice:roles:changed", { fragments: [...applied] });
			refreshStatus();
		}
		const notes = advisories(applied, available);
		return {
			ok: true,
			text: [`Roles: ${describe()}.${result.changed ? " Takes effect on the next turn." : " No change."}`, ...notes.map((note) => `Note: ${note}`)].join("\n"),
		};
	};

	pi.on("session_start", async (event, ctx) => {
		context = ctx;
		emitEvent(pi.events, "lattice:hello", { package: "roles", protocol: PROTOCOL_VERSION });
		reload(ctx);
		const recorded = rolesIn(ctx.sessionManager.getEntries());
		// A new conversation in the same place keeps its roles; a spawned session takes the ones it was given.
		const inherited = event.reason === "new" ? rolesInFile(event.previousSessionFile) : undefined;
		const seeded = (process.env.LATTICE_FRAGMENTS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
		applied = recorded ?? inherited ?? seeded;
		if (recorded === undefined && applied.length > 0) pi.appendEntry(ROLES_ENTRY, { fragments: applied });
		refreshStatus();
		emitEvent(pi.events, "lattice:roles:changed", { fragments: [...applied] });
	});

	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions.sections;
		for (const key of Object.keys(sections)) {
			if (key === INDEX_SECTION || key.startsWith(SECTION_PREFIX)) delete sections[key];
		}
		Object.assign(sections, roleSections(applied, available));
	});

	onEvent(pi.events, "lattice:roles:set", (request) => {
		change("set", request.fragments);
	});

	pi.registerTool({
		name: "apply_role",
		label: "Apply role",
		description:
			"Change the role fragments applied to this session. Roles are composable pieces of guidance; mode set replaces the list, add appends, remove drops. Call with no fragments to see what is applied and what is available.",
		promptSnippet: "Change which role fragments guide this session",
		promptGuidelines: ["Use apply_role only when the user asks to change this session's roles, or when an applied role's guidance says to move to another phase."],
		parameters: Type.Object({
			fragments: Type.Optional(Type.Array(Type.String(), { description: "Fragment names" })),
			mode: Type.Optional(Type.String({ description: "set (default), add, or remove" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			context = ctx;
			if (!params.fragments || params.fragments.length === 0) {
				reload(ctx);
				const lines = [...available.values()].map((fragment) => `${fragment.name}: ${fragment.summary || "(no summary)"}`);
				return { content: [{ type: "text", text: [`Applied: ${describe()}.`, "Available:", ...lines].join("\n") }], details: { fragments: applied } };
			}
			const mode = params.mode ?? "set";
			if (mode !== "set" && mode !== "add" && mode !== "remove") throw new Error(`Unknown mode "${mode}". Use set, add or remove.`);
			const result = change(mode, params.fragments);
			if (!result.ok) throw new Error(result.text);
			return { content: [{ type: "text", text: result.text }], details: { fragments: applied } };
		},
	});

	pi.registerCommand("role", {
		description: "Compose this session's roles. Usage: /role [show|list|add <names>|remove <names>|set <names>|clear]",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			if (words.length <= 1) {
				const verbs = ["show", "list", "add", "remove", "set", "clear"].filter((verb) => verb.startsWith(words[0] ?? ""));
				return verbs.length > 0 ? verbs.map((verb) => ({ value: verb, label: verb })) : null;
			}
			const last = words[words.length - 1] ?? "";
			const head = words.slice(0, -1).join(" ");
			const pool = words[0] === "remove" ? applied : [...available.keys()];
			const names = pool.filter((name) => name.startsWith(last));
			return names.length > 0 ? names.map((name) => ({ value: `${head} ${name}`, label: name })) : null;
		},
		handler: async (args, ctx) => {
			context = ctx;
			const [verb = "show", ...names] = args.trim().split(/[\s,+]+/).filter(Boolean);
			if (verb === "show") {
				reload(ctx);
				ctx.ui.notify([`Roles: ${describe()}.`, ...advisories(applied, available).map((note) => `Note: ${note}`)].join("\n"), "info");
			} else if (verb === "list") {
				reload(ctx);
				const lines = [...available.values()].map((f) => `${applied.includes(f.name) ? "*" : " "} ${f.name} (${f.source}): ${f.summary || "(no summary)"}`);
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No role fragments are installed.", "info");
			} else if (verb === "add" || verb === "remove" || verb === "set") {
				if (names.length === 0) {
					ctx.ui.notify(`Usage: /role ${verb} <fragment names>`, "warning");
					return;
				}
				const result = change(verb, names);
				ctx.ui.notify(result.text, result.ok ? "info" : "warning");
			} else if (verb === "clear") {
				ctx.ui.notify(change("set", []).text, "info");
			} else {
				ctx.ui.notify("Usage: /role [show|list|add <names>|remove <names>|set <names>|clear]", "warning");
			}
		},
	});
}
