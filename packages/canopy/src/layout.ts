/**
 * Where everything goes. The canopy is laid out at the size its labels need, and the screen is
 * a window on it; told how much room the window has, it draws in to fit before anything has to
 * be scrolled to. Height is the level of the work: an item is always above its parent. The
 * last level is drawn as a frond: its items listed one above the other on a stem.
 * Positions are in cells, branch paths in braille dots. No Pi, no terminal.
 */
import { cells, fit } from "./grid.ts";
import type { Item, World } from "./model.ts";
import { inOrder, type Order } from "./order.ts";

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
	order: Order;
	/** Items that wait on the one placed just before them, by id: order says it, and a mark between the two. */
	follows: Map<string, Item>;
	/** The most characters of a name that are written: fewer where the tree was drawn in to fit. */
	nameMax: number;
	/** Rows between one level and the next: fewer where the tree was drawn in to fit. */
	band: number;
}

export interface LayoutOptions {
	shape?: Shape;
	/** Items drawn as one node, with what is under them counted and not shown. */
	folded?: ReadonlySet<string>;
	/** What must come first is on the left, and at the bottom of a frond; or everything as it was filed. */
	order?: Order;
	/** The cells there are to draw in. The tree keeps its full size while it fits, and draws in when it does not. */
	room?: { width: number; height: number };
}

/** How close together the tree is drawn. */
interface Density {
	/** Rows between one level and the next. */
	band: number;
	/** Rows from the root to the first level. */
	base: number;
	/** How far an item may sit above or below its level when the tree is grown, in rows. */
	sway: number;
	/** Room above the highest item, for the arcs between things that wait on each other. */
	headroom: number;
	nameMax: number;
	/** Cells between two things side by side, and at the edges of the tree. */
	gap: number;
	margin: number;
}

type Rows = Pick<Density, "band" | "base" | "sway" | "headroom">;
type Columns = Pick<Density, "nameMax" | "gap" | "margin">;

/** With all the room it wants, and then drawn in step by step. The last still leaves a row of branch between an item and what is under it. */
const DENSITIES: ReadonlyArray<Rows> = [
	{ band: 9, base: 8, sway: 2, headroom: 5 },
	{ band: 7, base: 7, sway: 1, headroom: 3 },
	{ band: 6, base: 6, sway: 1, headroom: 3 },
	{ band: 5, base: 5, sway: 0, headroom: 2 },
	{ band: 4, base: 5, sway: 0, headroom: 2 },
];
/** Across: the longest a name is written and the room between things, then closer together, then with shorter names. */
const WIDTHS: ReadonlyArray<Columns> = [
	{ nameMax: 24, gap: 3, margin: 2 },
	{ nameMax: 24, gap: 2, margin: 1 },
	{ nameMax: 18, gap: 2, margin: 1 },
	{ nameMax: 14, gap: 2, margin: 1 },
];
/** Dots a branch climbs upright before it reaches an item. */
const ARRIVE = 9;
export const NAME_MAX: number = (WIDTHS[0] as Columns).nameMax;

/** A name no wider than `max` cells: one that is, loses its end to an ellipsis. */
export const cut = (name: string, max = NAME_MAX): string => (cells(name) > max ? `${fit(name, max - 1)}…` : name);

/** What is said under a repository that is drawn as one item. */
const PLACE = { asleep: "asleep", here: "nothing here yet", starting: "starting…" } as const;

/** The second line under an item: who sits on it, how far along it is, and whose it is where that changes. */
export function chipOf(item: Item): { agent: string; progress: string; owner: string } {
	// With nobody on it, an issue says the state the team gave it; a planned item has no state but that.
	const agent = item.place ? PLACE[item.place] : item.agent ? item.agent.role : item.issue ? (item.done ? "" : item.issue.state) : item.planned ? "planned" : "";
	const progress = item.children.length > 0 ? `${item.landed}/${item.leaves}` : "";
	const owner = !item.place && item.owner !== "" && item.parent && (item.parent.level < 0 || item.parent.owner !== item.owner) ? `@${item.owner}` : "";
	return { agent, progress, owner };
}

const chipWidth = (item: Item): number => {
	const chip = chipOf(item);
	return [chip.agent ? cells(chip.agent) + 2 : 0, chip.progress.length, cells(chip.owner)].filter((n) => n > 0).reduce((sum, n) => sum + n + 3, -3);
};
/** The marks after a name: what needs someone, how many wait on it, how many it holds when folded. */
const marksWidth = (item: Item, behind: number, folded = false): number =>
	(item.asks > 0 ? 2 + String(item.asks).length : 0) + (behind > 0 ? 2 + String(behind).length : 0) + (folded ? 2 + String(under(item)).length : 0) + ((item.issue?.directions ?? []).length > 0 ? 2 : 0) + (item.fresh ? 2 : 0);
