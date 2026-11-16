#!/usr/bin/env node
/**
 * Check that a real model does what the role fragments, the templates and the tool guidelines say.
 *
 *   npm run eval                              every scenario, on the model Pi is set up with
 *   npm run eval -- delegation steer-rule     only these
 *   npm run eval -- --changed                 the ones that test what differs from origin/main
 *   npm run eval -- --model <m> --model <n>   on other models, as `pi --model` takes them
 *   npm run eval -- --runs 3                  each scenario three times: models do not answer the same way twice
 *   npm run eval -- --compare [before after]  two runs side by side; the last two when none are named
 *   npm run eval -- --list                    what there is
 *   npm run eval -- --faux                    on the scripted model: every check fails, but a scenario that cannot even run shows
 *
 * The tests use a scripted model, which shows the mechanics work and nothing about whether a
 * model does what it is told. Each scenario here gives real sessions one small piece of work
 * and checks what happened, never how it was worded. Run it before and after changing a
 * fragment or a template. It uses your Pi login and spends tokens.
 *
 * Each scenario runs in its own directory under the system's temporary directory, which is left
 * behind so the sessions can be read. What was found is written to .dev/eval/.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, type Scenario, World } from "./eval/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".dev", "eval");

interface CheckResult {
	ok: boolean;
	what: string;
	detail: string;
}

interface RunResult {
	scenario: string;
	ok: boolean;
	checks: CheckResult[];
	seconds: number;
	tokens: number;
	cost: number;
	/** Where its sessions and state were left. */
	scratch: string;
	/** What went wrong outside the checks: the scenario itself threw. */
	error?: string;
}

interface Report {
	at: string;
	model: string;
	label?: string;
	commit: string;
	/** The working tree differed from the commit. */
	dirty: boolean;
	runs: RunResult[];
}

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const values = (name: string): string[] => argv.flatMap((arg, index) => (arg === name && argv[index + 1] !== undefined ? [argv[index + 1] as string] : []));
const VALUED = new Set(["--model", "--minutes", "--runs", "--label", "--at-once"]);
const words = argv.filter((arg, index) => !arg.startsWith("--") && !VALUED.has(argv[index - 1] ?? ""));

const git = (...args: string[]): string => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
};

/** What differs from origin/main, as the things a scenario says it exercises. */
function changedThings(): Set<string> {
	const files = new Set([...git("diff", "--name-only", "origin/main").split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean));
	const things = new Set<string>();
	for (const file of files) {
		const fragment = /^packages\/roles\/fragments\/.*\/([a-z0-9-]+)\.md$/.exec(file);
		if (fragment) things.add(fragment[1] as string);
		else if (file === "packages/protocol/src/templates.ts") things.add("template:*");
		else if (/^packages\/(graph|a2a|roles)\/src\/extension\.ts$/.test(file)) things.add("tools");
		else if (file.startsWith("packages/roles/src/")) things.add("*");
	}
	return things;
}

function chosen(): Scenario[] {
	if (words.length > 0) {
		const unknown = words.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
		if (unknown.length > 0) throw new Error(`There is no scenario ${unknown.join(", ")}. npm run eval -- --list shows what there is.`);
		return SCENARIOS.filter((scenario) => words.includes(scenario.name));
	}
	if (!flag("--changed")) return [...SCENARIOS];
	const things = changedThings();
	return SCENARIOS.filter((scenario) => things.has("*") || scenario.exercises.some((thing) => things.has(thing) || (thing.startsWith("template:") && things.has("template:*"))));
}

async function runOne(scenario: Scenario, model: string | undefined, minutes: number): Promise<RunResult> {
	const started = Date.now();
	const checks: CheckResult[] = [];
	const world = await World.start(scenario.name, { minutes, faux: flag("--faux"), ...(model ? { model } : {}), ...(scenario.board ? { board: true } : {}) });
	let error: string | undefined;
	try {
		await scenario.run(world, (ok, what, detail = "") => void checks.push({ ok, what, detail: ok ? "" : detail }));
	} catch (thrown) {
		error = thrown instanceof Error ? thrown.message : String(thrown);
	}
	const usage = world.usage();
	await world.stop().catch(() => {});
	return { scenario: scenario.name, ok: error === undefined && checks.length > 0 && checks.every((check) => check.ok), checks, seconds: Math.round((Date.now() - started) / 1000), tokens: usage.tokens, cost: usage.cost, scratch: world.scratch, ...(error !== undefined ? { error } : {}) };
}

/** Run the work a few at a time, keeping the order of the results. */
async function pool<T, R>(items: readonly T[], atOnce: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	}));
	return results;
}

const passed = (runs: readonly RunResult[], scenario: string): string => {
	const mine = runs.filter((run) => run.scenario === scenario);
	return `${mine.filter((run) => run.ok).length}/${mine.length}`;
};

