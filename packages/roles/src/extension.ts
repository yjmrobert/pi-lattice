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
import { assignmentFromEnv, emitEvent, type Facts, HOST_ENV, type HostAssignment, onEvent, PROTOCOL_VERSION } from "@pi-lattice/protocol";
import { Type } from "typebox";
import { advisories, editRoles, INDEX_SECTION, type RoleEdit, roleSections, SECTION_PREFIX } from "./compose.ts";
import { gatherFacts } from "./facts.ts";
import { bodyHash } from "./catalog.ts";
import { type Fragment, fragmentRoots, isFragmentName, loadFragments, parseFragment } from "./fragments.ts";

const ROLES_ENTRY = "lattice:roles";

/** Where a fragment comes from, in a person's words. */
const SOURCE_WORDS: Record<string, string> = { builtin: "built in", user: "yours", project: "this project's" };
const sourceWord = (source: string): string => SOURCE_WORDS[source] ?? source;

/** Where a fragment comes from, with what its file does to the one beneath it. */
function origin(fragment: Fragment): string {
	if (fragment.addsTo) return `${sourceWord(fragment.addsTo.source)}, with ${sourceWord(fragment.source)} added`;
	return fragment.stale ? `${sourceWord(fragment.source)}, a copy of one that has changed since` : sourceWord(fragment.source);
}

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
	/** What was so when the last turn started: the tools this session has and what its host said of it. */
	let facts: Facts = {};

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
		const notes = [...result.displaced.map((entry) => `"${entry.by}" takes the place of "${entry.name}": one ${entry.slot} at a time.`), ...advisories(applied, available)];
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
		if (applied.length === 0) return;
		facts = await gatherFacts(pi, facts);
		Object.assign(sections, roleSections(applied, available, facts));
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
			(request.fragments ??= []).push({ name: fragment.name, summary: fragment.summary, source: fragment.source, path: fragment.path, ...(fragment.stale ? { stale: true } : {}) });
		}
	});

	// Whoever shows a person what this session has been told asks each extension for its part.
	onEvent(pi.events, "lattice:prompt:describe", (request) => {
		if (!context) return;
		const sections = roleSections(applied, available, facts);
		for (const [key, text] of Object.entries(sections)) {
			const fragment = key.startsWith(SECTION_PREFIX) ? available.get(key.slice(SECTION_PREFIX.length)) : undefined;
			request.parts.push({
				title: fragment ? `Role: ${fragment.name}` : "Roles",
				source: fragment ? `${origin(fragment)} · ${fragment.path}` : "written by pi-lattice from the list of roles",
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
				`${fragment.name} · ${origin(fragment)} · ${fragment.path}`,
				fragment.summary,
				...(fragment.addsTo ? [`the text after the last blank line is added by ${fragment.path}; the rest is ${fragment.addsTo.path}`] : []),
				...(fragment.stale ? [`this copy replaces a role that has changed since the copy was made: /role edit ${fragment.name} shows it, and saving it empty goes back to the one beneath`] : []),
				...(fragment.requires.length > 0 ? [`usually with: ${fragment.requires.join(", ")}`] : []),
				...(fragment.conflicts.length > 0 ? [`competes with: ${fragment.conflicts.join(", ")}`] : []),
				...(fragment.slot ? [`a ${fragment.slot}: applying it takes the place of any other ${fragment.slot}`] : []),
				...(fragment.includes.length > 0 ? [`made of: ${fragment.includes.join(", ")}, each applied with it`] : []),
				...(fragment.when.length > 0 || fragment.unless.length > 0 ? [`applies ${[...(fragment.when.length > 0 ? [`when ${fragment.when.join(" and ")}`] : []), ...(fragment.unless.length > 0 ? [`unless ${fragment.unless.join(" or ")}`] : [])].join(", ")}`] : []),
				...(fragment.keep ? ["kept: setting the roles leaves it applied; /role remove takes it off"] : []),
				"",
				fragment.body,
				"",
				`/role edit ${fragment.name} adds to it; /role edit ${fragment.name} replace makes a copy of your own.`,
			].join("\n"),
			"info",
		);
	};

	/** The fragments in the places beneath a person's own or this project's: what a file there adds to or replaces. */
	const beneath = (ctx: ExtensionContext, scope: "user" | "project"): Map<string, Fragment> => {
		const roots = fragmentRoots({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
		return loadFragments(roots.slice(roots.findIndex((root) => root.source === scope) + 1));
	};

	/** A full copy of a fragment as a file's text, marked with what it was copied from. */
	const copyOf = (fragment: Fragment): string => {
		const lines = [`name: ${fragment.name}`, ...(fragment.summary ? [`summary: ${fragment.summary}`] : []), `base: "${bodyHash(fragment.body)}"`];
		if (fragment.slot) lines.push(`slot: ${fragment.slot}`);
		if (fragment.keep) lines.push("keep: true");
		for (const key of ["requires", "conflicts", "includes", "when", "unless"] as const) if (fragment[key].length > 0) lines.push(`${key}: [${fragment[key].join(", ")}]`);
		return `---\n${lines.join("\n")}\n---\n${fragment.body}\n`;
	};

	/**
	 * Edit a role in Pi's editor. What is saved is the person's own file, or this project's.
	 *
	 * Where the role exists beneath, the file is an addition by default: its text is added after
	 * the role's own, which stays as it is and keeps improving. `replace` makes a full copy
	 * instead, which is used in place of the one beneath. A file that is already there is opened
	 * as it is. Saving it empty removes it, so the one beneath is used again.
	 */
	const edit = async (ctx: ExtensionContext, name: string, options: string[]): Promise<void> => {
		const usage = "Usage: /role edit <name> [replace] [user|project]";
		if (!isFragmentName(name)) {
			ctx.ui.notify(`"${name}" cannot be a role name. Use lowercase letters, digits and dashes.`, "warning");
			return;
		}
		if (options.some((word) => word !== "user" && word !== "project" && word !== "replace")) {
			ctx.ui.notify(usage, "warning");
			return;
		}
		const scope = options.includes("project") ? "project" : "user";
		if (scope === "project" && !ctx.isProjectTrusted()) {
			ctx.ui.notify("This project is not trusted, so its roles are not read. Trust it first, or edit your own with /role edit <name>.", "warning");
			return;
		}
		reload(ctx);
		const under = beneath(ctx, scope).get(name);
		const path = ownPath(ctx, name, scope);
		const where = scope === "user" ? "yours, used in every repository" : "this project's";
		const own = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		const adding = own !== undefined ? parseFragment(own, path, scope)?.mode === "append" : under !== undefined && !options.includes("replace");
		const starting =
			own ??
			(under === undefined
				? `---\nname: ${name}\nsummary: One line saying what this role is for.\n---\nWhat a session with this role should do.\n`
				: adding
					? `---\nname: ${name}\nmode: append\n---\n`
					: copyOf(under));
		const title = adding
			? `Adding to role "${name}" · what is written under the header is added after the ${under ? sourceWord(under.source) : "role's own"} text, which stays as it is · ${where}: ${path} · save it empty to remove it · /role edit ${name} replace makes a full copy instead`
			: `Role "${name}" · ${under ? `a full copy, used in place of the ${sourceWord(under.source)} one` : "a new role"} · ${where}: ${path} · save it empty to remove it`;
		const text = await ctx.ui.editor(title, starting);
		if (text === undefined) return;
		if (text.trim() === "") {
			if (!existsSync(path)) {
				ctx.ui.notify(`There is no file for "${name}" at ${path} to remove.`, "info");
				return;
			}
			unlinkSync(path);
			reload(ctx);
			const now = available.get(name);
			ctx.ui.notify(now ? `Removed ${path}. "${name}" is the ${origin(now)} one again.` : `Removed ${path}. There is no "${name}" role any more.`, "info");
			return;
		}
		const parsed = parseFragment(text, path, scope);
		if (!parsed || parsed.name !== name) {
			ctx.ui.notify(parsed ? `Not saved: the file names the role "${parsed.name}", but it is being saved as "${name}". Change the name line back.` : adding ? `Not saved: nothing was written under the header, so there is nothing to add to "${name}".` : "Not saved: a role needs some text under its header.", "warning");
			return;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
		reload(ctx);
		const used = available.get(name);
		const shadowed = used && used.path !== path ? ` Another file wins here: ${used.path}.` : "";
		const does = parsed.mode === "append" && under ? ` It adds to the ${sourceWord(under.source)} "${name}", which stays as it is.` : under ? ` It is used in place of the ${sourceWord(under.source)} "${name}".` : "";
		ctx.ui.notify(`Saved ${path}.${does}${shadowed} Sessions with the "${name}" role use it from their next turn.`, "info");
	};

	onEvent(pi.events, "lattice:roles:set", (request) => {
		if (context) change("set", request.fragments);
	});
	// Roles given by the session's host after it started: a session reads its roles only when it starts.
	onEvent(pi.events, "lattice:roles:add", (request) => {
		if (!context) return;
		reload(context);
		const known = request.fragments.filter((name) => available.has(name));
		if (known.length > 0) change("add", known);
	});

	// The event bus outlives a session switch, so this instance must go quiet once its session ends.
	pi.on("session_shutdown", async () => {
		context = undefined;
	});

	pi.registerTool({
		name: "apply_role",
		label: "Apply role",
		description:
			"Change the role fragments applied to this session. Roles are composable pieces of guidance. Mode add (the default) applies them as well: one that shares a slot with an applied role, such as a phase, takes its place. Mode remove drops them. Mode set replaces the list, except the roles every session keeps. Call with no fragments to see what is applied and what is available.",
		promptSnippet: "Change which role fragments guide this session",
		promptGuidelines: ["Use apply_role only when the user asks to change this session's roles, or when an applied role's guidance says to move to another phase."],
		parameters: Type.Object({
			fragments: Type.Optional(Type.Array(Type.String(), { description: "Fragment names" })),
			mode: Type.Optional(Type.String({ description: "add (default), remove, or set" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			context = ctx;
			if (!params.fragments || params.fragments.length === 0) {
				reload(ctx);
				const lines = [...available.values()].map((fragment) => `${fragment.name}${fragment.slot ? ` (${fragment.slot})` : ""}: ${fragment.summary || "(no summary)"}`);
				return { content: [{ type: "text", text: [`Applied: ${describe()}.`, "Available:", ...lines].join("\n") }], details: { fragments: applied } };
			}
			const mode = params.mode ?? "add";
			if (mode !== "set" && mode !== "add" && mode !== "remove") throw new Error(`Unknown mode "${mode}". Use set, add or remove.`);
			const result = change(mode, params.fragments);
			if (!result.ok) throw new Error(result.text);
			return { content: [{ type: "text", text: result.text }], details: { fragments: applied } };
		},
	});

	pi.registerCommand("role", {
		description: "Compose this session's roles, and read or edit a role. Usage: /role [show [name]|list|add <names>|remove <names>|set <names>|clear|edit <name> [replace] [user|project]]",
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
				if (!names[0]) ctx.ui.notify("Usage: /role edit <name> [replace] [user|project]", "warning");
				else await edit(ctx, names[0], names.slice(1));
			} else if (verb === "show") {
				reload(ctx);
				ctx.ui.notify([`Roles: ${describe()}.`, ...advisories(applied, available).map((note) => `Note: ${note}`)].join("\n"), "info");
			} else if (verb === "list") {
				reload(ctx);
				const lines = [...available.values()].map((f) => `${applied.includes(f.name) ? "*" : " "} ${f.name} (${[origin(f), ...(f.slot ? [f.slot] : []), ...(f.keep ? ["kept"] : [])].join("; ")}): ${f.summary || "(no summary)"}`);
				ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No role fragments are installed.", "info");
			} else if (verb === "add" || verb === "remove" || verb === "set") {
				if (names.length === 0) {
					ctx.ui.notify(`Usage: /role ${verb} <fragment names>`, "warning");
					return;
				}
				const result = change(verb, names);
				ctx.ui.notify(result.text, result.ok ? "info" : "warning");
			} else if (verb === "clear") {
				ctx.ui.notify(change("clear", []).text, "info");
			} else {
				ctx.ui.notify("Usage: /role [show [name]|list|add <names>|remove <names>|set <names>|clear|edit <name> [replace] [user|project]]", "warning");
			}
		},
	});
}
