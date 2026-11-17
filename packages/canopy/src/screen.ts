/**
 * The canopy's screen: a line of people, the path to what is selected, a window on the tree
 * with a panel beside it, and the keys. The tree is as big as it needs to be and the window
 * moves over it. Everything here is a function of the world, the state and the size: no Pi.
 */
import type { IssueEvent, Steer } from "@pi-lattice/protocol";
import type { Animation } from "./animate.ts";
import { cells, Grid, pad, type Style, tail } from "./grid.ts";
import { cut, type Layout, layout, type Place, type Shape } from "./layout.ts";
import { type Item, pathTo, ROOT_ID, walk, type World } from "./model.ts";
import { blend, ease } from "./morph.ts";
import { canStart, inOrder, type Order } from "./order.ts";
import { BEAT, paint, spin } from "./paint.ts";
import { COLOR, colorOf, letterOf } from "./palette.ts";

export type Side = "inspector" | "roster" | "none";

export interface CanopyState {
	selected: string | undefined;
	/** The top left cell of the window, in the tree's own cells. May be negative when the tree is smaller than the window. */
	camera: { col: number; row: number };
	/** Whether the window has been placed yet: it is, the first time the size is known. */
	framed: boolean;
	folded: ReadonlySet<string>;
	spotlight: string | undefined;
	side: Side;
	letters: boolean;
	shape: Shape;
	/** What must come first on the left, or everything as it was filed. */
	order: Order;
	/**
	 * A line being typed at the foot: what to say about the selected item to whatever tends it, what to say
	 * instead of answering, or part of a name to go to, with where the selection was before it was typed.
	 */
	typing?: { what: "say"; label: string; text: string; number?: number; nodeId?: string } | { what: "answer"; label: string; text: string; id: string; key: string } | { what: "find"; label: string; text: string; from: string | undefined };
	/** The last move made with an arrow: the opposite arrow, pressed where it led, goes back to where it started. */
	back?: { from: string; to: string; key: Arrow };
	/** Under each item, what was last left downward: going up again returns there. */
	came?: ReadonlyMap<string, string>;
	/** The changes by agents this person has been taken to, since they last looked. */
	walked: ReadonlySet<string>;
	/** The change being looked at: who made it, what, and why are written at the foot. */
	viewing?: string;
	/** Every key is listed where the tree was, from this row of the list on. */
	help?: number;
}

/** What tells one change from another: when it was made, and to which issue. */
export const changeKey = (event: IssueEvent): string => `${event.rev}:${event.issue}`;

/** What was done, as a person would say it of whoever did it. */
export function describeChange(event: IssueEvent): string {
	switch (event.what) {
		case "created": return "filed it";
		case "state": return `moved it to ${event.to ?? "another state"}`;
		case "order": return event.to ? `put it ${event.to}` : "moved it among the others";
		case "parent": return event.to ? `moved it under #${event.to}` : "moved it to the top";
		case "title": return `renamed it${event.from ? ` from "${event.from}"` : ""}`;
		case "body": return "rewrote what it says";
		case "result": return "reported a result on it";
		case "gave back": return "gave it back";
		case "direction": return event.to ? "kept what was said as a direction" : "lifted a direction";
		case "commented": return "commented on it";
		case "said": return `said: ${event.to ?? ""}`;
		case "waits on": return event.to ? `made it wait on ${event.to}` : "made it wait on nothing";
		case "assignee": return event.to ? `gave it to ${event.to}` : "took it off whoever had it";
		default: return `changed its ${event.what.replace(/^field:/, "")}${event.to !== undefined ? ` to ${event.to}` : ""}`;
	}
}

const ago = (ms: number): string => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h ago` : `${Math.floor(ms / 86_400_000)}d ago`);

export type Arrow = "up" | "down" | "left" | "right";

export type CanopyKey = "up" | "down" | "left" | "right" | "shift+up" | "shift+down" | "shift+left" | "shift+right" | "home" | "tab" | "enter" | "escape" | (string & {});

/** What the selected session waits on a person for, in full, and the keys that answer it there. */
export interface Asking {
	id: string;
	title: string;
	text: string;
	/** A key as the canopy names it (`y`, `enter`), and what it does. One with `line` takes a typed line, labelled so. */
	keys: ReadonlyArray<{ key: string; does: string; line?: string }>;
	/** How many more things the session waits on after this one. */
	more: number;
}

export type CanopyAction =
	| { do: "close" }
	/** Answer what the selected session asks, with one of the keys it was shown with. */
	| { do: "answer"; id: string; key: string; text?: string }
	| { do: "open"; id: string; tree: string }
	| { do: "start"; id: string; tree: string }
	/** Put the session open in this terminal on an issue. */
	| { do: "on"; number: number }
	/** Say something about an item, an issue by its number or a session, to whatever tends it. */
	| { do: "steer"; number?: number; nodeId?: string; text: string }
	/** Offer the session on an item to a teammate, or ask a teammate for theirs. */
	| { do: "hand"; what: "offer" | "take"; id: string }
	/** The person has been through everything agents changed. */
	| { do: "seen" }
	| { do: "say"; text: string };

/** What an item is called beside its name: an issue's type, a helper's kind, or the name of its level. */
const kindOf = (world: World, item: Item): string => (item.issue || item.parent?.buds.includes(item) ? item.kind : (world.levels[item.level] ?? item.kind));

/** Narrower or shorter than this, a label and its branch cannot both be read. */
export const FLOOR = { cols: 60, rows: 20 };
const SIDE_WIDTH = 40;
const HEADER = 2;
const FOOTER = 1;

export const initial = (world: World, current?: string, shape: Shape = "grown", order: Order = "dependency"): CanopyState => ({
	selected: current && world.items.has(current) ? current : world.root.children[0]?.id,
	camera: { col: 0, row: 0 },
	framed: false,
	folded: new Set(),
	spotlight: undefined,
	side: "inspector",
	letters: false,
	shape,
	order,
	walked: new Set(),
});

/** Who a line about an item goes to, as it is said before the line is sent. */
function tendedBy(world: World, item: Item): string {
	if (item.tender) {
		const on = world.items.get(item.tender.on);
		const whose = item.tender.owner === world.me ? "" : `${item.tender.owner}'s `;
		return `${whose}${item.tender.role}${on && on !== item ? ` on ${cut(on.name, 20)}` : ""}`;
	}
	if (item.issue) return "a session that is started to tend it";
	// With no server the work is the sessions: the nearest one above that coordinates, else the top of the tree.
	for (let at: Item | undefined = item; at && at.level >= 0; at = at.parent) if (at.agent?.role === "coordinator") return at === item ? at.agent.role : `${at.agent.role} on ${cut(at.name, 20)}`;
	return "the session at the top of its tree";
}

const sideWidth = (state: CanopyState, width: number): number => (state.side !== "none" && width >= 100 ? SIDE_WIDTH : 0);
const windowOf = (state: CanopyState, width: number, height: number): { width: number; height: number } => ({ width: width - sideWidth(state, width), height: Math.max(1, height - HEADER - FOOTER) });

/** Move the window as little as it takes to bring a place, and its label, into view. A tree smaller than the window is centred. */
export function frame(state: CanopyState, plan: Layout, width: number, height: number, centre = false): CanopyState {
	const win = windowOf(state, width, height);
	const place = placeOf(plan, state.selected);
	let { col, row } = state.camera;
	const axis = (at: number, size: number, from: number, to: number, total: number, pad: number): number => {
		if (total <= size) return -Math.floor((size - total) / 2);
		let next = at;
		if (centre) next = Math.round((from + to) / 2 - size / 2);
		else if (from - pad < next) next = from - pad;
		else if (to + pad > next + size) next = to + pad - size;
		return Math.max(0, Math.min(total - size, next));
	};
	if (place) {
		const reach = cells(cut(place.item.name, place.helper ? 16 : plan.nameMax)) + 6;
		col = axis(col, win.width, place.col - 2, place.col + reach, plan.width, 4);
		row = axis(row, win.height, place.row - 1, place.row + 2, plan.height, 2);
	} else {
		col = axis(col, win.width, 0, plan.width, plan.width, 0);
		row = axis(row, win.height, 0, plan.height, plan.height, 0);
	}
	return { ...state, camera: { col, row }, framed: true };
}

