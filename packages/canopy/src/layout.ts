/**
 * Where everything goes. The canopy is laid out at the size its labels need, and the screen is
 * a window on it; told how much room the window has, it draws in to fit before anything has to
 * be scrolled to. Height is the level of the work: an item is always above its parent. The
 * last level is drawn as a frond: its items listed one above the other on a stem. An item that
 * is folded is on that frond too: one line, which says what is under it.
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
	/** The items drawn as one line, with what is under them said on it and not shown. */
	folded: ReadonlySet<string>;
	/** How much was folded so that the tree fits its window. */
	fold: Fold;
	/** The items whose frond is on the branch to the one thing open over them: it is read on the way up to that. */
	trunks: ReadonlySet<string>;
}

/**
 * How much of a tree is folded so that it fits the window on it. Nothing but what the person
 * folded; then what is finished; then everything but the way to this person's own work; then
 * everything but the way to the session open here and to what asks them.
 */
export type Fold = "whole" | "unfinished" | "yours" | "here";

export interface LayoutOptions {
	shape?: Shape;
	/** Items the person folded. Each is one line, with what is under it said on it and not shown, whatever the room. */
	folded?: ReadonlySet<string>;
	/** Items the person opened. They stay open when the tree is folded to fit, and so does the way to them. */
	opened?: ReadonlySet<string>;
	/** Whose work the tree stays open around when it is folded to fit: this person's, unless a teammate's is being looked at. */
	around?: string;
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
/** The marks after a name: what needs someone, how many wait on it, what was said that stands on it, whether an agent changed it. */
const marksWidth = (item: Item, behind: number): number =>
	(item.asks > 0 ? 2 + String(item.asks).length : 0) + (behind > 0 ? 2 + String(behind).length : 0) + ((item.issue?.directions ?? []).length > 0 ? 2 : 0) + (item.fresh ? 2 : 0);
const labelWidth = (item: Item, behind: number, nameMax: number): number => 2 + Math.max(cells(cut(item.name, nameMax)) + marksWidth(item, behind), chipWidth(item), ...item.buds.slice(0, 2).map((bud) => 4 + cells(cut(bud.name, 16))));
const leafWidth = (item: Item, behind: number, nameMax: number): number => 2 + cells(cut(item.name, nameMax)) + marksWidth(item, behind) + (item.parent && item.parent.owner !== item.owner ? cells(item.owner) + 2 : 0);

/**
 * What the one line of a folded item says of everything under it: how far along it is, how many
 * things in it need a person, whose agents are working in it, and how many things agents changed
 * since this person looked. Nothing that needs someone is out of sight for being folded away.
 */
export interface Rollup {
	progress: string;
	asks: number;
	/** The people with an agent working somewhere in it, in the order they are met. */
	people: string[];
	fresh: number;
}

const rollups = new WeakMap<Item, Rollup>();

export function rollup(item: Item): Rollup {
	const known = rollups.get(item);
	if (known) return known;
	const out: Rollup = { progress: `${item.landed}/${item.leaves}`, asks: 0, people: [], fresh: 0 };
	const read = (at: Item): void => {
		out.asks += at.asks > 0 ? at.asks : at.agent?.state === "asking" ? 1 : 0;
		if (at.fresh) out.fresh++;
		if (at.agent?.state === "working") {
			const who = at.agent.owner ?? at.owner;
			if (who !== "" && !out.people.includes(who)) out.people.push(who);
		}
		for (const child of at.children) read(child);
		for (const bud of at.buds) read(bud);
	};
	read(item);
	rollups.set(item, out);
	return out;
}

/** The cells a folded item's line takes: its name, and what is said after it. */
const foldWidth = (item: Item, behind: number, nameMax: number): number => {
	const said = rollup(item);
	// Its mark is two cells from the stem and its name two more: a line is counted to the end of what is written on it.
	return 4 + cells(cut(item.name, nameMax)) + 1 + said.progress.length + (said.asks > 0 ? 2 + String(said.asks).length : 0) + (behind > 0 ? 2 + String(behind).length : 0) + said.people.length * 2 + (said.fresh > 0 ? 2 + String(said.fresh).length : 0);
};

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

const NONE: ReadonlySet<string> = new Set();

/** Whether two layouts draw the same items folded: where they do not, the tree moves from one to the other. */
export function sameFolds(a: Layout, b: Layout): boolean {
	if (a === b) return true;
	const drawn = (plan: Layout): string[] => [...plan.folded].filter((id) => plan.places.has(id));
	const [one, other] = [drawn(a), new Set(drawn(b))];
	return one.length === other.size && one.every((id) => other.has(id));
}

/**
 * What is folded so that a tree fits, a step at a time, each step folding everything the one
 * before did. What the person folded is folded in all of them, and what they opened in none.
 */
function foldsOf(world: World, options: LayoutOptions): Array<{ fold: Fold; folded: ReadonlySet<string> }> {
	const hand = options.folded ?? NONE;
	const who = options.around ?? world.me;
	const above = (item: Item, into: Set<string>, self = false): void => {
		for (let at = self ? item : item.parent; at && at !== world.root; at = at.parent) into.add(at.id);
	};
	const opened = new Set<string>();
	const yours = new Set<string>();
	const here = new Set<string>();
	for (const id of options.opened ?? NONE) {
		const item = world.items.get(id);
		if (item) above(item, opened, true);
	}
	for (const item of world.items.values()) {
		if (item === world.root || (item.agent?.owner ?? item.owner) !== who) continue;
		const asks = item.asks > 0 || item.agent?.state === "asking";
		// A session of theirs that has not finished, and what asks them: the way to each stays open.
		if ((item.agent && !item.done) || asks) above(item, yours);
		if (asks) above(item, here);
		// The session open in this Pi is where this person is: what is under it stays open too.
		if (item.agent?.open && who === world.me) above(item, here, true);
	}
	const within = [...world.items.values()].filter((item) => item !== world.root && item.children.length > 0 && !opened.has(item.id));
	const unfinished = new Set([...hand, ...within.filter((item) => item.leaves > 0 && item.landed === item.leaves && !here.has(item.id)).map((item) => item.id)]);
	const mine = new Set([...unfinished, ...within.filter((item) => !yours.has(item.id) && !here.has(item.id)).map((item) => item.id)]);
	const near = new Set([...mine, ...within.filter((item) => !here.has(item.id)).map((item) => item.id)]);
	const steps: Array<{ fold: Fold; folded: ReadonlySet<string> }> = [{ fold: "whole", folded: hand }];
	for (const [fold, folded] of [["unfinished", unfinished], ["yours", mine], ["here", near]] as const) if (folded.size > (steps.at(-1)?.folded.size ?? 0)) steps.push({ fold, folded });
	return steps;
}

/**
 * Lay the tree out. With room given, the first of these that fits is drawn: the tree as it likes
 * to be, then with its levels closer together, then with its names shorter. A tree too wide for
 * that is folded, a step at a time, until it fits: what is finished, then what is not this
 * person's, then what is not where they are. What fits no way is drawn as folded as it goes,
 * and scrolled.
 */
export function layout(world: World, options: LayoutOptions = {}): Layout {
	const room = options.room;
	if (!room) return arrange(world, options, { ...(DENSITIES[0] as Rows), ...(WIDTHS[0] as Columns) }, options.folded ?? NONE, "whole");
	const narrowest = WIDTHS.at(-1) as Columns;
	const steps = foldsOf(world, options);
	let plan: Layout | undefined;
	for (const [index, step] of steps.entries()) {
		// What is too wide with its names at their shortest is not laid out to find that out: on a large tree that is most of the work.
		if (index < steps.length - 1 && (measure(world, step.folded, narrowest, options.order ?? "dependency").get(world.root.id)?.width ?? 0) + narrowest.margin * 2 > room.width) continue;
		plan = fitted(world, options, step.folded, step.fold, room);
		if (plan.width <= room.width) return plan;
	}
	return plan as Layout;
}

/** The tree with these items folded, drawn in to fit the room where it can be: its levels closer together, then its names shorter. */
function fitted(world: World, options: LayoutOptions, folded: ReadonlySet<string>, fold: Fold, room: { width: number; height: number }): Layout {
	const roomy = WIDTHS[0] as Columns;
	// Helpers are written under an item, a row each: levels may not come closer than leaves them room.
	let helpers = 0;
	for (const item of world.items.values()) if (!folded.has(item.id)) helpers = Math.max(helpers, Math.min(2, item.buds.length));
	const densities = DENSITIES.filter((density, index) => index === 0 || density.band >= 4 + helpers);
	let rows = densities[0] as Rows;
	let plan = arrange(world, options, { ...rows, ...roomy }, folded, fold);
	for (const density of densities.slice(1)) {
		if (plan.height <= room.height) break;
		rows = density;
		plan = arrange(world, options, { ...rows, ...roomy }, folded, fold);
	}
	if (plan.width <= room.width) return plan;
	for (const columns of WIDTHS.slice(1)) {
		const narrower = arrange(world, options, { ...rows, ...columns }, folded, fold);
		if (narrower.width <= room.width) return narrower;
	}
	// Too wide whatever is done: the names are kept whole, since it is scrolled either way.
	return plan;
}

/** How an item and everything over it is laid out across: how wide it is, and where in that width its own node stands. */
interface Span {
	width: number;
	/** Cells from its left edge to its node. */
	stem: number;
	/** Its frond is on the branch to the one thing open under it, and takes no width of its own. */
	trunk: boolean;
}

/** The most lines an item carries on the branch to the one thing open over it. More than that is a column of its own. */
const TRUNK_LINES = 12;

/** The row of an item, counted upward from the root at 0: its level, and for a grown tree a little above or below it. */
const rowAt = (item: Item, { band, base, sway }: Pick<Density, "band" | "base" | "sway">, shape: Shape): number =>
	item.level < 0 ? 0 : -(base + item.level * band) + (shape === "grown" && sway > 0 ? (hash(item.id) % (sway * 2 + 1)) - sway : 0);

/**
 * How wide each item is with everything over it, and where its node stands: its own label, or
 * its frond and its limbs side by side. It is what the layout is laid out from, and by itself it
 * says whether a tree can fit.
 *
 * A frond beside limbs is a column of its own. With one limb, the frond is on the branch to it
 * and costs no width: the limb is raised by the rows the frond needs beyond those there are. It
 * is what keeps a tree folded around one person's work as narrow as the work itself.
 */
function measure(world: World, folded: ReadonlySet<string>, density: Pick<Density, "nameMax" | "gap">, order: Order): Map<string, Span> {
	const { nameMax, gap } = density;
	const last = world.levels.length - 1;
	const behind = (item: Item): number => world.flow.behind.get(item.id)?.length ?? 0;
	const spans = new Map<string, Span>();
	const spanOf = (item: Item): Span => {
		let frond = 0;
		let lines = 0;
		const limbs: Item[] = [];
		// In the order they are put side by side: where an item stands depends on which of its limbs is first and which last.
		for (const child of folded.has(item.id) ? [] : inOrder(world.flow, item, order)) {
			if (folded.has(child.id)) frond = Math.max(frond, foldWidth(child, behind(child), nameMax));
			else if (child.level >= last && child.children.length === 0) frond = Math.max(frond, leafWidth(child, behind(child), nameMax));
			else {
				limbs.push(child);
				continue;
			}
			lines++;
		}
		const root = item.level < 0;
		const own = root ? cells(item.name) + 12 : labelWidth(item, behind(item), nameMax);
		const over = limbs.map(spanOf);
		const only = limbs.length === 1 ? (limbs[0] as Item) : undefined;
		let span: Span;
		if (limbs.length === 0) {
			// Nothing but a frond: it grows straight out of the node. The root's own name needs the half to the left of its middle.
			span = root ? { width: Math.max(own, frond > 0 ? Math.floor(own / 2) + frond : 0), stem: Math.floor(own / 2), trunk: false } : { width: Math.max(own, frond), stem: 0, trunk: false };
		} else if (only && lines > 0 && lines <= TRUNK_LINES) {
			// One limb, and a frond: the item stands straight under the limb, and the frond is on the branch between them.
			const up = over[0] as Span;
			const stem = root ? Math.max(up.stem, Math.floor(own / 2)) : up.stem;
			span = { width: Math.max(up.width + stem - up.stem, stem + Math.max(root ? Math.ceil(own / 2) : own, frond)), stem, trunk: true };
		} else {
			let at = 0;
			const cols: number[] = [];
			if (frond > 0) {
				cols.push(0);
				at += frond + gap;
			}
			for (const up of over) {
				cols.push(at + up.stem);
				at += up.width + gap;
			}
			const width = Math.max(own, at - gap);
			const centre = Math.round(((cols[0] as number) + (cols.at(-1) as number)) / 2);
			span = { width, stem: Math.max(0, Math.min(centre, width - (root ? 0 : own))), trunk: false };
		}
		spans.set(item.id, span);
		return span;
	};
	spanOf(world.root);
	return spans;
}

function arrange(world: World, options: LayoutOptions, density: Density, folded: ReadonlySet<string>, fold: Fold): Layout {
	const { band, base, sway, headroom, nameMax, gap: GAP, margin: MARGIN } = density;
	const shape = options.shape ?? "grown";
	const last = world.levels.length - 1;
	const order = options.order ?? "dependency";
	const behind = (item: Item): number => world.flow.behind.get(item.id)?.length ?? 0;
	const open = (item: Item): Item[] => (folded.has(item.id) ? [] : inOrder(world.flow, item, order));
	// A line on a frond: an item of the last level with nothing under it, or one that is folded.
	const line = (child: Item): boolean => (child.level >= last && child.children.length === 0) || folded.has(child.id);
	const leavesOf = (item: Item): Item[] => open(item).filter(line);
	const limbsOf = (item: Item): Item[] => open(item).filter((child) => !line(child));
	const frondWidth = (item: Item): number => Math.max(0, ...leavesOf(item).map((leaf) => (folded.has(leaf.id) ? foldWidth(leaf, behind(leaf), nameMax) : leafWidth(leaf, behind(leaf), nameMax))));

	const spans = measure(world, folded, density, order);
	const spanOf = (item: Item): Span => spans.get(item.id) as Span;
	const total = spanOf(world.root).width;

	const places = new Map<string, Place>();
	const branches: Branch[] = [];
	const follows = new Map<string, Item>();
	const trunks = new Set<string>();
	// Rows are counted upward from the root at 0, and turned the right way up at the end.
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

	/** Put an item and everything over it, its left edge at `x0`. `raised` is how many rows it stands above its level, for the lines on the branches under it. */
	const put = (item: Item, x0: number, raised: number): void => {
		const limbs = limbsOf(item);
		const span = spanOf(item);
		const root = item.level < 0;
		const row = rowAt(item, density, shape) - raised;
		const col = x0 + span.stem;
		const fromY = root ? row * 4 - 5 : row * 4 - 1;
		top = Math.min(top, row);
		places.set(item.id, { item, col, row, leaf: false });
		if (limbs.length === 0) {
			// Nothing but a frond above it: the frond grows straight out of the node. The root is wider than a node, and the frond clears it.
			const bottom = root ? row - 4 : row - 2;
			stem(item, col, fromY, bottom);
			frond(item, col, bottom);
			return;
		}
		limbs.forEach((limb, index) => {
			const prior = limbs[index - 1];
			if (order === "dependency" && prior && world.flow.before.get(limb.id)?.includes(prior)) follows.set(limb.id, prior);
		});
		if (span.trunk) {
			// One thing open over it: it stands straight over the item, and the frond is read up the branch between them.
			// The lines start clear of the item, and end clear of what is written under the limb: it is raised by what that takes beyond the rows there are.
			const limb = limbs[0] as Item;
			const bottom = root ? row - 4 : row - 2;
			const needs = bottom - (leavesOf(item).length - 1) - 3 - Math.min(2, limb.buds.length);
			const more = Math.max(0, rowAt(limb, density, shape) - raised - needs);
			put(limb, col - spanOf(limb).stem, raised + more);
			const place = places.get(limb.id) as Place;
			branches.push({ to: limb, kind: "branch", points: bend(col * 2 + 1, fromY, place.col * 2 + 1, place.row * 4 + 4) });
			frond(item, col, bottom);
			trunks.add(item.id);
			return;
		}
		let at = x0;
		const frondCol = at;
		if (frondWidth(item) > 0) at += frondWidth(item) + GAP;
		for (const limb of limbs) {
			put(limb, at, raised);
			at += spanOf(limb).width + GAP;
		}
		for (const limb of limbs) {
			const place = places.get(limb.id) as Place;
			branches.push({ to: limb, kind: "branch", points: bend(col * 2 + 1, fromY, place.col * 2 + 1, place.row * 4 + 4) });
		}
		if (frondWidth(item) > 0) {
			// A frond beside the limbs is a column like theirs: its first line is level with them, and the branch to it bends as theirs do.
			// Lower, the branches to the limbs would cross what is written on it.
			const bottom = -(base + (item.level + 1) * band) - raised;
			const leaves = leavesOf(item);
			branches.push({ to: leaves.find((leaf) => !leaf.done) ?? (leaves[0] as Item), kind: "branch", points: bend(col * 2 + 1, fromY, frondCol * 2 + 1, bottom * 4 + 5) });
			stem(item, frondCol, bottom * 4 + 5, bottom);
			frond(item, frondCol, bottom);
		}
	};
	put(world.root, MARGIN, 0);

	// Turn it the right way up: headroom above the highest thing, the root near the bottom.
	const shift = headroom - top;
	for (const place of places.values()) place.row += shift;
	for (const branch of branches) for (const point of branch.points) point[1] += shift * 4;
	const rootPlace = places.get(world.root.id) as Place;
	return { width: total + MARGIN * 2, height: rootPlace.row + 3, places, branches, root: [rootPlace.col * 2 + 1, rootPlace.row * 4 + 1], order, follows, nameMax, band, folded, fold, trunks };
}
