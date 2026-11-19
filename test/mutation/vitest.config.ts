import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.ts";

/**
 * The tests a mutant is put to (ADR 0047): each package's own. They run the code in their own
 * process. The tests in `test/integration` start Pi, which runs the code in another process
 * where a mutant is not switched on, and the ones beside them read the source as text, which
 * is not the text that mutants are made in.
 */
export default defineConfig({
	...base,
	resolve: {
		// Stryker mutates a copy of the checkout, and `node_modules/@pi-lattice/*` are links back
		// to the checkout itself. Without this a package would be given its neighbours unmutated.
		alias: [{ find: /^@pi-lattice\/([a-z0-9-]+)$/, replacement: fileURLToPath(new URL("../../packages/$1/src/index.ts", import.meta.url)) }],
	},
	test: {
		...base.test,
		include: ["packages/*/test/**/*.test.ts"],
		// Tests of how long something takes leave themselves out where this is set.
		env: { ...base.test?.env, LATTICE_TEST_MUTANTS: "1" },
		// Code that says which mutants each test reaches is many times slower than the code itself.
		// Stryker times each test in that first run and holds a mutant to it, so this limit is only for that run.
		testTimeout: 600_000,
		hookTimeout: 600_000,
	},
});
