import { describe, expect, it } from "vitest";
import { byPackage, type Report, reachedScore, score, table, total, verdict } from "../scripts/mutants.ts";

const file = (...statuses: string[]) => ({ mutants: statuses.map((status) => ({ status })) });

/** Two runs, as the workflow makes them: one for each package. */
const reports: Report[] = [
	{ files: { "packages/protocol/src/lease.ts": file("Killed", "Killed", "Timeout", "Survived"), "packages/protocol/src/tree.ts": file("Killed", "NoCoverage") } },
	{ files: { "packages/graph/src/extension.ts": file("NoCoverage", "NoCoverage", "RuntimeError") } },
];

describe("what the mutants came to", () => {
	it("is counted for each package: a mutant that timed out was noticed, and one that could not be run is not counted", () => {
		expect(byPackage(reports)).toEqual([
			{ name: "graph", noticed: 0, survived: 0, unreached: 2 },
			{ name: "protocol", noticed: 4, survived: 1, unreached: 1 },
		]);
		expect(total(byPackage(reports))).toEqual({ name: "all", noticed: 4, survived: 1, unreached: 3 });
	});

	it("is a share of what the tests reach, and a share of everything", () => {
		const [graph, protocol] = byPackage(reports) as [ReturnType<typeof total>, ReturnType<typeof total>];
		expect(reachedScore(protocol)).toBe(80);
		expect(score(protocol)).toBeCloseTo(66.67, 2);
		// No test reaches anything in it: there is no share to speak of, and nothing was noticed.
		expect(reachedScore(graph)).toBeUndefined();
		expect(score(graph)).toBe(0);
	});

	it("is a table with a line for each package and one for all", () => {
		expect(table(byPackage(reports)).split("\n").slice(2)).toEqual(["| graph | 2 | 0 | 0 | 2 | – | 0.0% |", "| protocol | 6 | 4 | 1 | 1 | 80.0% | 66.7% |", "| **all** | 8 | 4 | 1 | 3 | **80.0%** | 50.0% |"]);
	});

	it("fails under the floor, and where there was nothing to read", () => {
		const rows = byPackage(reports);
		expect(verdict(rows, undefined)).toBeUndefined();
		expect(verdict(rows, 80)).toBeUndefined();
		expect(verdict(rows, 81)).toMatch(/80\.0% were noticed\. The floor is 81%/);
		expect(verdict([], undefined)).toMatch(/No report was found/);
	});
});
