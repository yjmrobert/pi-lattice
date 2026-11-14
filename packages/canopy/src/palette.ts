/**
 * Colour on the canopy carries three things and they never share. A hue is a person. Amber is
 * "needs someone" and is given to nobody. Red is failed. Everything else is grey.
 */
import type { World } from "./model.ts";

/** One hue a person. None is amber, red, or the root's magenta. */
export const PEOPLE = ["#5fd4d0", "#c79bf2", "#7aa7ff", "#7fd18b", "#f29bc4", "#b8d86a", "#6fc3f0", "#c9a58b"] as const;

export const COLOR = {
	text: "#c6ccd9",
	bright: "#f3f6fb",
	dim: "#808a9e",
	faint: "#465066",
	attention: "#e8b755",
	failed: "#f0717b",
	root: "#e06bd0",
	/** Behind what is selected while the canopy has the keyboard, and while it does not. */
	select: "#27457a",
	selectAway: "#222936",
	wait: "#8fa3c8",
} as const;

/** A person's colour. Past the eighth, people share hues and are told apart by their letter. */
export function colorOf(world: World, owner: string): string {
	const person = world.people.find((candidate) => candidate.name === owner);
	return person ? (PEOPLE[person.index % PEOPLE.length] as string) : COLOR.dim;
}

/** The letter that tells a person apart where colour cannot: the first of their name that nobody before them uses. */
export function letterOf(world: World, owner: string): string {
	const taken = new Set<string>();
	for (const person of world.people) {
		const letter = [...person.name.toLowerCase()].find((char) => /[a-z0-9]/.test(char) && !taken.has(char)) ?? "?";
		taken.add(letter);
		if (person.name === owner) return letter;
	}
	return "?";
}
