import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { settingsDoc } from "../scripts/settings-doc.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the settings reference", () => {
	it("is what the settings table says; run `npm run docs` when this fails", () => {
		expect(readFileSync(join(root, "docs", "settings.md"), "utf8")).toBe(settingsDoc());
	});

	it("names every LATTICE_ variable the code reads", () => {
		const doc = settingsDoc();
		const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
		const used = new Set<string>();
		for (const name of readdirSync(join(root, "packages"))) {
			for (const file of sources(join(root, "packages", name, "src"))) for (const match of readFileSync(file, "utf8").matchAll(/\bLATTICE_[A-Z_]+\b/g)) used.add(match[0]);
		}
		expect([...used].filter((name) => !doc.includes(`\`${name}\``)).sort()).toEqual([]);
	});
});