/** One world is laid out many times while a frame is drawn and a key is read: each way it is asked for is worked out once. */
const plans = new WeakMap<World, Map<string, Layout>>();

/**
 * The tree as it is drawn for a state. Given the size of the screen, it is drawn in to fit the
 * window on it where it can; without, it is the size it likes to be.
 */
export function planOf(world: World, state: CanopyState, width?: number, height?: number): Layout {
	const room = width !== undefined && height !== undefined && width >= FLOOR.cols && height >= FLOOR.rows ? windowOf(state, width, height) : undefined;
	const key = `${state.shape}|${state.order}|${[...state.folded].sort().join(",")}|${room ? `${room.width}x${room.height}` : ""}`;
	const known = plans.get(world) ?? new Map<string, Layout>();
	plans.set(world, known);
	const plan = known.get(key) ?? layout(world, { shape: state.shape, folded: state.folded, order: state.order, ...(room ? { room } : {}) });
	known.set(key, plan);
	return plan;
}

/** The session on an item that can change hands: its id, and whether it is this person's to offer or a teammate's to ask for. */
function handOf(world: World, item: Item): { id: string; mine: boolean; owner: string } | undefined {
	if (!item.session || item.outside) return undefined;
	const owner = item.agent?.owner ?? item.owner;
	return { id: item.session, mine: owner === world.me, owner };
}

/** What nobody is on and nothing holds, among the tips, and what is held there. */
const tipsOf = (world: World): { free: Item[]; held: Item[] } => {
	const tips = [...world.items.values()].filter((item) => item.level >= 0 && item.children.length === 0 && item.parent?.children.includes(item));
	return { free: tips.filter((item) => canStart(world.flow, item)), held: tips.filter((item) => world.flow.held.has(item.id)) };
};

// --- keys ----------------------------------------------------------------------

/** How many of an item's helpers are written under it; the rest are counted. */
const HELPERS_SHOWN = 2;

/** Where something is drawn: an item where the layout put it, or a helper on its line under the item it helps. */
export interface Spot extends Place {
	helper?: boolean;
}

/** Where what has this id is drawn, when it is. */
export function placeOf(plan: Layout, id: string | undefined): Spot | undefined {
	if (id === undefined) return undefined;
	const placed = plan.places.get(id);
	if (placed) return placed;
	for (const place of plan.places.values()) {
		if (place.leaf) continue;
		const at = place.item.buds.slice(0, HELPERS_SHOWN).findIndex((bud) => bud.id === id);
		if (at >= 0) return { item: place.item.buds[at] as Item, col: place.col + 4, row: place.row + 2 + at, leaf: true, helper: true };
	}
	return undefined;
}

const OPPOSITE: Record<Arrow, Arrow> = { up: "down", down: "up", left: "right", right: "left" };

/**
 * Where an arrow leads. The tree grows upward, and the arrows follow what is drawn: up is into what
 * is under an item, down is to what it belongs to, left and right are along its level. Across, an
 * item goes to the nearest one of its own level, and a task to the task beside it on the next
 * stem; only where there is none on that side does it go to whatever is nearest. Helpers are
 * written under the item they help, so down from the item reads through them first.
 */
function step(plan: Layout, state: CanopyState, from: Spot, key: Arrow): string | undefined {
	// Back the way one came is back where one was, whatever the shape of the tree says is nearest.
	if (state.back && state.back.to === from.item.id && OPPOSITE[state.back.key] === key && placeOf(plan, state.back.from)) return state.back.from;
	const top = (item: Item | undefined): string | undefined => (item && item.id !== ROOT_ID ? item.id : undefined);
	// A helper is on a line of its own under what it helps: up and down read those lines, and across it is where that item is.
	if (from.helper) {
		const helped = from.item.parent as Item;
		const shown = helped.buds.slice(0, HELPERS_SHOWN);
		const at = shown.indexOf(from.item);
		if (key === "up") return (shown[at - 1] ?? helped).id;
		if (key === "down") return shown[at + 1]?.id ?? top(helped.parent);
		const beside = plan.places.get(helped.id);
		const { back: _back, ...rest } = state;
		return beside ? step(plan, rest, beside, key) : undefined;
	}
	const item = from.item;
	const others = [...plan.places.values()].filter((place) => place.item.id !== ROOT_ID && place !== from);
	if (key === "left" || key === "right") {
		const side = others.filter((place) => (key === "right" ? place.col > from.col : place.col < from.col));
		const nearest = (places: Place[]): string | undefined => places.sort((a, b) => Math.abs(a.col - from.col) - Math.abs(b.col - from.col) || Math.abs(a.row - from.row) - Math.abs(b.row - from.row))[0]?.item.id;
		// Its own kind first: an item of the same level, or for a task, a task on the nearest stem that way.
		const level = side.filter((place) => place.leaf === from.leaf && (from.leaf || place.item.level === item.level));
		if (level.length > 0) return nearest(level);
		return side.sort((a, b) => Math.abs(a.col - from.col) + Math.abs(a.row - from.row) * 6 - (Math.abs(b.col - from.col) + Math.abs(b.row - from.row) * 6))[0]?.item.id;
	}
	if (from.leaf) {
		const frond = others.filter((place) => place.leaf && place.item.parent === item.parent).concat(from).sort((a, b) => a.row - b.row);
		const at = frond.indexOf(from);
		if (key === "up") return frond[at - 1]?.item.id;
		return frond[at + 1]?.item.id ?? top(item.parent);
	}
	if (key === "down") return item.buds[0]?.id ?? top(item.parent);
	// Up: where one last came down from, else into the nearest thing under it.
	const last = state.came?.get(item.id);
	if (last !== undefined && placeOf(plan, last)) return last;
	const under = item.children.map((child) => plan.places.get(child.id)).filter((place): place is Place => place !== undefined);
	return under.sort((a, b) => Math.abs(a.col - from.col) - Math.abs(b.col - from.col) || b.row - a.row)[0]?.item.id;
}

/** The items whose name has what was typed in it, or whose number it is, in the order the tree is read. */
function found(world: World, plan: Layout, text: string): Item[] {
	const wanted = text.trim().toLowerCase();
	if (wanted === "") return [];
	const number = /^#?\d+$/.test(wanted) ? Number(wanted.replace("#", "")) : undefined;
	const all = walk(world.root).filter((item) => item.level >= 0 && placeOf(plan, item.id));
	const starts = all.filter((item) => item.name.toLowerCase().startsWith(wanted) || (number !== undefined && item.issue?.number === number));
	return [...starts, ...all.filter((item) => !starts.includes(item) && item.name.toLowerCase().includes(wanted))];
}

const ARROWS: Record<string, Arrow> = { up: "up", down: "down", left: "left", right: "right", k: "up", j: "down", h: "left", l: "right" };

