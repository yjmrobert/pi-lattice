/**
 * What comes first. An item that waits on another comes after it, and so does everything it is
 * under: a story that waits on a story in another feature puts its feature after that one.
 * Where nothing says, what is finished comes first, then what has started, then what has not,
 * then what is held, each in the order it was filed. No Pi, no terminal.
 */
import type { Item } from "./model.ts";

/** How the items under one are put side by side: what must come first first, or as they were filed. */
export type Order = "dependency" | "filed";

export interface Flow {
	/** The items under each item, first to last. */
	ordered: Map<string, Item[]>;
	/** What each item waits on, finished or not. */
	before: Map<string, Item[]>;
	/** The unfinished items that wait on each unfinished item. */
	behind: Map<string, Item[]>;
	/** Unfinished items that cannot go ahead: something they wait on is unfinished, or what they are under is held. */
	held: Set<string>;
}

/** Finished, or with everything under it landed. */
const over = (item: Item): boolean => item.done || (item.children.length > 0 && item.landed === item.leaves);
const started = (item: Item): boolean => item.agent !== undefined || item.landed > 0 || item.children.some(started);

/** Work out the order of a tree whose progress has been counted. */
export function flowOf(root: Item, items: ReadonlyMap<string, Item>): Flow {
	const before = new Map<string, Item[]>();
	const behind = new Map<string, Item[]>();
	for (const item of items.values()) {
		// An issue names everything it waits on; `waitsOn` keeps only what still holds it.
		const ids = item.issue ? (item.issue.waitsOn ?? []).map((number) => `#${number}`) : item.waitsOn;
		const others = [...new Set(ids)].map((id) => items.get(id)).filter((other): other is Item => other !== undefined && other !== item);
		before.set(item.id, others);
		if (item.done) continue;
		for (const other of others) if (!other.done) behind.set(other.id, [...(behind.get(other.id) ?? []), item]);
	}

	const held = new Set<string>();
	const hold = (item: Item, above: boolean): void => {
		const here = item !== root && !item.done && (above || (before.get(item.id) ?? []).some((other) => !other.done));
		if (here) held.add(item.id);
		for (const child of item.children) hold(child, here);
	};
	hold(root, false);

	// A wait between two items is a wait between the two siblings they are under, where their paths part.
	const after = new Map<string, Map<string, Set<string>>>();
	for (const item of items.values()) {
		const others = before.get(item.id) ?? [];
		if (others.length === 0) continue;
		const mine = new Map<Item, Item | undefined>();
		let below: Item | undefined;
		for (let at: Item | undefined = item; at; at = at.parent) {
			mine.set(at, below);
			below = at;
		}
		for (const other of others) {
			let under: Item | undefined;
			for (let at: Item | undefined = other; at; at = at.parent) {
				if (mine.has(at)) {
					const own = mine.get(at);
					if (own && under && at.children.includes(own) && at.children.includes(under)) {
						const edges = after.get(at.id) ?? new Map<string, Set<string>>();
						edges.set(own.id, (edges.get(own.id) ?? new Set<string>()).add(under.id));
						after.set(at.id, edges);
					}
					break;
				}
				under = at;
			}
		}
	}

	// Sessions on no issue stay at the foot of a team's work.
	const issues = root.children.some((child) => child.issue);
	const stage = (item: Item): number => (issues && item.parent === root && !item.issue ? 4 : over(item) ? 0 : held.has(item.id) ? 3 : started(item) ? 1 : 2);
	const ordered = new Map<string, Item[]>();
	for (const item of items.values()) {
		if (item.children.length === 0) continue;
		const edges = after.get(item.id);
		const filed = new Map(item.children.map((child, index) => [child.id, index]));
		const left = [...item.children].sort((a, b) => stage(a) - stage(b) || (filed.get(a.id) as number) - (filed.get(b.id) as number));
		const out: Item[] = [];
		const placed = new Set<string>();
		while (left.length > 0) {
			// With everything left waiting on something left, they wait in a circle: the first breaks it.
			const free = left.findIndex((child) => ![...(edges?.get(child.id) ?? [])].some((id) => !placed.has(id)));
			const [next] = left.splice(Math.max(free, 0), 1) as [Item];
			out.push(next);
			placed.add(next.id);
		}
		ordered.set(item.id, out);
	}
	return { ordered, before, behind, held };
}

/** The items under one, in the order asked for. */
export const inOrder = (flow: Flow, item: Item, order: Order): Item[] => (order === "dependency" ? (flow.ordered.get(item.id) ?? item.children) : item.children);

/** Nobody is on it and nothing holds it: it is there to be taken. */
export const canStart = (flow: Flow, item: Item): boolean =>
	item.level >= 0 && !item.done && !item.agent && item.children.length === 0 && !flow.held.has(item.id) && item.parent?.children.includes(item) === true;
