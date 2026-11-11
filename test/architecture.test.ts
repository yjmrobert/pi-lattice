/**
 * The seams between packages, enforced. Each package may import only what this table allows,
 * and only through another package's public entry point. A change that needs a new arrow
 * must change this file, which makes it a decision instead of an accident.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Which lattice packages each package's source may import. */
const ALLOWED: Record<string, string[]> = {
	protocol: [],
	a2a: ["protocol"],
	roles: ["protocol"],
	graph: ["protocol"],
	pane: ["protocol"],
	collab: ["protocol"],
	host: ["protocol"],
	// The composition root: the only package allowed to know about more than the contracts.
	app: ["protocol", "host", "collab", "a2a", "roles", "graph", "pane"],
};

/** Which packages may depend on Pi itself. The contracts and the sharing library must not. */
const MAY_USE_PI = new Set(["a2a", "roles", "graph", "pane", "host", "app"]);

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sources(path));
		else if (name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function imports(file: string): string[] {
	const text = readFileSync(file, "utf8");
	return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] as string);
}

const packages = readdirSync(join(root, "packages")).sort();

describe("package seams", () => {
	it("has a rule for every package", () => {
		expect(packages).toEqual(Object.keys(ALLOWED).sort());
	});

	for (const name of packages) {
		const dir = join(root, "packages", name);
		const files = sources(join(dir, "src"));
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

		it(`${name}: imports only the lattice packages it is allowed to`, () => {
			const used = new Set<string>();
			for (const file of files) {
				for (const spec of imports(file)) {
					const match = /^@pi-lattice\/([a-z0-9-]+)(\/.*)?$/.exec(spec);
					if (!match) continue;
					// Only a package's public entry point, never a file inside it.
					expect(match[2], `${file} reaches inside ${spec}`).toBeUndefined();
					used.add(match[1] as string);
				}
			}
			expect([...used].sort()).toEqual([...used].filter((dep) => (ALLOWED[name] ?? []).includes(dep)).sort());
		});

		it(`${name}: never reaches into another package by relative path`, () => {
			for (const file of files) {
				for (const spec of imports(file)) {
					if (!spec.startsWith(".")) continue;
					const target = join(dirname(file), spec);
					expect(target.startsWith(join(dir, "src")), `${file} imports ${spec}`).toBe(true);
				}
			}
		});

		it(`${name}: declares exactly the lattice packages it imports`, () => {
			const used = new Set<string>();
			for (const file of files) {
				for (const spec of imports(file)) {
					const match = /^@pi-lattice\/([a-z0-9-]+)/.exec(spec);
					if (match) used.add(match[1] as string);
				}
			}
			const declared = Object.keys(manifest.dependencies ?? {}).filter((dep) => dep.startsWith("@pi-lattice/")).map((dep) => dep.slice("@pi-lattice/".length));
			// The composition root also depends on the extension packages it bundles without importing them.
			const expected = name === "app" ? ALLOWED.app ?? [] : [...used];
			expect(declared.sort()).toEqual([...expected].sort());
		});

		it(`${name}: ${MAY_USE_PI.has(name) ? "may" : "does not"} depend on Pi`, () => {
			const usesPi = files.some((file) => imports(file).some((spec) => spec.startsWith("@earendil-works/")));
			if (!MAY_USE_PI.has(name)) expect(usesPi).toBe(false);
		});
	}

	it("keeps the contracts free of I/O, so every package can share them", () => {
		for (const file of sources(join(root, "packages", "protocol", "src"))) {
			for (const spec of imports(file)) expect(spec.startsWith("node:"), `${file} imports ${spec}`).toBe(false);
		}
	});

	it("lets session extensions talk only through the typed event bus, not process state", () => {
		// Writing to the environment was how the pane once told the other extensions who they were.
		for (const name of ["a2a", "roles", "graph", "pane"]) {
			for (const file of sources(join(root, "packages", name, "src"))) {
				const text = readFileSync(file, "utf8");
				expect(/process\.env\[[^\]]+\]\s*=|process\.env\.\w+\s*=|Object\.assign\(process\.env|delete process\.env/.test(text), `${file} writes to the environment`).toBe(false);
			}
		}
	});
});