/** What a key does. Returns the next state and what the host of the screen must do. */
export function interpret(world: World, state: CanopyState, key: CanopyKey, width: number, height: number, asking?: Asking, leave?: ReadonlyArray<readonly [string, string]>): { state: CanopyState; actions: CanopyAction[] } {
	const plan = planOf(world, state, width, height);
	const here = placeOf(plan, state.selected);
	const item = here?.item;
	// Going somewhere by anything but an arrow leaves no way back to retrace.
	const go = (id: string | undefined): { state: CanopyState; actions: CanopyAction[] } => {
		if (!id) return { state, actions: [] };
		const { back: _back, ...rest } = state;
		return { state: frame({ ...rest, selected: id }, plan, width, height), actions: [] };
	};
	const keep = (next: CanopyState, actions: CanopyAction[] = []): { state: CanopyState; actions: CanopyAction[] } => ({ state: next, actions });
	const win = windowOf(state, width, height);
	const pan = (dc: number, dr: number): { state: CanopyState; actions: CanopyAction[] } =>
		keep({ ...state, camera: { col: plan.width <= win.width ? state.camera.col : Math.max(0, Math.min(plan.width - win.width, state.camera.col + dc)), row: plan.height <= win.height ? state.camera.row : Math.max(0, Math.min(plan.height - win.height, state.camera.row + dr)) } });

	// While a line is being typed, every key is for it.
	if (state.typing) {
		const { typing, ...rest } = state;
		if (typing.what === "find") {
			// Each letter goes to the first thing it finds; tab goes on to the next; escape is back where it started.
			if (key === "escape") return keep(typing.from !== undefined && placeOf(plan, typing.from) ? frame({ ...rest, selected: typing.from }, plan, width, height) : rest);
			if (key === "enter") return keep(rest);
			if (key === "tab" || key === "down" || key === "up") {
				const all = found(world, plan, typing.text);
				const at = all.findIndex((other) => other.id === state.selected);
				const next = all[(at + (key === "up" ? all.length - 1 : 1)) % Math.max(1, all.length)];
				return keep(next ? frame({ ...state, selected: next.id }, plan, width, height) : state);
			}
			const text = key === "backspace" ? [...typing.text].slice(0, -1).join("") : [...key].length === 1 ? typing.text + key : typing.text;
			const first = found(world, plan, text)[0];
			const { back: _back, ...still } = state;
			return keep(frame({ ...still, selected: first?.id ?? (text === "" ? typing.from : state.selected), typing: { ...typing, text } }, plan, width, height));
		}
		if (key === "escape") return keep(rest);
		if (key === "backspace") return keep({ ...state, typing: { ...typing, text: [...typing.text].slice(0, -1).join("") } });
		if (key === "enter") {
			const text = typing.text.trim().replace(/\s+/g, " ");
			if (text === "") return keep(rest);
			if (typing.what === "answer") return keep(rest, [{ do: "answer", id: typing.id, key: typing.key, text }]);
			return keep(rest, [{ do: "steer", ...(typing.number !== undefined ? { number: typing.number } : {}), ...(typing.nodeId !== undefined ? { nodeId: typing.nodeId } : {}), text }]);
		}
		return [...key].length === 1 ? keep({ ...state, typing: { ...typing, text: typing.text + key } }) : keep(state);
	}
	// The list of keys is read, then closed: nothing else is done from it.
	if (state.help !== undefined) {
		const { help, ...rest } = state;
		if (key === "?" || key === "escape" || key === "q") return keep(rest);
		// It may be longer than the window: the arrows read on.
		const most = Math.max(0, helpList(width, leave).height - win.height);
		const by = key === "down" || key === "j" ? 1 : key === "up" || key === "k" ? -1 : 0;
		return keep({ ...state, help: Math.max(0, Math.min(most, help + by)) });
	}
	if (key === "?") return keep({ ...state, help: 0 });
	if (key === "escape" || key === "q") return keep(state, [{ do: "close" }]);
	// While the selected session asks something, the keys that answer it mean that and nothing else.
	const answers = asking?.keys.find((entry) => entry.key === key);
	if (asking && answers) return answers.line ? keep({ ...state, typing: { what: "answer", label: answers.line, text: "", id: asking.id, key } }) : keep(state, [{ do: "answer", id: asking.id, key }]);
	// A change being looked at stays until something else is done; x puts it back, u goes on.
	const viewing = state.viewing ? world.changes.find((event) => changeKey(event) === state.viewing) : undefined;
	if (state.viewing && key !== "x" && key !== "u") {
		const { viewing: _viewing, ...rest } = state;
		return interpret(world, rest, key, width, height, asking);
	}
	if (key === "x" && viewing) {
		const { viewing: _viewing, ...rest } = state;
		if (world.stale) return keep(rest, [{ do: "say", text: `Nothing can be changed: ${world.stale}` }]);
		return keep(rest, [{ do: "steer", number: viewing.issue, text: `Put this back: ${viewing.as ?? "an agent"} ${describeChange(viewing)}${viewing.why ? `, because "${viewing.why}"` : ""}. I do not want that.` }]);
	}
	if (key === "u") {
		const next = world.changes.find((event) => !state.walked.has(changeKey(event)));
		const { viewing: _viewing, ...rest } = state;
		if (!next) return keep({ ...rest, walked: new Set() }, world.changes.length > 0 ? [{ do: "seen" }, { do: "say", text: "That is everything agents changed since you looked." }] : [{ do: "say", text: "No agent has changed anything since you looked." }]);
		// What it is on may be folded away: then the nearest thing above it that is drawn.
		let at = world.items.get(`#${next.issue}`);
		while (at && !plan.places.has(at.id) && at.parent) at = at.parent;
		return keep(frame({ ...rest, selected: at?.id ?? state.selected, walked: new Set(state.walked).add(changeKey(next)), viewing: changeKey(next) }, plan, width, height));
	}
	// Say something about what is selected, to whatever tends it. It is the one way a person changes the work.
	if (key === " ") {
		if (!item) return keep(state);
		if (item.issue) {
			if (world.stale) return keep(state, [{ do: "say", text: `Nothing can be said: ${world.stale}` }]);
			return keep({ ...state, typing: { what: "say", label: `to ${tendedBy(world, item)}, about ${cut(item.name, 28)}`, text: "", number: item.issue.number } });
		}
		if (item.owner !== world.me) return keep(state, [{ do: "say", text: `"${item.name}" is ${item.owner}'s. It is theirs to steer.` }]);
		return keep({ ...state, typing: { what: "say", label: `to ${tendedBy(world, item)}, about ${cut(item.name, 28)}`, text: "", nodeId: item.node?.id ?? item.id } });
	}
	const arrow = ARROWS[key];
	if (arrow) {
		if (!here) return go(world.root.children[0]?.id);
		const to = step(plan, state, here, arrow);
		if (to === undefined) return keep(state);
		// Leaving downward is remembered on what one arrives at, so that up from there comes back.
		const came = arrow === "down" && !placeOf(plan, to)?.leaf ? new Map(state.came).set(to, here.item.id) : state.came;
		return keep(frame({ ...state, selected: to, back: { from: here.item.id, to, key: arrow }, ...(came ? { came } : {}) }, plan, width, height));
	}
	// Go to something by its name: the tree may be larger than what the arrows cross quickly.
	if (key === "/") return keep({ ...state, typing: { what: "find", label: "go to", text: "", from: state.selected } });
	if (key === "shift+left") return pan(-12, 0);
	if (key === "shift+right") return pan(12, 0);
	if (key === "shift+up") return pan(0, -4);
	if (key === "shift+down") return pan(0, 4);
	// Home: the whole tree, centred on its middle.
	if (key === "home") return keep({ ...frame({ ...state, selected: undefined }, plan, width, height, true), selected: state.selected });
	if (key === "tab") {
		// The next thing that needs someone, in the order the tree is read.
		const asking = walk(world.root).filter((other) => other.asks > 0 || other.agent?.state === "asking").filter((other) => plan.places.has(other.id));
		const at = asking.findIndex((other) => other.id === state.selected);
		return asking.length > 0 ? go(asking[(at + 1) % asking.length]?.id) : keep(state, [{ do: "say", text: "Nothing needs anyone." }]);
	}
	if (key === ".") {
		// The next thing that is there to be taken, in the order the tree is drawn.
		const read = (from: Item): Item[] => [from, ...inOrder(world.flow, from, state.order).flatMap(read)];
		const free = read(world.root).filter((other) => canStart(world.flow, other) && plan.places.has(other.id));
		const at = free.findIndex((other) => other.id === state.selected);
		return free.length > 0 ? go(free[(at + 1) % free.length]?.id) : keep(state, [{ do: "say", text: "Nothing is there to be taken: everything is started, finished or held." }]);
	}
	if (key === "O") {
		const next: CanopyState = { ...state, order: state.order === "dependency" ? "filed" : "dependency" };
		return keep(frame(next, planOf(world, next, width, height), width, height));
	}
	if (key === "a") {
		// The panel takes room from the tree, or gives it back: the tree is drawn for the room there is now.
		const next: CanopyState = { ...state, side: state.side === "inspector" ? "roster" : state.side === "roster" ? "none" : "inspector" };
		return keep(frame(next, planOf(world, next, width, height), width, height));
	}
	if (key === "i") return keep({ ...state, letters: !state.letters });
	if (key === "r") return keep(frame({ ...state, shape: state.shape === "grown" ? "ruled" : "grown" }, planOf(world, { ...state, shape: state.shape === "grown" ? "ruled" : "grown" }, width, height), width, height, true));
	if (key === "0") return keep({ ...state, spotlight: undefined });
	if (/^[1-9]$/.test(key)) {
		const person = world.people[Number(key) - 1];
		return person ? keep({ ...state, spotlight: state.spotlight === person.name ? undefined : person.name }) : keep(state);
	}
	if (!item) return keep(state);
	if (key === "f") {
		if (item.children.length === 0) return keep(state);
		const folded = new Set(state.folded);
		if (!folded.delete(item.id)) folded.add(item.id);
		const next = { ...state, folded };
		return keep(frame(next, planOf(world, next, width, height), width, height));
	}
	if (key === "enter") {
		if (state.folded.has(item.id)) return interpret(world, state, "f", width, height);
		if (item.outside) return keep(state, [{ do: "say", text: `${item.agent?.role ?? "An agent"} holds #${item.issue?.number} from a shell: it is not a session, and there is nothing here to open.` }]);
		if (item.planned) return keep(state, [{ do: "say", text: item.issue ? `Nobody is on #${item.issue.number} yet. Press space to say what should happen to it, or s to put the session open here on it.` : `Nobody is on "${item.name}" yet. Press s to put a session on it.` }]);
		// With a server, a teammate's session is known only as the server tells it: there is nothing here to open.
		if (!item.node && (item.issue || item.agent?.owner)) {
			return keep(state, [{ do: "say", text: item.agent ? `That is ${item.agent.owner ?? item.owner}'s session, running on their machine.` : `#${item.issue?.number} is finished, and nobody is on it.` }]);
		}
		return keep(state, [{ do: "open", id: item.node?.id ?? item.id, tree: item.tree }]);
	}
	// Hand a session over: offer one's own to a teammate, or ask a teammate for theirs. The same keys as in the list of sessions.
	if (key === "o" || key === "t") {
		const whose = handOf(world, item);
		if (!whose) return keep(state, [{ do: "say", text: item.planned ? `Nobody is on "${cut(item.name, 30)}": there is no session to hand over.` : `There is no session on "${cut(item.name, 30)}" to hand over.` }]);
		if (key === "o") return whose.mine ? keep(state, [{ do: "hand", what: "offer", id: whose.id }]) : keep(state, [{ do: "say", text: `That session is ${whose.owner}'s. Press t to ask them for it.` }]);
		return whose.mine ? keep(state, [{ do: "say", text: "That session is yours already. Press o to offer it to a teammate." }]) : keep(state, [{ do: "hand", what: "take", id: whose.id }]);
	}
	if (key === "s" && item.issue) return keep(state, [{ do: "on", number: item.issue.number }]);
	if (key === "s") {
		if (!item.planned && item.waitsOn.length === 0) return keep(state, [{ do: "say", text: `"${item.name}" has already started.` }]);
		if (item.owner !== world.me) return keep(state, [{ do: "say", text: `"${item.name}" is ${item.owner}'s to start.` }]);
		return keep(state, [{ do: "start", id: item.id, tree: item.tree }]);
	}
	return keep(state);
}

