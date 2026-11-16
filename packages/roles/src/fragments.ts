/**
 * Role fragments: plain markdown files with a small frontmatter block. A fragment is a
 * piece of guidance, not an agent definition. Nothing here knows what any fragment means.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isFactName } from "@pi-lattice/protocol";
import { layer } from "./catalog.ts";

export interface Fragment {
	/** Unique name, also used in the prompt section tag. Lowercase letters, digits and dashes. */
	name: string;
	summary: string;
	/** The guidance text injected into the system prompt. */
	body: string;
	/** Advisory: fragments this one expects alongside it. Shown to the human, never enforced. */
	requires: string[];
	/** Advisory: fragments this one sits badly with. Shown to the human, never enforced. */
	conflicts: string[];
	/** Fragments that are part of this one: applying it applies them after it, and they are not listed separately. */
	includes: string[];
	/** Facts that must all hold for it to be applied. With none, it always is. See `facts.ts` in the protocol. */
	when: string[];
	/** Facts none of which may hold for it to be applied. */
	unless: string[];
	/** At most one fragment of a slot is applied: applying this one takes the other off. For example `phase`. */
	slot?: string;
	/** Replacing the applied list leaves this one applied. Only removing it by name, or clearing the list, takes it off. */
	keep: boolean;
	/**
	 * What its file does to the fragment of the same name beneath it: `replace` it, or `append`
	 * its text to it and leave the rest as it is. Only matters where there is one beneath.
	 */
	mode: "replace" | "append";
	/** For a copy: what tells the text it was copied from, so that a copy whose original moved on can be told. */
	base?: string;
	/** Where it was found: "project", "user" or "builtin". For an addition, where the addition was found. */
	source: string;
	path: string;
	/** For an addition: the fragment it adds to. */
	addsTo?: { source: string; path: string };
	/** It is a copy of one beneath it that has changed since the copy was made. */
	stale?: true;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isFragmentName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

const list = (value: unknown): string[] => {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
	if (typeof value === "string" && value.trim() !== "") return value.split(",").map((item) => item.trim()).filter(Boolean);
	return [];
};

/** Parse one fragment file. Returns undefined when it has no usable name or body. */
export function parseFragment(content: string, path: string, source: string): Fragment | undefined {
	let frontmatter: Record<string, unknown> = {};
	let body = content;
	try {
		const parsed = parseFrontmatter(content);
		frontmatter = parsed.frontmatter ?? {};
		body = parsed.body;
	} catch {
		return undefined;
	}
	const fallback = path.split(/[\\/]/).pop()?.replace(/\.md$/i, "");
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : fallback;
	if (!isFragmentName(name) || body.trim() === "") return undefined;
	return {
		name,
		summary: typeof frontmatter.summary === "string" ? frontmatter.summary.trim() : "",
		body: body.trim(),
		requires: list(frontmatter.requires),
		conflicts: list(frontmatter.conflicts),
		includes: list(frontmatter.includes).filter(isFragmentName),
		when: list(frontmatter.when).filter(isFactName),
		unless: list(frontmatter.unless).filter(isFactName),
		...(isFragmentName(frontmatter.slot) ? { slot: frontmatter.slot } : {}),
		keep: frontmatter.keep === true || frontmatter.keep === "true",
		mode: frontmatter.mode === "append" ? "append" : "replace",
		// Written quoted, so that a mark made only of digits is not read as a number. One that was is still a mark.
		...(typeof frontmatter.base === "string" && frontmatter.base.trim() !== "" ? { base: frontmatter.base.trim() } : typeof frontmatter.base === "number" ? { base: String(frontmatter.base) } : {}),
		source,
		path,
	};
}

function markdownFiles(dir: string, depth = 0): string[] {
	if (depth > 3 || !existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.isDirectory()) out.push(...markdownFiles(path, depth + 1));
		else if (name.toLowerCase().endsWith(".md") && name.toLowerCase() !== "readme.md") out.push(path);
	}
	return out;
}

export interface FragmentRoot {
	dir: string;
	source: string;
}

/** The fragments shipped with this package. */
export function builtinFragmentsDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "fragments");
}

/**
 * Where fragments are looked up, most specific first. Project fragments are prompt text
 * supplied by the repository, so they are only read when the project is trusted.
 */
export function fragmentRoots(options: { cwd: string; agentDir: string; projectTrusted: boolean }): FragmentRoot[] {
	const roots: FragmentRoot[] = [];
	if (options.projectTrusted) roots.push({ dir: join(options.cwd, ".pi", "lattice", "roles"), source: "project" });
	roots.push({ dir: join(options.agentDir, "lattice", "roles"), source: "user" });
	roots.push({ dir: builtinFragmentsDir(), source: "builtin" });
	return roots;
}

/** The fragments in one place, in the order of their paths. */
function readRoot(root: FragmentRoot): Fragment[] {
	const found: Fragment[] = [];
	for (const path of markdownFiles(root.dir)) {
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const fragment = parseFragment(content, path, root.source);
		if (fragment) found.push(fragment);
	}
	return found;
}

/**
 * Load every fragment from the roots, most specific first. A file in an earlier root replaces
 * the fragment of that name in a later one, or adds to it when it says so. See `catalog.ts`.
 */
export function loadFragments(roots: FragmentRoot[]): Map<string, Fragment> {
	return layer([...roots].reverse().map(readRoot));
}
