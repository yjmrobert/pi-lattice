/**
 * The built-in role fragments, checked as text: what they name exists, what a combination
 * costs does not grow by accident, and one rule is not written out twice. None of this says
 * whether a model follows them; `npm run eval` is for that.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../packages/protocol/src/index.ts";
import { builtinCatalog, COMBINATIONS, compose, words } from "../scripts/roles-doc.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = builtinCatalog();

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
}

/** Every tool an extension of this repository registers, read from the sources. */
function registeredTools(): Set<string> {
	const tools = new Set<string>();
	for (const name of readdirSync(join(root, "packages"))) {
		for (const file of sources(join(root, "packages", name, "src"))) for (const match of readFileSync(file, "utf8").matchAll(/registerTool\(\{\s*name:\s*"([a-z_]+)"/g)) tools.add(match[1] as string);
	}
	return tools;
}

/** Names with an underscore that are not tools: the parameters a fragment may speak of. */
const PARAMETERS = new Set(["waits_on"]);

/**
 * The most words the role sections of each combination may take. A number may be lowered
 * freely. Raising one is saying, on purpose, that every such session should read more.
 */
const CEILINGS: Record<string, number> = {
	"first session": 1100,
	"feature coordinator": 1536,
	child: 718,
	"grilling child": 1080,
	"planning child": 991,
	"task child": 1051,
	"verification child": 1061,
	reviewer: 755,
};

/**
 * Sentences that two fragments of one combination both say today, word for word. Each is a
 * rule with two owners. Nothing may be added; the list is to be emptied.
 */
const KNOWN_REPEATS = new Set(["their instructions take priority over the brief;"]);

/** The sentences of a text long enough to be a rule, without list marks and emphasis. */
const sentences = (text: string): string[] =>
	text
		.split(/(?<=[.!?:;])\s+|\n/)
		.map((sentence) => sentence.replace(/^[-\d.\s*]+/, "").replace(/[`*"]/g, "").trim().toLowerCase())
		.filter((sentence) => words(sentence) > 6);

describe("the built-in role fragments", () => {
	it("name only tools that are registered", () => {
		const tools = registeredTools();
		expect(tools.size).toBeGreaterThan(5);
		const texts: Array<[where: string, text: string]> = [...[...catalog.values()].map((fragment): [string, string] => [`fragment ${fragment.name}`, fragment.body]), ...Object.values(TEMPLATES).map((template): [string, string] => [`template ${template.name}`, template.text])];
		const missing: string[] = [];
		for (const [where, text] of texts) for (const match of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) if (!tools.has(match[0]) && !PARAMETERS.has(match[0])) missing.push(`${where}: ${match[0]}`);
		expect(missing).toEqual([]);
	});

	it("name only fragments that exist, where one names another", () => {
		const missing: string[] = [];
		for (const fragment of catalog.values()) for (const other of [...fragment.requires, ...fragment.conflicts]) if (!catalog.has(other)) missing.push(`${fragment.name}: ${other}`);
		expect(missing).toEqual([]);
	});

	it("are all in the guide's table", () => {
		const guide = readFileSync(join(root, "docs", "roles.md"), "utf8");
		expect([...catalog.keys()].filter((name) => !guide.includes(`| \`${name}\` |`))).toEqual([]);
	});

	it("have a ceiling for every combination, and every combination has its roles", () => {
		expect(COMBINATIONS.map((combination) => combination.name).sort()).toEqual(Object.keys(CEILINGS).sort());
		for (const combination of COMBINATIONS) for (const name of compose(combination, catalog).applied) expect(catalog.has(name), `${combination.name}: ${name}`).toBe(true);
	});

	for (const combination of COMBINATIONS) {
		it(`${combination.name}: takes no more words than its ceiling`, () => {
			expect(compose(combination, catalog).words).toBeLessThanOrEqual(CEILINGS[combination.name] as number);
		});

		it(`${combination.name}: says no rule twice in the same words`, () => {
			const composed = compose(combination, catalog);
			const said = new Map<string, string>();
			const repeats: string[] = [];
			for (const section of composed.sections) {
				for (const sentence of new Set(sentences(section.text))) {
					const first = said.get(sentence);
					if (first !== undefined && !KNOWN_REPEATS.has(sentence)) repeats.push(`${first} and ${section.key}: ${sentence}`);
					said.set(sentence, first ?? section.key);
				}
			}
			expect(repeats).toEqual([]);
		});
	}
});
