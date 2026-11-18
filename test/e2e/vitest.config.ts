import { defineConfig } from "vitest/config";

/**
 * The tests between machines: a server and two people's machines as containers. Kept out of
 * `npm test`, which needs no Docker; run with `npm run e2e`.
 */
export default defineConfig({
	test: {
		dir: "test/e2e",
		include: ["**/*.e2e.ts"],
		globalSetup: ["test/e2e/setup.ts"],
		testTimeout: 180_000,
		hookTimeout: 120_000,
		// One team at a time: each test starts its own machines, and a runner has four cores.
		fileParallelism: false,
	},
});
