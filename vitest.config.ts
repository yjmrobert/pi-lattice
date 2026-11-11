import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Code under test that runs in the test process must not read or write the settings, trees
		// or roles of whoever runs the tests. Pi processes the tests start get their own sandbox.
		env: { PI_CODING_AGENT_DIR: join(tmpdir(), `pi-lattice-test-agent-${process.pid}`) },
	},
});
