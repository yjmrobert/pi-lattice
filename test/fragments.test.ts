/**
 * The built-in role fragments, checked as text: what they name exists, what a combination
 * costs does not grow by accident, and one rule is not written out twice. None of this says
 * whether a model follows them; `npm run eval` is for that.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FACTS, isKnownFact, TEMPLATES } from "../packages/protocol/src/index.ts";
import { expand } from "../packages/roles/src/index.ts";
import { builtinCatalog, COMBINATIONS, compose, registeredTools, words } from "../scripts/roles-doc.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = builtinCatalog();

/** Names with an underscore that are not tools: the parameters a fragment may speak of. */
const PARAMETERS = new Set(["waits_on"]);

/**
 * The most words the role sections of each combination may take. A number may be lowered
 * freely. Raising one is saying, on purpose, that every such session should read more.
 */
const CEILINGS: Record<string, number> = {
	"first session": 1100,
	"coordinator, no server": 1100,
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

	it("are made only of fragments that exist, and never of two that hold one slot", () => {
		const problems: string[] = [];
		for (const fragment of catalog.values()) {
			for (const part of fragment.includes) if (!catalog.has(part)) problems.push(`${fragment.name} includes ${part}, which does not exist`);
			const slots = expand([fragment.name], catalog).map((part) => part.slot).filter((slot) => slot !== undefined);
			if (new Set(slots).size !== slots.length) problems.push(`${fragment.name} has two parts of one slot`);
		}
		expect(problems).toEqual([]);
	});

	it("depend only on facts that mean something, and mention only facts they are sure to have", () => {
		const problems: string[] = [];
		for (const fragment of catalog.values()) {
			for (const name of [...fragment.when, ...fragment.unless]) if (!isKnownFact(name)) problems.push(`${fragment.name} depends on ${name}, which nothing gives`);
			// A fragment says whether it applies in its header. Inside it only values are filled in.
			if (/\{\{[#/]/.test(fragment.body)) problems.push(`${fragment.name} has a conditional block: make the part a fragment of its own with \`when\``);
			for (const match of fragment.body.matchAll(/\{\{([\w.-]+)\}\}/g)) {
				const name = match[1] as string;
				if (!isKnownFact(name)) problems.push(`${fragment.name} mentions {{${name}}}, which nothing gives`);
				else if (!fragment.when.includes(name)) problems.push(`${fragment.name} mentions {{${name}}} without \`when: [${name}]\`: where the fact is missing the braces would be shown`);
			}
		}
		expect(problems).toEqual([]);
	});

	it("can count on facts the guide describes: every fact a host gives is in its table, as the contract words it", () => {
		const guide = readFileSync(join(root, "docs", "roles.md"), "utf8");
		expect(FACTS.filter((fact) => !guide.includes(`| \`${fact.name}\` | ${fact.says} | \`${fact.example}\` |`)).map((fact) => fact.name)).toEqual([]);
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
