/**
 * Role fragments: plain markdown files with a small frontmatter block. A fragment is a
 * piece of guidance, not an agent definition. Nothing here knows what any fragment means.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
	/** Hints about child sessions this role tends to spawn. Hints, not commands. */
	suggests: string[];
	/** Where it was found: "project", "user" or "builtin". */
	source: string;
	path: string;
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
		suggests: list(frontmatter.suggests),
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

/** Load every fragment from the roots. Earlier roots override later ones by name. */
export function loadFragments(roots: FragmentRoot[]): Map<string, Fragment> {
	const found = new Map<string, Fragment>();
	for (const root of roots) {
		for (const path of markdownFiles(root.dir)) {
			let content: string;
			try {
				content = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			const fragment = parseFragment(content, path, root.source);
			if (fragment && !found.has(fragment.name)) found.set(fragment.name, fragment);
		}
	}
	return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}
