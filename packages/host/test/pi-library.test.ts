import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { piLibrary, piPackageOf } from "../src/pi-library.ts";

const piPackage = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));

describe("Pi's library, for a host that has no copy of its own", () => {
	it("finds Pi's package from any file inside it, and nothing from a file outside", () => {
		expect(piPackageOf(join(piPackage, "dist/bundle/cli.js"))).toBe(piPackage);
		expect(piPackageOf(fileURLToPath(import.meta.url))).toBeUndefined();
		expect(piPackageOf(join(tmpdir(), "no-such-file"))).toBeUndefined();
		expect(piPackageOf(undefined)).toBeUndefined();
	});

	it("resolves like any dependency inside this repository", async () => {
		expect(typeof (await piLibrary()).parseSessionEntries).toBe("function");
	});

	it("where it does not resolve, loads the Pi it is told about, and says what to do when there is none", () => {
		// A copy outside the repository, as the host is once installed: the bare import fails there.
		const dir = mkdtempSync(join(tmpdir(), "pi-lattice-library-"));
		try {
			copyFileSync(fileURLToPath(new URL("../src/pi-library.ts", import.meta.url)), join(dir, "pi-library.ts"));
			writeFileSync(join(dir, "run.ts"), `import { piLibrary } from "./pi-library.ts";\npiLibrary().then((pi) => console.log(typeof pi.buildSessionContext), (error) => console.log(error.message));\n`);
			const run = (env: Record<string, string>): string => execFileSync(process.execPath, [join(dir, "run.ts")], { cwd: dir, encoding: "utf8", env: { PATH: "", ...env } }).trim();
			expect(run({ LATTICE_PI_PACKAGE: piPackage })).toBe("function");
			expect(run({ LATTICE_PI_STARTED: join(piPackage, "dist/bundle/cli.js") })).toBe("function");
			expect(run({ LATTICE_PI_BIN: join(piPackage, "dist/bundle/cli.js") })).toBe("function");
			expect(run({})).toContain("Pi's library was not found");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
