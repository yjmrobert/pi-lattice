import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Scenario } from "./scenario.ts";

const MATH = `// Small arithmetic helpers.
export function double(n) {
	return n + n + 1;
}

export function triple(n) {
	return n * 4;
}
`;

/** What the two helpers return for 3, as the file stands now. */
function values(file: string): { double?: number; triple?: number } {
	try {
		const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(JSON.stringify({ double: m.double?.(3), triple: m.triple?.(3) }));`], { encoding: "utf8" });
		return JSON.parse(out) as { double?: number; triple?: number };
	} catch {
		return {};
	}
}

/** A worker given one fault to fix sees another beside it: it fixes the one and reports the other. */
export const workerStays: Scenario = {
	name: "worker-stays",
	about: "A worker fixes the fault it was given, leaves the one beside it alone, and says so in its report.",
	exercises: ["worker", "implementation", "task", "protocol"],
	async run(world, check) {
		world.file("math.js", MATH);
		const first = await world.host.createRoot({
			name: "eval",
			cwd: world.work,
			fragments: ["worker", "implementation", "task"],
			brief: "In math.js, double(n) returns the wrong value: it must return n times 2. Fix double. That is the whole task.",
		});
		const done = await world.until(async () => world.quiet() && (await world.texts(first.id)).length > 0);
		const now = values(join(world.work, "math.js"));
		const report = await world.last(first.id);

		check(world.blocked === "", "nobody waited on a question", world.blocked);
		check(done, "it finished");
		check(now.double === 6, "it fixed what it was given", `double(3) is ${now.double}`);
		check(now.triple === 12, "it left the fault beside it alone", `triple(3) is ${now.triple}`);
		check(/triple/i.test(report), "its report says what else it saw", report.slice(0, 300));
	},
};
