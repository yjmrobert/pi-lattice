/**
 * What a session is told by its roles, for the usual combinations, written from the built-in
 * fragments and the default settings. `npm run docs` writes it to docs/roles-composed.md; a
 * test fails when the file is out of date. A change to one fragment then shows, in review, as
 * the prompts it changes and what each of them now costs in words.
 */
import { resolveSettings, rolesFor } from "../packages/protocol/src/index.ts";
import { builtinFragmentsDir, type Fragment, loadFragments, roleSections, SECTION_PREFIX } from "../packages/roles/src/index.ts";

export interface Combination {
	/** Used as a heading, and by the tests to name a ceiling. */
	name: string;
	/** When a session has it. */
	when: string;
	place: "root" | "child";
	/** The roles chosen for it; the settings add the ones every session gets. */
	chosen: string[];
}

/** The combinations the guide names and the ones the host gives out by itself. */
export const COMBINATIONS: readonly Combination[] = [
	{ name: "first session", when: "The session that starts a tree where there is a board: the host gives it `coordinator`.", place: "root", chosen: ["coordinator"] },
	{ name: "feature coordinator", when: "The root of a feature taken through the four phases.", place: "root", chosen: ["coordinator", "lifecycle", "feature"] },
	{ name: "child", when: "A child created with no roles.", place: "child", chosen: [] },
	{ name: "grilling child", when: "A child that interrogates one story.", place: "child", chosen: ["worker", "grilling", "story"] },
	{ name: "planning child", when: "A child that plans one story.", place: "child", chosen: ["worker", "planning", "story"] },
	{ name: "task child", when: "A child that builds one task.", place: "child", chosen: ["worker", "implementation", "task"] },
	{ name: "verification child", when: "A child that checks what another built.", place: "child", chosen: ["worker", "verification", "story"] },
	{ name: "reviewer", when: "A session the host starts to check a result on an issue.", place: "child", chosen: ["reviewer"] },
];

export const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export function builtinCatalog(): Map<string, Fragment> {
	return loadFragments([{ dir: builtinFragmentsDir(), source: "builtin" }]);
}

export interface Composed {
	combination: Combination;
	/** The role names applied, in order. */
	applied: string[];
	/** Each prompt section, in order: its key and its text. */
	sections: Array<{ key: string; text: string }>;
	words: number;
}

/** A combination as a session with the default settings gets it. */
export function compose(combination: Combination, catalog: ReadonlyMap<string, Fragment> = builtinCatalog()): Composed {
	const applied = rolesFor(resolveSettings(), combination.place, combination.chosen);
	const sections = Object.entries(roleSections(applied, catalog)).map(([key, text]) => ({ key, text }));
	return { combination, applied, sections, words: sections.reduce((sum, section) => sum + words(section.text), 0) };
}

export function rolesComposedDoc(): string {
	const catalog = builtinCatalog();
	const composed = COMBINATIONS.map((combination) => compose(combination, catalog));
	const out: string[] = [
		"# Roles, as composed",
		"",
		"<!-- Written by `npm run docs` from packages/roles/fragments and the default settings. Change a fragment, not this file. -->",
		"",
		"What a session is told by its roles, for the usual combinations with the default settings. It is here so that a change to one fragment can be read as the prompts it changes. [The roles guide](roles.md) says what a role is.",
		"",
		"## Combinations",
		"",
		"| Combination | When | Roles | Words |",
		"|---|---|---|---|",
		...composed.map((entry) => `| ${entry.combination.name} | ${entry.combination.when} | \`${entry.applied.join(" + ")}\` | ${entry.words} |`),
		"",
		"The words are those of the role sections only: the index that lists the roles, then one section for each.",
		"",
	];
	for (const entry of composed) {
		out.push(`### ${entry.combination.name}`, "", "| Section | Words |", "|---|---|", ...entry.sections.map((section) => `| \`${section.key}\` | ${words(section.text)} |`), "");
	}
	out.push("## Sections", "", "Each role section, once, as it is written into the prompt.", "");
	const seen = new Set<string>();
	for (const entry of composed) {
		for (const section of entry.sections) {
			if (!section.key.startsWith(SECTION_PREFIX) || seen.has(section.key)) continue;
			seen.add(section.key);
			out.push(`### ${section.key.slice(SECTION_PREFIX.length)}`, "", "```text", section.text, "```", "");
		}
	}
	return out.join("\n");
}

if (process.argv[1]?.endsWith("roles-doc.ts")) {
	const { writeFileSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const path = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "roles-composed.md");
	writeFileSync(path, rolesComposedDoc());
	console.log(`wrote ${path}`);
}
