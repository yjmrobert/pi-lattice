/**
 * What moves on the canopy, and why. Every animation is the picture of one thing that
 * happened: a message was sent, a task landed, something started needing someone, an item was
 * planned, a session was put on one, an item changed hands. They are read from the difference
 * between two looks at the world, so nothing moves when nothing happened. No Pi, no terminal.
 */
import type { Layout, Place } from "./layout.ts";
import { type Item, pathTo, type World } from "./model.ts";

export type Motion = "full" | "calm" | "off";

export type Happening =
	/** One session wrote to another. */
	| { kind: "message"; from: string; to: string }
	/** An item reported its result. */
	| { kind: "landed"; id: string }
	/** Something on an item started waiting for a person. */
	| { kind: "asked"; id: string }
	/** An item appeared in the tree. */
	| { kind: "planted"; id: string }
	/** A session was put on an item that had nobody. */
	| { kind: "seated"; id: string }
	/** An item changed owner. */
	| { kind: "handed"; id: string; from: string };

export interface Animation {
	happening: Happening;
	start: number;
	duration: number;
}

const HOP_MS = 600;
/** How many messages may be shown moving at once; the rest of a burst is not drawn. */
const MAX_MESSAGES = 6;

const asking = (item: Item): boolean => item.asks > 0 || item.agent?.state === "asking";

/** What happened between two looks at the world. */
export function happenings(before: World, after: World): Happening[] {
	const out: Happening[] = [];
	const seen = new Set(before.traffic.map((entry) => `${entry.from}>${entry.to}@${entry.at}`));
	for (const entry of after.traffic) if (!seen.has(`${entry.from}>${entry.to}@${entry.at}`)) out.push({ kind: "message", from: entry.from, to: entry.to });
	for (const item of after.items.values()) {
		if (item.level < 0) continue;
		const was = before.items.get(item.id);
		if (!was) {
			out.push({ kind: "planted", id: item.id });
			continue;
		}
		if (item.done && !was.done) out.push({ kind: "landed", id: item.id });
		if (asking(item) && !asking(was)) out.push({ kind: "asked", id: item.id });
		if (item.agent && !was.agent) out.push({ kind: "seated", id: item.id });
		if (item.owner !== was.owner) out.push({ kind: "handed", id: item.id, from: was.owner });
	}
	return out;
}

/** How far up a landing carries: to the parent, and on from every item it completes. */
function landingHops(item: Item): number {
	let hops = 1;
	for (let at = item.parent; at && at.level >= 0 && at.leaves > 0 && at.landed === at.leaves; at = at.parent) hops++;
	return hops;
}

export function durationOf(happening: Happening, world: World): number {
	if (happening.kind === "message") {
		const from = world.items.get(happening.from);
		const to = world.items.get(happening.to);
		// About a second, a little longer the further apart the two are.
		return from && to ? Math.min(1800, 500 + 220 * route(from, to).length) : 1000;
	}
	if (happening.kind === "landed") return HOP_MS * landingHops(world.items.get(happening.id) ?? world.root);
	if (happening.kind === "asked") return 900;
	if (happening.kind === "handed") return 600;
	return 400;
}

/** Add what just happened to what is still moving, and drop what has finished. */
export function advance(active: readonly Animation[], fresh: readonly Happening[], world: World, now: number): Animation[] {
	const out = active.filter((animation) => now < animation.start + animation.duration);
	for (const happening of fresh) {
		if (happening.kind === "message" && out.filter((animation) => animation.happening.kind === "message").length >= MAX_MESSAGES) continue;
		out.push({ happening, start: now, duration: durationOf(happening, world) });
	}
	return out;
}

/** The items a message passes on its way: up from the sender to what both are under, then down to the receiver. */
export function route(from: Item, to: Item): Array<{ child: Item; up: boolean }> {
	const ups = pathTo(from);
	const downs = pathTo(to);
	const shared = ups.find((item) => downs.includes(item));
	const hops: Array<{ child: Item; up: boolean }> = [];
	for (const item of ups) {
		if (item === shared) break;
		hops.push({ child: item, up: true });
	}
	const below: Array<{ child: Item; up: boolean }> = [];
	for (const item of downs) {
		if (item === shared) break;
		below.unshift({ child: item, up: false });
	}
	return [...hops, ...below];
}

/** The dots of the branch that leads to an item, from its parent to it. A helper has none: it is drawn where the item it serves is. */
export function branchTo(plan: Layout, item: Item): Array<[number, number]> {
	const place = plan.places.get(item.id);
	if (!place) return [];
	if (!place.leaf) return plan.branches.find((branch) => branch.kind === "branch" && branch.to === item)?.points ?? [];
	// A leaf: along the branch to its frond when the frond has one, up the stem, and out along its twig.
	const stemX = (place.col - 2) * 2 + 1;
	const siblings = item.parent ? item.parent.children : [];
	const limb = plan.branches.find((branch) => branch.kind === "branch" && siblings.includes(branch.to) && plan.places.get(branch.to.id)?.leaf);
	const parent = item.parent ? plan.places.get(item.parent.id) : undefined;
	const points: Array<[number, number]> = limb ? [...limb.points] : [];
	const from = limb ? (limb.points.at(-1) as [number, number])[1] : parent ? parent.row * 4 - 1 : place.row * 4 + 2;
	for (let y = from; y >= place.row * 4 + 2; y -= 0.5) points.push([stemX, y]);
	points.push([stemX + 1, place.row * 4 + 2], [stemX + 2, place.row * 4 + 2]);
	return points;
}

/** Every dot on the way from one item to another, in order. */
export function trail(plan: Layout, from: Item, to: Item): Array<[number, number]> {
	return route(from, to).flatMap((hop) => (hop.up ? [...branchTo(plan, hop.child)].reverse() : branchTo(plan, hop.child)));
}

/** The middle of an item's node, in dots. */
export const centre = (place: Place): [number, number] => [place.col * 2 + 1, place.row * 4 + 1.5];

/** How far through an animation is, from 0 to 1. */
export const progress = (animation: Animation, now: number): number => Math.max(0, Math.min(1, (now - animation.start) / animation.duration));