/** How many items are under one: what a folded item says it holds. */
export const under = (item: Item): number => item.children.reduce((sum, child) => sum + 1 + under(child), item.buds.length);
const labelWidth = (item: Item, behind: number, folded: boolean, nameMax: number): number => 2 + Math.max(cells(cut(item.name, nameMax)) + marksWidth(item, behind, folded), chipWidth(item), ...item.buds.slice(0, 2).map((bud) => 4 + cells(cut(bud.name, 16))));
const leafWidth = (item: Item, behind: number, nameMax: number): number => 2 + cells(cut(item.name, nameMax)) + marksWidth(item, behind) + (item.parent && item.parent.owner !== item.owner ? cells(item.owner) + 2 : 0);

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

/**
 * Lay the tree out. With room given, the first of these that fits is drawn: the tree as it likes
 * to be, then with its levels closer together, then with its names shorter. What fits no way is
 * drawn as close as it goes in the direction that is short, and scrolled.
 */
export function layout(world: World, options: LayoutOptions = {}): Layout {
	const room = options.room;
	const roomy = WIDTHS[0] as Columns;
	if (!room) return arrange(world, options, { ...(DENSITIES[0] as Rows), ...roomy });
	// Helpers are written under an item, a row each: levels may not come closer than leaves them room.
	let helpers = 0;
	for (const item of world.items.values()) if (!options.folded?.has(item.id)) helpers = Math.max(helpers, Math.min(2, item.buds.length));
	const densities = DENSITIES.filter((density, index) => index === 0 || density.band >= 4 + helpers);
	let rows = densities[0] as Rows;
	let plan = arrange(world, options, { ...rows, ...roomy });
	for (const density of densities.slice(1)) {
		if (plan.height <= room.height) break;
		rows = density;
		plan = arrange(world, options, { ...rows, ...roomy });
	}
	if (plan.width <= room.width) return plan;
	for (const columns of WIDTHS.slice(1)) {
		const narrower = arrange(world, options, { ...rows, ...columns });
		if (narrower.width <= room.width) return narrower;
	}
	// Too wide whatever is done: the names are kept whole, since it is scrolled either way.
	return plan;
}

function arrange(world: World, options: LayoutOptions, density: Density): Layout {
	const { band, base, sway, headroom, nameMax, gap: GAP, margin: MARGIN } = density;
	const shape = options.shape ?? "grown";
	const folded = options.folded ?? new Set<string>();
	const last = world.levels.length - 1;
	const order = options.order ?? "dependency";
	const behind = (item: Item): number => world.flow.behind.get(item.id)?.length ?? 0;
	const open = (item: Item): Item[] => (folded.has(item.id) ? [] : inOrder(world.flow, item, order));
	const leavesOf = (item: Item): Item[] => open(item).filter((child) => child.level >= last && child.children.length === 0);
	const limbsOf = (item: Item): Item[] => open(item).filter((child) => !(child.level >= last && child.children.length === 0));
	const frondWidth = (item: Item): number => Math.max(0, ...leavesOf(item).map((leaf) => leafWidth(leaf, behind(leaf), nameMax)));

	const widths = new Map<string, number>();
	const widthOf = (item: Item): number => {
		const limbs = limbsOf(item);
		const frond = frondWidth(item);
		const own = item.level < 0 ? cells(item.name) + 12 : labelWidth(item, behind(item), folded.has(item.id), nameMax);
		const below = limbs.length === 0 ? frond : limbs.reduce((sum, limb) => sum + widthOf(limb) + GAP, frond > 0 ? frond : -GAP);
		const width = Math.max(own, below);
		widths.set(item.id, width);
		return width;
	};
	const total = widthOf(world.root);

	const places = new Map<string, Place>();
	const branches: Branch[] = [];
	const follows = new Map<string, Item>();
	// Rows are counted upward from the root at 0, and turned the right way up at the end.
	const rowOf = (item: Item): number => {
		const lift = shape === "grown" && sway > 0 ? (hash(item.id) % (sway * 2 + 1)) - sway : 0;
		return -(base + item.level * band) + lift;
	};
	let top = 0;

	const frond = (item: Item, col: number, bottom: number): void => {
		leavesOf(item).forEach((leaf, index, all) => {
			// In order, a frond is read upward from the stem: what comes first is at the bottom.
			const row = order === "dependency" ? bottom - index : bottom - (all.length - 1 - index);
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
		limbs.forEach((limb, index) => {
			const prior = limbs[index - 1];
			if (order === "dependency" && prior && world.flow.before.get(limb.id)?.includes(prior)) follows.set(limb.id, prior);
		});
		for (const limb of limbs) {
			put(limb, at);
			cols.push((places.get(limb.id) as Place).col);
			at += (widths.get(limb.id) ?? 0) + GAP;
		}
		const centre = Math.round(((cols[0] as number) + (cols.at(-1) as number)) / 2);
		const own = item.level < 0 ? 0 : labelWidth(item, behind(item), folded.has(item.id), nameMax);
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
	const shift = headroom - top;
	for (const place of places.values()) place.row += shift;
	for (const branch of branches) for (const point of branch.points) point[1] += shift * 4;
	const rootPlace = places.get(world.root.id) as Place;
	return { width: total + MARGIN * 2, height: rootPlace.row + 3, places, branches, root: [rootPlace.col * 2 + 1, rootPlace.row * 4 + 1], order, follows, nameMax, band };
}