function print(report: Report): void {
	const names = [...new Set(report.runs.map((run) => run.scenario))];
	console.log(`\n${report.model}${report.label ? ` · ${report.label}` : ""} · ${report.commit}${report.dirty ? " + changes" : ""}\n`);
	for (const name of names) {
		const mine = report.runs.filter((run) => run.scenario === name);
		console.log(`${mine.every((run) => run.ok) ? "✓" : "✗"} ${name.padEnd(16)} ${passed(report.runs, name).padEnd(5)} ${Math.round(mine.reduce((sum, run) => sum + run.seconds, 0) / mine.length)}s`);
		// A check that failed is said once, with how often and what was seen the first time.
		const failed = new Map<string, { times: number; detail: string }>();
		for (const run of mine) {
			if (run.error) failed.set(`the scenario itself failed: ${run.error}`, { times: (failed.get(run.error)?.times ?? 0) + 1, detail: run.scratch });
			for (const check of run.checks) if (!check.ok) failed.set(check.what, { times: (failed.get(check.what)?.times ?? 0) + 1, detail: failed.get(check.what)?.detail ?? check.detail });
		}
		for (const [what, { times, detail }] of failed) console.log(`    ✗ ${what}${mine.length > 1 ? ` (${times} of ${mine.length})` : ""}${detail ? `\n      ${detail.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
	}
	const tokens = report.runs.reduce((sum, run) => sum + run.tokens, 0);
	const cost = report.runs.reduce((sum, run) => sum + run.cost, 0);
	console.log(`\n${report.runs.filter((run) => run.ok).length} of ${report.runs.length} runs passed · ${tokens} tokens${cost > 0 ? ` · $${cost.toFixed(2)}` : ""}`);
}

const load = (path: string): Report => JSON.parse(readFileSync(path, "utf8")) as Report;

function compare(): void {
	const named = words.map((name) => (existsSync(name) ? name : join(out, name)));
	const all = existsSync(out) ? readdirSync(out).filter((name) => name.endsWith(".json")).sort().map((name) => join(out, name)) : [];
	const [beforePath, afterPath] = named.length === 2 ? named : all.slice(-2);
	if (!beforePath || !afterPath) throw new Error("There are not two runs to compare yet. Name two files, or run npm run eval twice.");
	const [before, after] = [load(beforePath), load(afterPath)];
	const title = (report: Report): string => `${report.model}${report.label ? ` · ${report.label}` : ""} · ${report.commit}${report.dirty ? " + changes" : ""}`;
	console.log(`\nbefore  ${title(before)}\nafter   ${title(after)}\n`);
	const names = [...new Set([...before.runs, ...after.runs].map((run) => run.scenario))];
	const rate = (report: Report, name: string, what: string): number | undefined => {
		const mine = report.runs.filter((run) => run.scenario === name).flatMap((run) => run.checks.filter((check) => check.what === what));
		return mine.length > 0 ? mine.filter((check) => check.ok).length / mine.length : undefined;
	};
	for (const name of names) {
		const [was, is] = [passed(before.runs, name), passed(after.runs, name)];
		console.log(`${was === is ? " " : "≠"} ${name.padEnd(16)} ${was.padEnd(5)} → ${is}`);
		const checks = [...new Set([...before.runs, ...after.runs].filter((run) => run.scenario === name).flatMap((run) => run.checks.map((check) => check.what)))];
		for (const what of checks) {
			const [a, b] = [rate(before, name, what), rate(after, name, what)];
			if (a === b) continue;
			const show = (value: number | undefined): string => (value === undefined ? "not checked" : `${Math.round(value * 100)}%`);
			console.log(`    ${b !== undefined && (a === undefined || b > a) ? "better" : "worse "}  ${what}: ${show(a)} → ${show(b)}`);
		}
	}
	const sum = (report: Report): string => `${report.runs.reduce((total, run) => total + run.tokens, 0)} tokens`;
	console.log(`\nbefore ${sum(before)} · after ${sum(after)}`);
}

async function main(): Promise<number> {
	if (flag("--help") || flag("-h")) {
		console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 20).map((line) => line.replace(/^ \* ?/, "")).join("\n"));
		return 0;
	}
	if (flag("--list")) {
		for (const scenario of SCENARIOS) console.log(`${scenario.name.padEnd(16)} ${scenario.about}\n${" ".repeat(17)}tests: ${scenario.exercises.join(", ")}${scenario.board ? " · with a server" : ""}`);
		return 0;
	}
	if (flag("--compare")) {
		compare();
		return 0;
	}
	const scenarios = chosen();
	if (scenarios.length === 0) {
		console.log("Nothing a scenario tests differs from origin/main.");
		return 0;
	}
	const minutes = Number(values("--minutes")[0] ?? 6);
	const runs = Math.max(1, Number(values("--runs")[0] ?? 1));
	const atOnce = Math.max(1, Number(values("--at-once")[0] ?? 4));
	const label = values("--label")[0];
	const models: Array<string | undefined> = flag("--faux") ? ["scripted"] : values("--model").length > 0 ? values("--model") : [undefined];
	let failed = false;
	for (const model of models) {
		const name = model ?? "the model Pi is set up with";
		console.log(`Running ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}${runs > 1 ? `, ${runs} times each,` : ""} on ${name} (up to ${minutes} minutes each)…`);
		const work = scenarios.flatMap((scenario) => Array.from({ length: runs }, () => scenario));
		const results = await pool(work, atOnce, async (scenario) => {
			const result = await runOne(scenario, flag("--faux") ? undefined : model, minutes);
			console.log(`  ${result.ok ? "✓" : "✗"} ${scenario.name} (${result.seconds}s)  ${result.scratch}`);
			return result;
		});
		const report: Report = { at: new Date().toISOString(), model: model ?? "default", ...(label ? { label } : {}), commit: git("rev-parse", "--short", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "", runs: results };
		print(report);
		// A run on the scripted model says nothing about a model, so it is not kept beside the ones that do.
		if (!flag("--faux")) {
			mkdirSync(out, { recursive: true });
			const path = join(out, `${report.at.replace(/[:.]/g, "-")}-${report.model.replace(/[^a-z0-9.-]+/gi, "_")}${label ? `-${label.replace(/[^a-z0-9.-]+/gi, "_")}` : ""}.json`);
			writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
			console.log(`Written to ${path}\n`);
		}
		failed ||= results.some((result) => !result.ok);
	}
	return failed ? 1 : 0;
}

process.exit(await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	return 2;
}));
