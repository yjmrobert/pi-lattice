/**
 * Where everything goes. The canopy is laid out at whatever size its labels need; the screen is
 * a window on it. Height is the level of the work: an item is always above its parent. The
 * last level is drawn as a frond: its items listed one above the other on a stem.
 * Positions are in cells, branch paths in braille dots. No Pi, no terminal.
 */
import type { Item, World } from "./model.ts";

export type Shape = "grown" | "ruled";

export interface Place {
	item: Item;
	/** The cell of its node. Its label starts two cells to the right. */
	col: number;
	row: number;
	/** One of the items listed on a frond: one line, no chip. */
	leaf: boolean;
}

export interface Branch {
	/** The item the branch leads to; it is drawn in that item's colours. */
	to: Item;
	points: Array<[x: number, y: number]>;
	kind: "branch" | "stem" | "twig";
}

export interface Layout {
	width: number;
	height: number;
	places: Map<string, Place>;
	branches: Branch[];
	/** The centre of the root, in dots. */
	root: [x: number, y: number];
}

export interface LayoutOptions {
	shape?: Shape;
	/** Items drawn as one node, with what is under them counted and not shown. */
	folded?: ReadonlySet<string>;
}

/** Rows between one level and the next. */
const BAND = 9;
const GAP = 3;
const MARGIN = 2;
/** Room above the highest item, for the arcs between things that wait on each other. */
const HEADROOM = 5;
/** Dots a branch climbs upright before it reaches an item. */
const ARRIVE = 9;
export const NAME_MAX = 24;

export const cut = (name: string, max = NAME_MAX): string => ([...name].length > max ? `${[...name].slice(0, max - 1).join("")}…` : name);

/** The second line under an item: who sits on it, how far along it is, and whose it is where that changes. */
export function chipOf(item: Item): { agent: string; progress: string; owner: string } {
	// With nobody on it, an issue says the state the team gave it; a planned item has no state but that.
	const agent = item.agent ? item.agent.role : item.issue ? (item.done ? "" : item.issue.state) : item.planned ? "planned" : "";
	const progress = item.children.length > 0 ? `${item.landed}/${item.leaves}` : "";
	const owner = item.owner !== "" && item.parent && (item.parent.level < 0 || item.parent.owner !== item.owner) ? `@${item.owner}` : "";
	return { agent, progress, owner };
}

const chipWidth = (item: Item): number => {
	const chip = chipOf(item);
	return [chip.agent ? chip.agent.length + 2 : 0, chip.progress.length, chip.owner.length].filter((n) => n > 0).reduce((sum, n) => sum + n + 3, -3);
};
const marksWidth = (item: Item, folded = false): number => (item.asks > 0 ? 2 + String(item.asks).length : 0) + (folded ? 2 + String(under(item)).length : 0);
/** How many items are under one: what a folded item says it holds. */
export const under = (item: Item): number => item.children.reduce((sum, child) => sum + 1 + under(child), item.buds.length);
const labelWidth = (item: Item, folded = false): number => 2 + Math.max([...cut(item.name)].length + marksWidth(item, folded), chipWidth(item), ...item.buds.slice(0, 2).map((bud) => 4 + [...cut(bud.name, 16)].length));
const leafWidth = (item: Item): number => 2 + [...cut(item.name)].length + marksWidth(item) + (item.parent && item.parent.owner !== item.owner ? item.owner.length + 2 : 0);

/** A small stable number from an id, so the same tree always grows the same way. */
function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** A branch that leaves upward and arrives from straight below, bending in between. */
function bend(ax: number, ay: number, bx: number, top: number): Array<[number, number]> {
	// The last stretch is upright, so a branch never runs along the line under a label.
	const by = Math.min(ay - 1, top + ARRIVE);
	const k = (ay - by) * 0.55;
	const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) * 2.2));
	const out: Array<[number, number]> = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push([u * u * u * ax + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * bx, u * u * u * ay + 3 * u * u * t * (ay - k) + 3 * u * t * t * (by + k) + t * t * t * by]);
	}
	for (let y = by - 0.5; y >= top; y -= 0.5) out.push([bx, y]);
	return out;
}

