/**
 * A layout part of the way from one to another: what folding or unfolding an item looks like while
 * it happens. Branches are dots, so they move by less than a cell at a time and carry the motion;
 * names move a cell at a time behind them.
 */
import type { Branch, Layout, Place } from "./layout.ts";
import type { Item } from "./model.ts";

/** Slow to start and slow to arrive: nothing on the screen jumps. */
export const ease = (progress: number): number => {
	const t = Math.max(0, Math.min(1, progress));
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

type Point = [x: number, y: number];

/** The dot a share of the way along a run of dots. */
const along = (points: ReadonlyArray<Point>, count: number, index: number): Point => {
	if (points.length === 0) return [0, 0];
	const at = count <= 1 ? 0 : (index / (count - 1)) * (points.length - 1);
	const low = Math.floor(at);
	const a = points[low] as Point;
	const b = points[Math.min(points.length - 1, low + 1)] as Point;
	return [a[0] + (b[0] - a[0]) * (at - low), a[1] + (b[1] - a[1]) * (at - low)];
};

const centre = (place: Place): Point => [place.col * 2 + 1, place.row * 4 + 1.5];

/** Where an item is in a layout, or the nearest thing it is under that is there: what it folds into, or unfolds out of. */
const home = (item: Item, places: ReadonlyMap<string, Place>): Place | undefined => {
	for (let at: Item | undefined = item; at; at = at.parent) {
		const place = places.get(at.id);
		if (place) return place;
	}
	return undefined;
};

/** Each branch under a name that is the same in two layouts of the same work. */
const named = (layout: Layout): Map<string, Branch> => {
	const seen = new Map<string, number>();
	return new Map(
		layout.branches.map((branch) => {
			const name = `${branch.kind}:${branch.to.id}`;
			const nth = seen.get(name) ?? 0;
			seen.set(name, nth + 1);
			return [`${name}:${nth}`, branch];
		}),
	);
};

/** `from` at 0, `to` at 1. What is only in one of them folds into, or out of, what it is under in the other. */
export function blend(from: Layout, to: Layout, progress: number): Layout {
	const t = ease(progress);
	const mix = (a: number, b: number): number => a + (b - a) * t;
	const move = (place: Place, a: { col: number; row: number }, b: { col: number; row: number }): Place => ({ ...place, col: Math.round(mix(a.col, b.col)), row: Math.round(mix(a.row, b.row)) });

	const places = new Map<string, Place>();
	for (const [id, place] of to.places) {
		const was = from.places.get(id);
		if (was) places.set(id, move(place, was, place));
		// A name that was not there is written once the branch to it has mostly grown.
		else if (t > 0.6) places.set(id, move(place, home(place.item, from.places) ?? place, place));
	}
	for (const [id, place] of from.places) {
		// A name that is going is gone before its branch has folded away.
		if (!to.places.has(id) && t < 0.4) places.set(id, move(place, place, home(place.item, to.places) ?? place));
	}

	const before = named(from);
	const after = named(to);
	const branches: Branch[] = [];
	for (const [name, branch] of after) {
		const was = before.get(name);
		const out = was ? undefined : home(branch.to, from.places);
		const source: ReadonlyArray<Point> = was?.points ?? (out ? [centre(out)] : branch.points);
		const count = Math.max(source.length, branch.points.length);
		branches.push({ ...branch, points: Array.from({ length: count }, (_unused, index) => {
			const a = along(source, count, index);
			const b = along(branch.points, count, index);
			return [mix(a[0], b[0]), mix(a[1], b[1])] as Point;
		}) });
	}
	for (const [name, branch] of before) {
		if (after.has(name)) continue;
		const into = home(branch.to, to.places);
		if (!into) continue;
		const [x, y] = centre(into);
		branches.push({ ...branch, points: branch.points.map((point) => [mix(point[0], x), mix(point[1], y)] as Point) });
	}

	const follows = new Map([...to.follows].filter(([id, on]) => places.has(id) && places.has(on.id)));
	return { ...to, width: Math.max(from.width, to.width), height: Math.max(from.height, to.height), places, branches, root: [Math.round(mix(from.root[0], to.root[0])), Math.round(mix(from.root[1], to.root[1]))], follows };
}