// --- drawing --------------------------------------------------------------------

/** Break text into lines of at most `width`, at spaces. */
function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line && cells(line) + 1 + cells(word) > width) {
			out.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	return line ? [...out, line] : out;
}

// Read from the palette each time they are used: it may be a dark one now and a light one later.
const DIM: Style = { get fg() { return COLOR.dim; } };
const KEYCAP: Style = { get fg() { return COLOR.bright; }, get bg() { return COLOR.keycap; } };
/** A key that answers what a session asks. */
const ANSWER: Style = { get fg() { return COLOR.onAttention; }, get bg() { return COLOR.attention; }, bold: true };

/** Write runs of styled text one after another, and say where the next would start. */
function run(grid: Grid, col: number, row: number, parts: Array<[text: string, style?: Style | undefined]>): number {
	let at = col;
	for (const [text, style] of parts) {
		grid.text(at, row, text, style ?? { fg: COLOR.text });
		at += cells(text);
	}
	return at;
}

const stateWord = { working: "working", asking: "asks someone", waiting: "waits on others", idle: "idle", failed: "failed" } as const;
const glyphOf = (item: Item, tick: number): string => (item.failed ? "✗" : item.done ? "✓" : item.agent ? (item.agent.state === "working" ? spin(tick) : item.agent.state === "asking" ? "●" : item.agent.state === "waiting" ? "⧗" : "·") : "○");
const glyphStyle = (world: World, item: Item): Style => (item.failed ? { fg: COLOR.failed } : item.asks > 0 || item.agent?.state === "asking" ? { fg: COLOR.attention, bold: true } : item.planned ? DIM : { fg: colorOf(world, item.owner) });
const bar = (done: number, of: number, width: number): [string, string] => {
	const filled = of > 0 ? Math.round((done / of) * width) : 0;
	return ["█".repeat(filled), "░".repeat(width - filled)];
};

