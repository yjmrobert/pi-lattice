/**
 * Mutants (ADR 0047): each package's code is changed a little at a time, and its tests are run
 * to see whether one of them notices. `npm run mutants` here, and the workflow `Mutants`.
 *
 *   npm run mutants -- --mutate packages/canopy/src/order.ts    one file, which is what to run on this machine
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
	testRunner: "vitest",
	vitest: { configFile: "test/mutation/vitest.config.ts" },
	mutate: ["packages/*/src/**/*.ts"],
	// Stryker works in a copy of the checkout. These are large, or nothing a test reads.
	ignorePatterns: ["dist", "brag-output*", "spikes", "reports", ".dev", ".lattice", "coverage", "test/e2e/.build"],
	// Each runner is a Vitest of its own and takes half a gigabyte or more. A runner on GitHub has
	// four cores to itself; a person's machine has other things to do.
	concurrency: process.env.CI ? 4 : 2,
	reporters: ["progress", "clear-text", "html", "json"],
	clearTextReporter: { reportMutants: false, reportTests: false, logTests: false },
	htmlReporter: { fileName: "reports/mutation/index.html" },
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	// What was found last time is kept, and only what changed since, in the code or in the tests
	// that reach it, is tried again. `--force` tries everything.
	incremental: true,
	incrementalFile: "reports/mutation/incremental.json",
};
