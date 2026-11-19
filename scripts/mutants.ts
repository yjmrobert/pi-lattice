#!/usr/bin/env node
/**
 * What the mutants came to, by package (ADR 0047).
 *
 * Stryker writes one report for each run, and the workflow makes one run for each package. This
 * reads every `mutation.json` under a directory and says, for each package: how many mutants
 * there were, how many a test noticed, how many none did, and how many no test reaches.
 *
 *   node scripts/mutants.ts                        the reports under reports/
 *   node scripts/mutants.ts reports --floor 70     and fail when under 70% of what the tests reach is noticed
 *
 * In GitHub Actions the table is also written to the summary of the run.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** As much of Stryker's report as is read here: files by their path, each with its mutants. */
export interface Report {
	files: Record<string, { mutants: Array<{ status: string }> }>;
}

export interface Row {
	name: string;
	/** Mutants a test failed on, or never finished with. */
	noticed: number;
	/** Mutants every test that reaches them passed with. */
	survived: number;
	/** Mutants in code that none of the tests run. */
	unreached: number;
}

const add = (a: Row, b: Row, name = a.name): Row => ({ name, noticed: a.noticed + b.noticed, survived: a.survived + b.survived, unreached: a.unreached + b.unreached });

/** One row for each package that has a file in the reports, by name. */
export function byPackage(reports: Report[]): Row[] {
	const rows = new Map<string, Row>();
	for (const report of reports) {
		for (const [file, { mutants }] of Object.entries(report.files)) {
			const name = /^packages\/([^/]+)\//.exec(file)?.[1] ?? file;
			const row: Row = { name, noticed: 0, survived: 0, unreached: 0 };
			for (const { status } of mutants) {
				if (status === "Killed" || status === "Timeout") row.noticed++;
				else if (status === "Survived") row.survived++;
				else if (status === "NoCoverage") row.unreached++;
				// The rest could not be run at all (an error as soon as the file is loaded), and say nothing of the tests.
			}
			rows.set(name, add(rows.get(name) ?? { name, noticed: 0, survived: 0, unreached: 0 }, row));
		}
	}
	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const total = (rows: Row[]): Row => rows.reduce((sum, row) => add(sum, row, "all"), { name: "all", noticed: 0, survived: 0, unreached: 0 });

/** Of the mutants the tests reach, the share one of them noticed, as a percentage. Undefined where they reach none. */
export function reachedScore(row: Row): number | undefined {
	const reached = row.noticed + row.survived;
	return reached === 0 ? undefined : (100 * row.noticed) / reached;
}

/** Of every mutant, the share a test noticed. */
export function score(row: Row): number | undefined {
	const all = row.noticed + row.survived + row.unreached;
	return all === 0 ? undefined : (100 * row.noticed) / all;
}

const percent = (value: number | undefined): string => (value === undefined ? "–" : `${value.toFixed(1)}%`);

/** The table, as Markdown: a line for each package and one for all of them. */
export function table(rows: Row[]): string {
	const line = (row: Row, mark = ""): string => `| ${mark}${row.name}${mark} | ${row.noticed + row.survived + row.unreached} | ${row.noticed} | ${row.survived} | ${row.unreached} | ${mark}${percent(reachedScore(row))}${mark} | ${percent(score(row))} |`;
	return ["| package | mutants | noticed | survived | not reached | noticed, of what tests reach | noticed, of all |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |", ...rows.map((row) => line(row)), line(total(rows), "**")].join("\n");
}

/** What is wrong with the result, if anything: nothing to read, or less noticed than the floor asks. */
export function verdict(rows: Row[], floor: number | undefined): string | undefined {
	if (rows.length === 0) return "No report was found: nothing was put to mutants.";
	const reached = reachedScore(total(rows));
	if (floor !== undefined && (reached === undefined || reached < floor)) return `Of the mutants the tests reach, ${percent(reached)} were noticed. The floor is ${floor}%.`;
	return undefined;
}

/** The packages there is no report for: ones with no tests of their own, or whose job failed. */
export const without = (packages: string[], rows: Row[]): string[] => packages.filter((name) => !rows.some((row) => row.name === name)).sort();

function reportsUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? reportsUnder(join(dir, entry.name)) : entry.name === "mutation.json" ? [join(dir, entry.name)] : []));
}

if (process.argv[1]?.endsWith("mutants.ts")) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--floor");
	const floor = at < 0 ? undefined : Number(args[at + 1]);
	const dir = args.find((arg, i) => !arg.startsWith("--") && i !== at + 1) ?? "reports";
	const rows = byPackage(reportsUnder(dir).map((file) => JSON.parse(readFileSync(file, "utf8")) as Report));
	const wrong = verdict(rows, floor);
	const left = without(existsSync("packages") ? readdirSync("packages") : [], rows);
	const leftOut = rows.length > 0 && left.length > 0 ? `No report for ${left.join(", ")}. A package with no tests of its own is not put to mutants; any other is a job that failed.` : "";
	const text = [rows.length > 0 ? table(rows) : "", leftOut, wrong ?? ""].filter(Boolean).join("\n\n");
	console.log(text);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mutants\n\n${text}\n\nA mutant is a small change to the code. One that survived is a change no test noticed; each is in the report of its package, among the artifacts of this run.\n`);
	if (wrong) process.exitCode = 1;
}
