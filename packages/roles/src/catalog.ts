/**
 * Layers: the same role in more than one place. The built-in one is at the bottom, a person's
 * own above it, a project's on top. A file either replaces what is beneath it or adds to it.
 * Pure: the files have been read and parsed before they get here.
 */
import { createHash } from "node:crypto";
import type { Fragment } from "./fragments.ts";

/** What tells one text of a role from another, short enough to keep in a file's header. */
export function bodyHash(body: string): string {
	return createHash("sha256").update(body.trim()).digest("hex").slice(0, 12);
}

/**
 * Put the fragments found in each place together. `places` is lowest first: the built-in
 * ones, then a person's own, then the project's. Within one place the first of a name wins.
 *
 * - A fragment in `append` mode adds its text after the one beneath it, and changes nothing
 *   else about it. With nothing beneath, it is simply the fragment.
 * - Any other fragment replaces the one beneath. When it says what it was copied from (`base`)
 *   and what is beneath is no longer that, it is marked stale: the one beneath moved on.
 */
export function layer(places: ReadonlyArray<readonly Fragment[]>): Map<string, Fragment> {
	const layered = new Map<string, Fragment>();
	for (const place of places) {
		const seen = new Set<string>();
		for (const fragment of place) {
			if (seen.has(fragment.name)) continue;
			seen.add(fragment.name);
			const beneath = layered.get(fragment.name);
			if (!beneath) layered.set(fragment.name, fragment);
			else if (fragment.mode === "append") layered.set(fragment.name, { ...beneath, body: `${beneath.body}\n\n${fragment.body}`, source: fragment.source, path: fragment.path, mode: "append", addsTo: { source: beneath.source, path: beneath.path } });
			else layered.set(fragment.name, { ...fragment, ...(fragment.base !== undefined && fragment.base !== bodyHash(beneath.body) ? { stale: true as const } : {}) });
		}
	}
	return new Map([...layered].sort(([a], [b]) => a.localeCompare(b)));
}