function header(world: World, state: CanopyState, width: number, tick: number): Grid {
	const grid = new Grid(width, HEADER);
	let at = run(grid, 1, 0, [["◆ ", { fg: COLOR.root }], [world.root.name, { fg: COLOR.root, bold: true }], ["  "]]);
	world.people.forEach((person, index) => {
		if (at > width - 12) return;
		const color = colorOf(world, person.name);
		const lit = !state.spotlight || state.spotlight === person.name;
		const style: Style = { fg: lit ? color : COLOR.faint, level: person.online ? 1 : 0.55, bold: state.spotlight === person.name };
		at = run(grid, at, 0, [[`${index + 1}`, state.spotlight === person.name ? KEYCAP : DIM], [" "], [`${person.online ? "" : "○"}@${person.name}`, style]]);
		if (!person.online) at = run(grid, at, 0, [[" away", DIM]]);
		if (person.working > 0) at = run(grid, at, 0, [[" "], [`${spin(tick)}${person.working}`, style]]);
		if (person.asking > 0) at = run(grid, at, 0, [[" "], [`●${person.asking}`, { fg: COLOR.attention, bold: true }]]);
		at = run(grid, at, 0, [[` ${person.owned}`, DIM], ["   "]]);
	});
	// The path from the root to what is selected.
	const item = state.selected ? world.items.get(state.selected) : undefined;
	const path = item ? pathTo(item).reverse() : [world.root];
	at = 1;
	path.forEach((step, index) => {
		const final = index === path.length - 1;
		at = run(grid, at, 1, [[cut(step.name), final ? { fg: COLOR.bright, bold: true } : DIM], [final ? "" : " ▸ ", DIM]]);
	});
	if (item && item.level >= 0) at = run(grid, at, 1, [[`  ${kindOf(world, item)}${item.issue ? ` #${item.issue.number}` : ""}`, DIM]]);
	// At the right: how the tree is ordered, and how much of it can go ahead.
	const tips = tipsOf(world);
	const flow: Array<[string, Style]> = [...(world.changes.length > 0 ? ([[`+${world.changes.length}`, { fg: COLOR.bright, bold: true }], [" changed by agents", DIM], [" · ", DIM]] as Array<[string, Style]>) : []), [state.order === "dependency" ? "first to last" : "as filed", { fg: COLOR.text }], [" · ", DIM], [`${tips.free.length}`, { fg: COLOR.bright }], [" can start", DIM]];
	if (tips.held.length > 0) flow.push([" · ", DIM], [`⧗${tips.held.length}`, { fg: COLOR.wait }], [" held", DIM]);
	const long = flow.reduce((sum, [text]) => sum + cells(text), 0);
	if (at + 3 + long <= width - 1) run(grid, width - 1 - long, 1, flow);
	return grid;
}

function footer(world: World, state: CanopyState, width: number, leave?: ReadonlyArray<readonly [string, string]>, away = false, asking?: Asking, banded = false): Grid {
	const grid = new Grid(width, FOOTER);
	if (state.typing && banded) {
		// The line itself is in the band, under the question: here are only its keys.
		run(grid, 1, 0, [[" ⏎ ", KEYCAP], [" send   ", DIM], [" esc ", KEYCAP], [" cancel", DIM]]);
		return grid;
	}
	if (state.typing) {
		const room = Math.max(8, width - cells(state.typing.label) - (state.typing.what === "find" ? 50 : 30));
		const shown = tail(state.typing.text, room);
		const keys: Array<[string, Style]> = state.typing.what === "find" ? [[" ⏎ ", KEYCAP], [" stay here   ", DIM], [" tab ", KEYCAP], [" next   ", DIM], [" esc ", KEYCAP], [" back", DIM]] : [[" ⏎ ", KEYCAP], [" send   ", DIM], [" esc ", KEYCAP], [" cancel", DIM]];
		run(grid, 1, 0, [[` ${state.typing.label}: `, { fg: COLOR.bright, bold: true }], [`${shown}▏`, { fg: COLOR.text }], ["   ", DIM], ...keys]);
		return grid;
	}
	const keys = footerKeys(world, state, leave, away);
	// A key that answers what is asked means only that while it is asked: it is not listed twice.
	const taken = new Set(away ? [] : (asking?.keys ?? []).map((entry) => keyName(entry.key)));
	// The key that lists every key is always there, at the end: the rest are the ones that fit before it.
	const last = away || state.help !== undefined ? undefined : (["?", "keys"] as const);
	const room = width - (last ? last[0].length + last[1].length + 5 : 0);
	let at = 1;
	for (const [key, does] of keys) {
		if (taken.has(key)) continue;
		if (at + cells(key) + does.length + 4 > room) break;
		at = run(grid, at, 0, [[` ${key} `, KEYCAP], [` ${does}   `, DIM]]);
	}
	if (last) run(grid, at, 0, [[` ${last[0]} `, KEYCAP], [` ${last[1]}`, DIM]]);
	return grid;
}

/**
 * The keys said at the foot, most useful first: what leads out, how to move, and what can be done
 * to what is selected. Each is one the canopy acts on here and now. `?` lists the rest.
 */
export function footerKeys(world: World, state: CanopyState, leave?: ReadonlyArray<readonly [string, string]>, away = false): Array<[key: string, does: string]> {
	const item = state.selected ? world.items.get(state.selected) : undefined;
	const named = (leave ?? []).map(([key, does]): [string, string] => [key, does]);
	// The keys are not the canopy's while the keyboard is elsewhere: only what leads here is said.
	if (away) return named;
	if (state.help !== undefined) return [["↑↓", "read on"], ["?", "back to the tree"]];
	// In a layout, the keys that lead to the chat are said first: they are what a person arriving
	// needs, and the canopy may be narrow there. As an overlay, escape goes back and is said last.
	const keys: Array<[string, string]> = [...named, ["←↑↓→", "move"], ["/", "go to"], ["space", "say what you want"]];
	if (world.changes.length > 0) keys.push(["u", `${world.changes.length} changed by agents`]);
	keys.push(["tab", "next that needs someone"]);
	if (item?.issue) {
		if (item.node) keys.push(["⏎", "open"]);
		keys.push(["s", "put this session on it"]);
	} else if (item?.planned && item.owner === world.me) keys.push(["s", "put a session on it"]);
	else if (item && !item.planned && (item.node || !item.agent?.owner)) keys.push(["⏎", item.owner === world.me ? "open" : "read"]);
	const hand = item ? handOf(world, item) : undefined;
	// Offering needs someone to offer to; asking needs a session that is someone else's.
	if (hand && (hand.mine ? world.people.length > 1 : true)) keys.push(hand.mine ? ["o", "offer"] : ["t", "take"]);
	if (item && item.children.length > 0) keys.push(["f", state.folded.has(item.id) ? "unfold" : "fold"]);
	keys.push([".", "next to start"]);
	if (!leave) keys.push(["esc", "back"]);
	return keys;
}

/** Every key the canopy takes, for the list `?` shows: the name of the key as it is said, and what it does. */
export const ALL_KEYS: ReadonlyArray<readonly [section: string, keys: ReadonlyArray<readonly [key: string, does: string]>]> = [
	["Moving", [
		["← ↑ ↓ →  h j k l", "along a level, up into what is under an item, down to what it belongs to"],
		["/", "go to an item by part of its name, or an issue by its number; tab goes on to the next"],
		["tab", "the next thing that needs someone"],
		[".", "the next thing nobody is on and nothing holds"],
		["shift+← ↑ ↓ →", "move the window over a tree larger than it"],
		["home", "the middle of the whole tree"],
	]],
	["What is selected", [
		["space", "say what you want about it to whatever tends it: it changes the work and answers at the foot"],
		["⏎", "open the session on it; unfold it when it is folded"],
		["s", "put the session open here on an issue; start a planned item of your own"],
		["o", "offer the session on it to a teammate"],
		["t", "ask a teammate for the session on it"],
		["f", "fold what is under it into it, or unfold it"],
	]],
	["What agents changed", [
		["u", "go to the next thing an agent changed since you looked, with who and why"],
		["x", "there: have it put back"],
	]],
	["The view", [
		["a", "the panel beside the tree: what is selected, then everyone's agents, then none"],
		["O", "what must come first on the left, or everything as it was filed"],
		["1-9  0", "keep one person's colour and grey the rest; 0 brings everyone back"],
		["i", "a letter beside each item for whose it is, to read without colour"],
		["r", "every level on one row, or grown like a tree"],
		["?", "show or hide this list"],
	]],
];

/** What a key that leads out of the canopy does, said in full: the foot has room for a word. */
const LEAVES: Record<string, string> = {
	chat: "the chat of the session open here, over the tree; from there, back to the tree",
	tree: "back to the tree",
	sessions: "the sessions as a list: where one is made, renamed, stopped or archived",
};

/** Every key and what it does, as tall as it needs to be: the window on the tree shows it in place of the tree. */
function helpList(width: number, leave?: ReadonlyArray<readonly [string, string]>): Grid {
	// What leads out of the canopy depends on where it is shown: those keys come from there, and are said last.
	const out: ReadonlyArray<readonly [string, string]> = leave ? leave.map(([key, does]) => [key, LEAVES[does] ?? does] as const) : [["esc  q", "back to where the canopy was opened from"]];
	const all = [...ALL_KEYS, ...(out.length > 0 ? [["Leaving", out] as const] : [])];
	const keyWidth = Math.max(...all.flatMap(([, keys]) => keys.map(([key]) => cells(key))));
	const room = Math.max(16, width - keyWidth - 8);
	const rows: Array<Array<[number, string, Style]>> = [];
	for (const [section, keys] of all) {
		rows.push([[2, section.toUpperCase(), DIM]]);
		for (const [key, does] of keys) wrap(does, room).forEach((line, index) => rows.push([...(index === 0 ? ([[3, key, { fg: COLOR.bright, bold: true }]] as Array<[number, string, Style]>) : []), [5 + keyWidth, line, { fg: COLOR.text }]]));
		rows.push([]);
	}
	const grid = new Grid(width, rows.length);
	rows.forEach((parts, row) => parts.forEach(([col, text, style]) => grid.text(col, row, text, style)));
	return grid;
}

const keyName = (key: string): string => (key === "enter" ? "⏎" : key);
/** The most lines of a question that are drawn; the rest is read in the session's chat. */
const ASKING_LINES = 8;

/** What the selected session asks, in full, with the keys that answer it: a band under the tree, as wide as the tree's window. */
function askingBand(asking: Asking, width: number, away: boolean, typing?: { label: string; text: string }): Grid {
	const amber: Style = { fg: COLOR.attention, bold: true };
	const room = Math.max(10, width - 5);
	const all = asking.text.split("\n").flatMap((line) => (line.trim() === "" ? [""] : wrap(line, room)));
	const text = all.length > ASKING_LINES ? [...all.slice(0, ASKING_LINES - 1), "…"] : all;
	const grid = new Grid(width, text.length + 3);
	grid.text(0, 0, "─".repeat(width), { fg: COLOR.attention, level: 0.5 });
	const more = asking.more > 0 ? `+${asking.more} more` : "";
	run(grid, 1, 1, [["? ", amber], [cut(asking.title, Math.max(8, width - 6 - more.length)), { fg: COLOR.bright, bold: true }]]);
	if (more) grid.text(Math.max(1, width - 1 - more.length), 1, more, DIM);
	text.forEach((line, index) => grid.text(3, 2 + index, line, { fg: COLOR.text }));
	const foot = 2 + text.length;
	// The line typed instead of an answer is written where the answers were: under what it answers.
	if (typing) {
		const room = Math.max(8, width - cells(typing.label) - 8);
		run(grid, 3, foot, [[`${typing.label} `, amber], ["› ", { fg: COLOR.attention, level: 0.6 }], [`${tail(typing.text, room)}▏`, { fg: COLOR.bright }]]);
		return grid;
	}
	// The keys are not the canopy's while the keyboard is elsewhere: then the band only says what is asked.
	// They are the one thing on the screen to press, so they are amber where every other key is grey.
	let at = 2;
	for (const { key, does } of away ? [] : asking.keys) {
		const name = keyName(key);
		if (at + name.length + does.length + 5 > width) break;
		at = run(grid, at, foot, [[` ${name} `, ANSWER], [` ${does}   `, { fg: COLOR.text }]]);
	}
	return grid;
}

/** How long an answer stays at the foot after it came. */
const ANSWER_MS = 45_000;
/** How long a line nobody has answered yet stays there. */
const UNANSWERED_MS = 5 * 60_000;

/** What a person said last that is still being read, or was answered a moment ago. */
export const steerShown = (world: World, now: number): Steer | undefined => {
	const last = world.steers.at(-1);
	if (!last) return undefined;
	if (last.answer === undefined) return now === 0 || now - last.at < UNANSWERED_MS ? last : undefined;
	return now === 0 || now - (last.answeredAt ?? last.at) < ANSWER_MS ? last : undefined;
};

/**
 * The foot of the tree where a person and the agents speak: the line being said and who it goes
 * to; what was said and what was answered; or a change an agent made, with why. A band like the
 * one a question is asked in, in the person's colour and not amber: nothing here needs anyone.
 */
function speakingBand(world: World, state: CanopyState, width: number, now: number, tick: number, away: boolean): Grid | undefined {
	const mine = colorOf(world, world.me);
	const room = Math.max(10, width - 6);
	const rows: Array<Array<[string, (Style | undefined)?]>> = [];
	let edge = mine;
	if (state.typing?.what === "say") {
		rows.push([[state.typing.label, { fg: mine, bold: true }]]);
		rows.push([["› ", { fg: mine, level: 0.6 }], [`${tail(state.typing.text, room - 3)}▏`, { fg: COLOR.bright }]]);
		rows.push([["It changes the work to match, and says here what it did.", DIM]]);
	} else if (state.viewing) {
		const event = world.changes.find((entry) => changeKey(entry) === state.viewing);
		if (!event) return undefined;
		edge = COLOR.bright;
		const left = world.changes.filter((entry) => !state.walked.has(changeKey(entry))).length;
		rows.push([["+ ", { fg: COLOR.bright, bold: true }], [`${event.as ?? "an agent"} `, { fg: COLOR.bright, bold: true }], [cut(describeChange(event), Math.max(8, room - 24)), { fg: COLOR.text }], [now > 0 ? `   ${ago(now - event.at)}` : "", DIM]]);
		if (event.why) wrap(event.why, room - 5).slice(0, 2).forEach((part, index) => rows.push([[index === 0 ? "why  " : "     ", DIM], [part, { fg: COLOR.text }]]));
		else rows.push([["It did not say why.", DIM]]);
		if (!away) rows.push([[" x ", KEYCAP], [" put it back   ", DIM], [" u ", KEYCAP], [left > 0 ? ` next, ${left} more` : " done", DIM]]);
	} else {
		const steer = steerShown(world, now);
		if (!steer) return undefined;
		rows.push([["you  ", { fg: mine, bold: true }], [cut(steer.text, Math.max(8, room - 40)), { fg: COLOR.text }], [`   about ${cut(steer.about, 30)}`, DIM]]);
		const who = `${steer.to.role}${steer.to.name && steer.to.name !== steer.to.role ? ` on ${cut(steer.to.name, 20)}` : ""}`;
		if (steer.answer === undefined) rows.push([[`${spin(tick)} `, { fg: mine }], [`${who} is reading it…`, DIM]]);
		else wrap(steer.answer, Math.max(10, room - cells(who) - 2)).slice(0, 3).forEach((part, index) => rows.push([[index === 0 ? `${who}  ` : " ".repeat(cells(who) + 2), DIM], [part, { fg: COLOR.bright }]]));
	}
	const grid = new Grid(width, rows.length + 1);
	grid.text(0, 0, "─".repeat(width), { fg: edge, level: 0.45 });
	rows.forEach((parts, index) => run(grid, 2, index + 1, parts));
	return grid;
}

function inspector(world: World, state: CanopyState, width: number, height: number, tick: number): Grid {
	const grid = new Grid(width, height);
	const item = state.selected ? world.items.get(state.selected) : undefined;
	for (let row = 0; row < height; row++) grid.text(0, row, "│", { fg: COLOR.faint });
	if (!item) {
		run(grid, 2, 1, [["Nothing is selected.", DIM]]);
		return grid;
	}
	const color = colorOf(world, item.owner);
	const inner = width - 3;
	let row = 0;
	const line = (parts: Array<[string, (Style | undefined)?]>): void => {
		if (row < height) run(grid, 2, row, parts);
		row++;
	};
	const kind = kindOf(world, item);
	line([[cut(item.name, inner - cells(kind) - 1), { fg: COLOR.bright, bold: true }]]);
	grid.text(width - 1 - cells(kind), 0, kind, DIM);
	if (item.issue) {
		const issue = item.issue;
		line([[`#${issue.number}`, { fg: COLOR.text }], [`  ${issue.state}  `, DIM], issue.assignee ? [`@${issue.assignee}`, { fg: color }] : ["unassigned", DIM]]);
		const extra = [...(issue.human ? ["for a person"] : []), ...(issue.repo ? [`◆ ${issue.repo}`] : []), ...issue.labels.map((label) => `+${label}`), ...Object.entries(issue.fields).map(([name, value]) => `${name} ${value}`)].join("  ");
		if (extra) line([[cut(extra, inner), DIM]]);
		for (const part of wrap(issue.body.split("\n").filter((text) => text.trim() !== "").slice(0, 3).join(" "), inner).slice(0, 3)) line([[part, { fg: COLOR.text }]]);
		if (item.misfit) {
			line([["▲ misplaced", { fg: COLOR.attention, bold: true }]]);
			for (const part of wrap(item.misfit, inner - 2).slice(0, 3)) line([[`  ${part}`, DIM]]);
		}
	} else line([[`@${item.owner}`, { fg: color }], [item.away ? " away: as last heard" : "", DIM], [item.repo ? `  ◆ ${item.repo}` : "", DIM]]);
	if (item.leaves > 0 && item.children.length > 0) {
		const [full, rest] = bar(item.landed, item.leaves, 14);
		line([[full, { fg: color }], [rest, { fg: COLOR.faint }], [` ${item.landed} of ${item.leaves} done`, DIM]]);
		if (item.done && item.landed < item.leaves) line([["reported done, with work still open", { fg: COLOR.attention }]]);
	}
	if (item.directions && item.directions.length > 0) {
		row++;
		line([["DIRECTIONS", DIM]]);
		for (const direction of item.directions.slice(0, 3)) {
			const parts = wrap(direction.text, inner - 2).slice(0, 2);
			parts.forEach((part, index) => line([[index === 0 ? "⚑ " : "  ", { fg: colorOf(world, direction.who) }], [part, { fg: COLOR.text }]]));
			const on = world.items.get(direction.on);
			line([[`  @${direction.who}, ${on === item || !on ? "here" : `on ${cut(on.name, Math.max(4, inner - direction.who.length - 9))}`}`, DIM]]);
		}
		if (item.directions.length > 3) line([[`  and ${item.directions.length - 3} more`, DIM]]);
	}
	if (item.issue?.result && !item.done) {
		row++;
		line([["RESULT", DIM], [`  from ${cut(item.issue.result.by, Math.max(4, inner - 14))}`, DIM]]);
		for (const part of wrap(item.issue.result.summary.split("\n")[0] ?? "", inner).slice(0, 3)) line([[part, { fg: COLOR.text }]]);
		if (item.issue.result.checks) for (const part of wrap(`checked  ${item.issue.result.checks}`, inner).slice(0, 2)) line([[part, DIM]]);
	}
	row++;
	line([["SITTING HERE", DIM]]);
	if (item.agent) {
		const runner = item.agent.owner ?? item.owner;
		line([[`${glyphOf(item, tick)} `, glyphStyle(world, item)], [item.agent.role, { fg: colorOf(world, runner), bold: true }], [`  ${item.node?.done || (item.done && !item.issue) ? "done: it sent its result" : stateWord[item.agent.state]}`, DIM]]);
		if (item.issue) line([[`  ${runner === world.me ? "yours" : `${runner}'s`}`, { fg: colorOf(world, runner) }], [item.repo ? `, in ${item.repo}` : "", DIM]]);
		if (item.node?.model) line([[`  on ${item.node.model}`, DIM]]);
		const target = item.agent.focus ? world.items.get(item.agent.focus) : undefined;
		if (target) line([["  working on ", DIM], [cut(target.name, inner - 13), { fg: COLOR.text }]]);
		if (item.agent.activity) line([[`  ${cut(item.agent.activity, inner - 2)}`, DIM]]);
		if (item.agent.open) line([["  ▸ open in a terminal", DIM]]);
	} else line([["  nobody: ", DIM], [item.issue ? (item.done ? "it is finished" : "it has not been started") : item.planned ? "it is planned" : "it never started", DIM]]);
	if (item.issue && !item.done) {
		const on = item.tender ? world.items.get(item.tender.on) : undefined;
		line([["  tended by ", DIM], item.tender ? [`${item.tender.owner === world.me ? "" : `${item.tender.owner}'s `}${item.tender.role}`, { fg: colorOf(world, item.tender.owner) }] : ["nothing yet", DIM], [item.tender ? (on && on !== item ? `, on ${cut(on.name, Math.max(4, inner - 30))}` : ", here") : "", DIM]]);
	}
	if (item.asks > 0) {
		row++;
		line([[`● ${item.asks} ${item.asks === 1 ? "thing waits" : "things wait"} for someone here`, { fg: COLOR.attention, bold: true }]]);
		line([["  open it, or answer in the pane", DIM]]);
	}
	const waits = item.waitsOn.map((id) => world.items.get(id)).filter((other): other is Item => other !== undefined);
	if (waits.length > 0) {
		row++;
		line([["WAITS ON", DIM]]);
		for (const other of waits) line([[`  ${glyphOf(other, tick)} `, glyphStyle(world, other)], [cut(other.name, inner - 6)], [other.done ? " ✓" : "", DIM]]);
	}
	const behind = world.flow.behind.get(item.id) ?? [];
	if (behind.length > 0) {
		row++;
		line([["WAITING BEHIND IT", DIM]]);
		for (const other of behind) {
			const name = cut(other.name, 16);
			const where = other.parent === item.parent ? "beside it" : other.parent && other.parent.level >= 0 ? `in ${other.parent.name}` : "";
			line([["  ⧗ ", { fg: COLOR.wait }], [pad(name, 17)], [cut(where, Math.max(1, inner - 21)), DIM]]);
		}
	}
	const under = [...inOrder(world.flow, item, state.order), ...item.buds];
	if (under.length > 0) {
		row++;
		line([[state.folded.has(item.id) ? "UNDER IT (folded)" : state.order === "dependency" && item.children.length > 1 ? "UNDER IT, FIRST TO LAST" : "UNDER IT", DIM]]);
		under.forEach((child, index) => {
			if (row >= height - 1) return;
			const branch = index === under.length - 1 ? "└" : "├";
			const name = cut(child.name, 15);
			if (child.children.length > 0) {
				const [full, rest] = bar(child.landed, child.leaves, 8);
				line([[`${branch} `, { fg: COLOR.faint }], [`${glyphOf(child, tick)} `, glyphStyle(world, child)], [pad(name, 16)], [full, { fg: colorOf(world, child.owner) }], [rest, { fg: COLOR.faint }], [` ${child.landed}/${child.leaves}`, DIM]]);
			} else {
				// Held with nobody on it: what it comes after is what there is to say about it.
				const held = world.flow.held.has(child.id) && !child.agent;
				const holder = (world.flow.before.get(child.id) ?? []).find((other) => !other.done);
				const what = child.failed ? "failed" : child.done ? "landed" : child.agent ? `${child.agent.role}, ${stateWord[child.agent.state]}` : held ? (holder ? `after ${holder.name}` : "held") : "can start";
				line([[`${branch} `, { fg: COLOR.faint }], held ? ["⧗ ", { fg: COLOR.wait }] : [`${glyphOf(child, tick)} `, glyphStyle(world, child)], [pad(name, 16), child.done || held ? DIM : undefined], [cut(what, inner - 21), DIM]]);
			}
		});
	}
	if (item.events && item.events.length > 0 && row < height - 3) {
		row++;
		line([["WHAT HAPPENED", DIM]]);
		for (const event of item.events.slice(0, 3)) {
			if (row >= height - 1) break;
			line([[event.as ?? event.who, { fg: event.as ? COLOR.text : colorOf(world, event.who) }], [` ${cut(describeChange(event), Math.max(4, inner - (event.as ?? event.who).length - 1))}`, DIM]]);
			if (event.why && row < height - 1) line([[`  ${cut(event.why, inner - 2)}`, DIM]]);
		}
	}
	return grid;
}

function roster(world: World, state: CanopyState, width: number, height: number, tick: number): Grid {
	const grid = new Grid(width, height);
	for (let row = 0; row < height; row++) grid.text(0, row, "│", { fg: COLOR.faint });
	let row = 0;
	for (const person of world.people) {
		if (row >= height) break;
		const color = colorOf(world, person.name);
		run(grid, 2, row++, [[`@${person.name}`, { fg: color, bold: true, level: person.online ? 1 : 0.55 }], [person.online ? "" : "  away", DIM], [`  ${letterOf(world, person.name)}`, DIM]]);
		const agents = [...world.items.values()].filter((item) => item.owner === person.name && item.agent && !item.done).sort((a, b) => Number(b.asks > 0 || b.agent?.state === "asking") - Number(a.asks > 0 || a.agent?.state === "asking") || a.level - b.level);
		if (agents.length === 0) run(grid, 3, row++, [["no agents", DIM]]);
		for (const item of agents) {
			if (row >= height) break;
			const selected = item.id === state.selected;
			const where = item.agent?.focus ? world.items.get(item.agent.focus) : undefined;
			const on = where ? `${cut(item.name, 10)} → ${cut(where.name, 10)}` : cut(item.name, 22);
			run(grid, 3, row++, [[`${glyphOf(item, tick)} `, glyphStyle(world, item)], [pad(cut(item.agent?.role ?? "", 12), 13), { fg: color }], [cut(on, width - 19), selected ? { fg: COLOR.bright, bg: COLOR.select } : { fg: COLOR.text }]]);
		}
		row++;
	}
	return grid;
}

/** Things that need someone and are outside the window: an arrow at the nearest edge, with how many. */
function edges(plan: Layout, state: CanopyState, win: { width: number; height: number }): Array<{ col: number; row: number; text: string }> {
	const out = new Map<string, number>();
	for (const place of plan.places.values()) {
		if (!(place.item.asks > 0 || place.item.agent?.state === "asking")) continue;
		const col = place.col - state.camera.col;
		const row = place.row - state.camera.row;
		const side = col < 0 ? "left" : col >= win.width ? "right" : row < 0 ? "up" : row >= win.height ? "down" : undefined;
		if (side) out.set(side, (out.get(side) ?? 0) + 1);
	}
	const middle = Math.floor(win.height / 2);
	const at: Record<string, { col: number; row: number; arrow: string }> = { left: { col: 0, row: middle, arrow: "◀" }, right: { col: win.width - 3, row: middle, arrow: "▶" }, up: { col: Math.floor(win.width / 2), row: 0, arrow: "▲" }, down: { col: Math.floor(win.width / 2), row: win.height - 1, arrow: "▼" } };
	return [...out].map(([side, count]) => ({ col: (at[side] as { col: number }).col, row: (at[side] as { row: number }).row, text: side === "left" ? `◀${count}` : `${count}${(at[side] as { arrow: string }).arrow}` }));
}

/** What is moving on the screen because something just happened, and when it is drawn. */
export interface Moving {
	animations: readonly Animation[];
	now: number;
	/** The keys that lead out of the canopy, when it is not an overlay that escape closes. */
	leave?: ReadonlyArray<readonly [string, string]>;
	/** Whether the keyboard is somewhere else: then only the keys that lead here are listed. */
	away?: boolean;
	/** What the selected session waits on a person for, drawn in full under the tree. */
	asking?: Asking;
	/** How bright everything is, from 0 to 1: less while something is open over the canopy. */
	dim?: number;
	/** An item was just folded or unfolded: the tree as it was drawn, where its window was, and how far it has moved to what it is now. */
	morph?: { from: Layout; camera: { col: number; row: number }; t: number };
}

/** The state with its window placed on the tree, as it is drawn. */
export const placed = (world: World, state: CanopyState, width: number, height: number): CanopyState => (state.framed || width < FLOOR.cols || height < FLOOR.rows ? state : frame(state, planOf(world, state, width, height), width, height, true));

function compose(world: World, state: CanopyState, width: number, height: number, tick: number, moving: Moving | undefined, lines: (grid: Grid, col?: number, row?: number, width?: number, height?: number) => string[]): string[] {
	if (width < FLOOR.cols || height < FLOOR.rows) {
		const grid = new Grid(width, height);
		run(grid, 1, 1, [["The canopy needs ", DIM], [`${FLOOR.cols} columns by ${FLOOR.rows} rows`, { fg: COLOR.bright }], [".", DIM]]);
		run(grid, 1, 2, [[`This terminal is ${width} by ${height}. esc goes back.`, DIM]]);
		return lines(grid);
	}
	const plan = planOf(world, state, width, height);
	const view = state.framed ? state : frame(state, plan, width, height, true);
	const win = windowOf(view, width, height);
	const side = sideWidth(view, width);
	// Between two shapes of the tree, the window moves with it: what stays is drawn where it was, sliding to where it will be.
	const morph = moving?.morph;
	const drawn = morph ? blend(morph.from, plan, morph.t) : plan;
	const camera = morph ? { col: Math.round(morph.camera.col + (view.camera.col - morph.camera.col) * ease(morph.t)), row: Math.round(morph.camera.row + (view.camera.row - morph.camera.row) * ease(morph.t)) } : view.camera;
	const tree = paint(world, drawn, { frame: tick, letters: view.letters, folded: view.folded, ...(moving ? { animations: moving.animations, now: moving.now } : {}), ...(view.selected ? { selected: view.selected } : {}), ...(moving?.away ? { away: true } : {}), ...(view.spotlight ? { spotlight: view.spotlight } : {}) });
	const blink = tick === 0 || tick % BEAT < BEAT / 2;
	for (const edge of morph ? [] : edges(plan, view, win)) tree.text(view.camera.col + edge.col, view.camera.row + edge.row, edge.text, { fg: COLOR.attention, bold: true, level: blink ? 1 : 0.45 });
	// What is asked takes the foot of the tree's window. The rows it takes are the ones the selection is not in.
	// What is being said, or a change being looked at, comes before a question: the person is in the middle of it.
	const speaking = win.height > 16 && (view.typing?.what === "say" || view.viewing || !moving?.asking) ? speakingBand(world, view, win.width, moving?.now ?? 0, tick, moving?.away === true) : undefined;
	const band = speaking ? lines(speaking) : moving?.asking && win.height > 16 ? lines(askingBand(moving.asking, win.width, moving.away === true, view.typing?.what === "answer" ? view.typing : undefined)) : [];
	const left = win.height - band.length;
	const selected = placeOf(plan, view.selected);
	const hidden = selected !== undefined && selected.row - view.camera.row + 2 >= left;
	// The list of keys has the whole width, the panel's too: it is read, and then the tree is back.
	const list = view.help !== undefined ? helpList(width, moving?.leave) : undefined;
	const canvas = list ? lines(list, 0, Math.min(view.help ?? 0, Math.max(0, list.height - win.height)), width, win.height) : [...lines(tree, camera.col, camera.row + (hidden ? band.length : 0), win.width, left), ...band];
	const panel = side > 0 && !list ? lines(view.side === "roster" ? roster(world, view, side, win.height, tick) : inspector(world, view, side, win.height, tick)) : [];
	return [...lines(header(world, view, width, tick)), ...canvas.map((line, index) => line + (panel[index] ?? "")), ...lines(footer(world, view, width, moving?.leave, moving?.away, moving?.asking, band.length > 0))];
}

/** The screen as terminal lines, exactly `height` of them and `width` cells wide. */
export const render = (world: World, state: CanopyState, width: number, height: number, tick = 0, moving?: Moving): string[] =>
	compose(world, state, width, height, tick, moving, (grid, col, row, w, h) => grid.lines(col, row, w, h, moving?.dim ?? 1));

/** Where what is selected is drawn on the screen, in cells: where something opened from it starts. */
export function anchorOf(world: World, state: CanopyState, width: number, height: number): { col: number; row: number } | undefined {
	if (width < FLOOR.cols || height < FLOOR.rows) return undefined;
	const plan = planOf(world, state, width, height);
	const view = state.framed ? state : frame(state, plan, width, height, true);
	const place = placeOf(plan, view.selected);
	if (!place) return undefined;
	const win = windowOf(view, width, height);
	return { col: Math.max(0, Math.min(win.width - 1, place.col - view.camera.col)), row: HEADER + Math.max(0, Math.min(win.height - 1, place.row - view.camera.row)) };
}

/**
 * The frame of a session opened over the canopy: a box, empty inside, whose top edge says whose
 * session it is and what it is doing, in that person's colour. Amber when it waits on someone.
 */
export function sessionFrame(world: World, id: string | undefined, width: number, height: number, leave: readonly [key: string, does: string], tick = 0): string[] {
	const grid = new Grid(width, height);
	const item = id ? (world.items.get(id) ?? [...world.items.values()].find((other) => other.node?.id === id)) : undefined;
	const asking = item !== undefined && (item.asks > 0 || item.agent?.state === "asking");
	const edge: Style = { fg: asking ? COLOR.attention : item ? colorOf(world, item.owner) : COLOR.dim, level: 0.7 };
	if (width < 4 || height < 2) return grid.lines();
	grid.text(0, 0, `╭${"─".repeat(width - 2)}╮`, edge);
	grid.text(0, height - 1, `╰${"─".repeat(width - 2)}╯`, edge);
	for (let row = 1; row < height - 1; row++) {
		grid.text(0, row, "│", edge);
		grid.text(width - 1, row, "│", edge);
	}
	const hint = [...` ${leave[0]}  ${leave[1]} `].length;
	const room = width - 8 - hint;
	if (item && room > 12) {
		const mine = item.owner === world.me;
		const state = item.failed ? "failed" : item.done ? "done" : asking ? "needs you" : item.agent ? stateWord[item.agent.state] : item.planned ? "not started" : "idle";
		const at = run(grid, 2, 0, [[" "], [glyphOf(item, tick), glyphStyle(world, item)], [" "], [cut(item.name, Math.max(6, room - 30)), { fg: COLOR.bright, bold: true }], [" "]]);
		// Whose it is comes before what it is doing: with several people in a tree that is the first thing to know.
		const rest: Array<[string, Style | undefined]> = [[" ", DIM], [`@${item.owner}`, { fg: colorOf(world, item.owner), bold: true }], [mine ? " (you)" : "", DIM], [" · ", DIM], [state, asking ? { fg: COLOR.attention, bold: true } : item.failed ? { fg: COLOR.failed } : DIM], [" ", DIM]];
		if (at + rest.reduce((sum, [text]) => sum + cells(text), 0) < width - hint - 4) run(grid, at, 0, rest);
	}
	if (width > hint + 8) run(grid, width - 2 - hint, 0, [[" "], [` ${leave[0]} `, KEYCAP], [` ${leave[1]} `, DIM]]);
	return grid.lines();
}

/** The screen as text with no colour: what a test compares. */
export const renderPlain = (world: World, state: CanopyState, width: number, height: number, tick = 0, moving?: Moving): string[] =>
	compose(world, state, width, height, tick, moving, (grid, col, row, w, h) => grid.plain(col, row, w, h).map((line) => line.padEnd(w ?? grid.width))).map((line) => line.trimEnd());