export function layout(world: World, options: LayoutOptions = {}): Layout {
	const shape = options.shape ?? "grown";
	const folded = options.folded ?? new Set<string>();
	const last = world.levels.length - 1;
	const open = (item: Item): Item[] => (folded.has(item.id) ? [] : item.children);
	const leavesOf = (item: Item): Item[] => open(item).filter((child) => child.level >= last && child.children.length === 0);
	const limbsOf = (item: Item): Item[] => open(item).filter((child) => !(child.level >= last && child.children.length === 0));
	const frondWidth = (item: Item): number => Math.max(0, ...leavesOf(item).map(leafWidth));

	const widths = new Map<string, number>();
	const widthOf = (item: Item): number => {
		const limbs = limbsOf(item);
		const frond = frondWidth(item);
		const own = item.level < 0 ? [...item.name].length + 12 : labelWidth(item, folded.has(item.id));
		const below = limbs.length === 0 ? frond : limbs.reduce((sum, limb) => sum + widthOf(limb) + GAP, frond > 0 ? frond : -GAP);
		const width = Math.max(own, below);
		widths.set(item.id, width);
		return width;
	};
	const total = widthOf(world.root);

	const places = new Map<string, Place>();
	const branches: Branch[] = [];
	// Rows are counted upward from the root at 0, and turned the right way up at the end.
	const rowOf = (item: Item): number => {
		const lift = shape === "grown" ? (hash(item.id) % 5) - 2 : 0;
		return -(8 + item.level * BAND) + lift;
	};
	let top = 0;

	const frond = (item: Item, col: number, bottom: number): void => {
		leavesOf(item).forEach((leaf, index, all) => {
			const row = bottom - (all.length - 1 - index);
			places.set(leaf.id, { item: leaf, col: col + 2, row, leaf: true });
			branches.push({ to: leaf, kind: "twig", points: [[col * 2 + 2, row * 4 + 2], [col * 2 + 3, row * 4 + 2]] });
			top = Math.min(top, row);
		});
	};
	const stem = (item: Item, col: number, from: number, bottom: number): void => {
		const leaves = leavesOf(item);
		if (leaves.length === 0) return;
		const topY = (bottom - (leaves.length - 1)) * 4 + 2;
		const points: Array<[number, number]> = [];
		for (let y = from; y >= topY; y -= 0.5) points.push([col * 2 + 1 + (shape === "grown" ? Math.sin(y * 0.2 + (hash(item.id) % 7)) * 0.45 : 0), y]);
		// The stem is as far along as the least finished thing on it.
		branches.push({ to: leaves.every((leaf) => leaf.done) ? (leaves[0] as Item) : (leaves.find((leaf) => !leaf.done && !leaf.planned) ?? leaves.find((leaf) => !leaf.done) ?? (leaves[0] as Item)), kind: "stem", points });
	};

	const put = (item: Item, x0: number): void => {
		const limbs = limbsOf(item);
		const width = widths.get(item.id) ?? 0;
		const row = item.level < 0 ? 0 : rowOf(item);
		top = Math.min(top, row);
		if (limbs.length === 0) {
			// Nothing but a frond above it: the frond grows straight out of the node.
			const col = item.level < 0 ? x0 + Math.floor(width / 2) : x0;
			places.set(item.id, { item, col, row, leaf: false });
			stem(item, col, row * 4 - 1, row - 2);
			frond(item, col, row - 2);
			return;
		}
		let at = x0;
		const cols: number[] = [];
		const frondCol = at;
		if (frondWidth(item) > 0) {
			cols.push(frondCol);
			at += frondWidth(item) + GAP;
		}
		for (const limb of limbs) {
			put(limb, at);
			cols.push((places.get(limb.id) as Place).col);
			at += (widths.get(limb.id) ?? 0) + GAP;
		}
		const centre = Math.round(((cols[0] as number) + (cols.at(-1) as number)) / 2);
		const own = item.level < 0 ? 0 : labelWidth(item, folded.has(item.id));
		const col = Math.max(x0, Math.min(centre, x0 + width - own));
		places.set(item.id, { item, col, row, leaf: false });
		const fromY = item.level < 0 ? row * 4 - 5 : row * 4 - 1;
		for (const limb of limbs) {
			const place = places.get(limb.id) as Place;
			branches.push({ to: limb, kind: "branch", points: bend(col * 2 + 1, fromY, place.col * 2 + 1, place.row * 4 + 4) });
		}
		if (frondWidth(item) > 0) {
			// A frond beside the limbs gets a short branch of its own.
			const bottom = row - 4;
			const leaves = leavesOf(item);
			branches.push({ to: leaves.find((leaf) => !leaf.done) ?? (leaves[0] as Item), kind: "branch", points: bend(col * 2 + 1, fromY, frondCol * 2 + 1, bottom * 4 + 5) });
			stem(item, frondCol, bottom * 4 + 5, bottom);
			frond(item, frondCol, bottom);
		}
	};
	put(world.root, MARGIN);

	// Turn it the right way up: headroom above the highest thing, the root near the bottom.
	const shift = HEADROOM - top;
	for (const place of places.values()) place.row += shift;
	for (const branch of branches) for (const point of branch.points) point[1] += shift * 4;
	const rootPlace = places.get(world.root.id) as Place;
	return { width: total + MARGIN * 2, height: rootPlace.row + 3, places, branches, root: [rootPlace.col * 2 + 1, rootPlace.row * 4 + 1] };
}
