/**
 * pi-lattice roles: composable roles for a session.
 *
 * A session has no fixed type. It has a list of applied fragments that the human (or a
 * coordinator, at spawn time) chooses and can change mid-session. Each applied fragment
 * becomes one system prompt section.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { assignmentFromEnv, emitEvent, HOST_ENV, type HostAssignment, onEvent, PROTOCOL_VERSION } from "@pi-lattice/protocol";
import { Type } from "typebox";
import { advisories, editRoles, INDEX_SECTION, type RoleEdit, roleSections, SECTION_PREFIX } from "./compose.ts";
import { type Fragment, fragmentRoots, isFragmentName, loadFragments, parseFragment } from "./fragments.ts";

const ROLES_ENTRY = "lattice:roles";

/** Where a fragment comes from, in a person's words. */
const SOURCE_WORDS: Record<string, string> = { builtin: "built in", user: "yours", project: "this project's" };

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
	let assigned: HostAssignment | undefined;
	/** Whether this session has ever had roles chosen for it, so a late assignment does not override them. */
	let everSet = false;

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
			everSet = true;
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
		// A node created with roles brings them: from the host that started us, or from whoever opened it here.
		// LATTICE_FRAGMENTS alone also works, for starting a plain session with roles.
		const seeded =
			(assigned ?? assignmentFromEnv(process.env))?.fragments ??
			(process.env[HOST_ENV.fragments] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
		applied = recorded ?? inherited ?? seeded;
		everSet = recorded !== undefined || applied.length > 0;
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

	// A session opened as a node after it started takes the node's roles, unless it already has its own.
	onEvent(pi.events, "lattice:host:assigned", ({ assignment }) => {
		assigned = assignment ?? undefined;
		if (!context || everSet || !assignment || assignment.fragments.length === 0) return;
		// A role this installation does not have adds nothing; it must not stop the others from being applied.
		reload(context);
		const known = assignment.fragments.filter((name) => available.has(name));
		if (known.length > 0) change("set", known);
	});

	// Whoever builds a form for choosing roles asks what there is to choose from.
	onEvent(pi.events, "lattice:roles:available", (request) => {
		if (!context) return;
		reload(context);
		for (const fragment of available.values()) {
			if (request.names.includes(fragment.name)) continue;
			request.names.push(fragment.name);
			(request.fragments ??= []).push({ name: fragment.name, summary: fragment.summary, source: fragment.source, path: fragment.path });
		}
	});

	// Whoever shows a person what this session has been told asks each extension for its part.
	onEvent(pi.events, "lattice:prompt:describe", (request) => {
		if (!context) return;
		const sections = roleSections(applied, available);
		for (const [key, text] of Object.entries(sections)) {
			const fragment = key.startsWith(SECTION_PREFIX) ? available.get(key.slice(SECTION_PREFIX.length)) : undefined;
			request.parts.push({
				title: fragment ? `Role: ${fragment.name}` : "Roles",
				source: fragment ? `${SOURCE_WORDS[fragment.source] ?? fragment.source} · ${fragment.path}` : "written by pi-lattice from the list of roles",
				where: `system prompt, section <${key}>`,
				text,
			});
		}
	});

	/** Where a person's own version of a fragment is kept: theirs, or this project's. */
	const ownPath = (ctx: ExtensionContext, name: string, scope: "user" | "project"): string =>
		join(scope === "user" ? join(getAgentDir(), "lattice", "roles") : join(ctx.cwd, ".pi", "lattice", "roles"), `${name}.md`);

	/** Show a fragment in full, with where it comes from. */
	const show = (ctx: ExtensionContext, name: string): void => {
		reload(ctx);
		const fragment = available.get(name);
		if (!fragment) {
			ctx.ui.notify(`No role fragment "${name}". Available: ${[...available.keys()].join(", ") || "none"}.`, "warning");
			return;
		}
		ctx.ui.notify(
			[
				`${fragment.name} · ${SOURCE_WORDS[fragment.source] ?? fragment.source} · ${fragment.path}`,
				fragment.summary,
				...(fragment.requires.length > 0 ? [`usually with: ${fragment.requires.join(", ")}`] : []),
				...(fragment.conflicts.length > 0 ? [`competes with: ${fragment.conflicts.join(", ")}`] : []),
				"",
				fragment.body,
				"",
				`/role edit ${fragment.name} opens it for editing.`,
			].join("\n"),
			"info",
		);
	};

	/**
	 * Edit a fragment in Pi's editor. Saving writes the person's own copy, which is used in place
	 * of the built-in one; saving it empty removes that copy, so the one under it is used again.
	 */
	const edit = async (ctx: ExtensionContext, name: string, scopeWord: string | undefined): Promise<void> => {
		if (!isFragmentName(name)) {
			ctx.ui.notify(`"${name}" cannot be a role name. Use lowercase letters, digits and dashes.`, "warning");
			return;
		}
		if (scopeWord !== undefined && scopeWord !== "user" && scopeWord !== "project") {
			ctx.ui.notify("Usage: /role edit <name> [user|project]", "warning");
			return;
		}
		const scope = scopeWord ?? "user";
		if (scope === "project" && !ctx.isProjectTrusted()) {
			ctx.ui.notify("This project is not trusted, so its roles are not read. Trust it first, or edit your own copy with /role edit <name>.", "warning");
			return;
		}
		reload(ctx);
		const existing = available.get(name);
		const path = ownPath(ctx, name, scope);
		const starting = existsSync(path)
			? readFileSync(path, "utf8")
			: existing
				? readFileSync(existing.path, "utf8")
				: `---\nname: ${name}\nsummary: One line saying what this role is for.\n---\nWhat a session with this role should do.\n`;
		const where = scope === "user" ? "your own copy, used in every repository" : "this project's copy";
		const text = await ctx.ui.editor(`Role "${name}" · saving writes ${where}: ${path} · save it empty to remove that copy`, starting);
		if (text === undefined) return;
		if (text.trim() === "") {
			if (!existsSync(path)) {
				ctx.ui.notify(`There is no copy of "${name}" at ${path} to remove.`, "info");
				return;
			}
			unlinkSync(path);
			reload(ctx);
			const now = available.get(name);
			ctx.ui.notify(now ? `Removed ${path}. "${name}" is the ${SOURCE_WORDS[now.source] ?? now.source} one again.` : `Removed ${path}. There is no "${name}" role any more.`, "info");
			return;
		}
		const parsed = parseFragment(text, path, scope);
		if (!parsed || parsed.name !== name) {
			ctx.ui.notify(parsed ? `Not saved: the file names the role "${parsed.name}", but it is being saved as "${name}". Change the name line back.` : "Not saved: a role needs some text under its header.", "warning");
			return;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
		reload(ctx);
		const used = available.get(name);
		const shadowed = used && used.path !== path ? ` Another copy wins here: ${used.path}.` : "";
		ctx.ui.notify(`Saved ${path}.${shadowed} Sessions with the "${name}" role use it from their next turn.`, "info");
	};

	onEvent(pi.events, "lattice:roles:set", (request) => {
		if (context) change("set", request.fragments);
	});

	// The event bus outlives a session switch, so this instance must go quiet once its session ends.
	pi.on("session_shutdown", async () => {
		context = undefined;
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
		description: "Compose this session's roles, and read or edit a role. Usage: /role [show [name]|list|add <names>|remove <names>|set <names>|clear|edit <name> [user|project]]",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			if (words.length <= 1) {
				const verbs = ["show", "list", "add", "remove", "set", "clear", "edit"].filter((verb) => verb.startsWith(words[0] ?? ""));
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
			if (verb === "show" && names[0]) show(ctx, names[0]);
			else if (verb === "edit") {
				if (!names[0]) ctx.ui.notify("Usage: /role edit <name> [user|project]", "warning");
				else await edit(ctx, names[0], names[1]);
			} else if (verb === "show") {
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
				ctx.ui.notify("Usage: /role [show [name]|list|add <names>|remove <names>|set <names>|clear|edit <name> [user|project]]", "warning");
			}
		},
	});
}
