/**
 * Colour on the canopy carries three things and they never share. A hue is a person. Amber is
 * "needs someone" and is given to nobody. Red is failed. Everything else is grey. There is a
 * set of them for a dark terminal and one for a light terminal; nothing is said by colour alone.
 */
import type { World } from "./model.ts";

export interface Palette {
	text: string;
	bright: string;
	dim: string;
	faint: string;
	attention: string;
	failed: string;
	root: string;
	/** Behind what is selected while the canopy has the keyboard, and while it does not. */
	select: string;
	selectAway: string;
	wait: string;
	/** Behind the name of a key. */
	keycap: string;
	/** Text written on amber: a key that answers what is asked. */
	onAttention: string;
	/** What a colour fades toward when it is drawn less bright: the terminal's background, near enough. */
	ground: string;
}

export type Appearance = "dark" | "light";

/**
 * The colours for a dark terminal and for a light one. Each is read against the backgrounds in
 * `PAGES`, which a test holds them to: a name that cannot be told from the page is not there.
 */
export const PALETTES: Record<Appearance, { color: Palette; people: readonly string[] }> = {
	dark: {
		color: { text: "#c6ccd9", bright: "#f3f6fb", dim: "#808a9e", faint: "#465066", attention: "#e8b755", failed: "#f0717b", root: "#e06bd0", select: "#3566c4", selectAway: "#39445c", wait: "#8fa3c8", keycap: "#272e3d", onAttention: "#14100a", ground: "#000000" },
		people: ["#5fd4d0", "#c79bf2", "#7aa7ff", "#7fd18b", "#f29bc4", "#b8d86a", "#6fc3f0", "#c9a58b"],
	},
	light: {
		color: { text: "#2b3245", bright: "#0b1020", dim: "#596274", faint: "#a3abbb", attention: "#8f5200", failed: "#b3261e", root: "#9c1f8e", select: "#8fb0ee", selectAway: "#d5dbe6", wait: "#44598a", keycap: "#dfe4ee", onAttention: "#ffffff", ground: "#ffffff" },
		people: ["#0b6f6b", "#6d35b5", "#1f4fc0", "#236b30", "#a82f6f", "#4f6a0a", "#0f6a96", "#7c4f2f"],
	},
};

/** Backgrounds a terminal of each kind is likely to have: what the palettes are held to. */
export const PAGES: Record<Appearance, readonly string[]> = { dark: ["#000000", "#1e1e1e", "#282c34"], light: ["#ffffff", "#f5f5f5", "#fdf6e3"] };

/** One hue a person. None is amber, red, or the root's magenta. The colours in use: see `usePalette`. */
export const PEOPLE: string[] = [...PALETTES.dark.people];

/** The colours in use. Dark until `usePalette` says otherwise. */
export const COLOR: Palette = { ...PALETTES.dark.color };

let appearance: Appearance = "dark";

/** Draw for a dark terminal or a light one from here on. */
export function usePalette(next: Appearance): void {
	if (next === appearance) return;
	appearance = next;
	Object.assign(COLOR, PALETTES[next].color);
	PEOPLE.splice(0, PEOPLE.length, ...PALETTES[next].people);
}

export type ColorDepth = "truecolor" | "256";
let depth: ColorDepth = "truecolor";

/** Write colours as the terminal can take them: exactly, or as the nearest of the 256 an older one has. */
export function useColorDepth(next: ColorDepth): void {
	depth = next;
}

export const colorDepth = (): ColorDepth => depth;

/** Which palette is in use. */
export const paletteInUse = (): Appearance => appearance;

/** How well one colour reads on another, from 1 (not at all) to 21: the ratio accessibility guidelines use. */
export function contrast(a: string, b: string): number {
	const luminance = (hex: string): number => {
		const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (high + 0.05) / (low + 0.05);
}

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
