/**
 * The canopy's screen: a line of people, the path to what is selected, a window on the tree
 * with a panel beside it, and the keys. The tree is as big as it needs to be and the window
 * moves over it. Everything here is a function of the world, the state and the size: no Pi.
 */
import type { IssueEvent, Steer } from "@pi-lattice/protocol";
import type { Animation } from "./animate.ts";
import { Grid, type Style } from "./grid.ts";
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
	/** A line being typed at the foot: what to say about the selected item to whatever tends it, or what to say instead of answering. */
	typing?: { what: "say"; label: string; text: string; number?: number; nodeId?: string } | { what: "answer"; label: string; text: string; id: string; key: string };
	/** The changes by agents this person has been taken to, since they last looked. */
	walked: ReadonlySet<string>;
	/** The change being looked at: who made it, what, and why are written at the foot. */
	viewing?: string;
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
	const place = state.selected ? plan.places.get(state.selected) : undefined;
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
		const reach = [...cut(place.item.name, plan.nameMax)].length + 6;
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

/** What nobody is on and nothing holds, among the tips, and what is held there. */
const tipsOf = (world: World): { free: Item[]; held: Item[] } => {
	const tips = [...world.items.values()].filter((item) => item.level >= 0 && item.children.length === 0 && item.parent?.children.includes(item));
	return { free: tips.filter((item) => canStart(world.flow, item)), held: tips.filter((item) => world.flow.held.has(item.id)) };
};

// --- keys ----------------------------------------------------------------------

/** Where an arrow leads from an item: across to the nearest thing beside it, up into what is under it, down to what it belongs to. */
function neighbour(world: World, plan: Layout, from: Place, key: "up" | "down" | "left" | "right"): string | undefined {
	const item = from.item;
	const places = [...plan.places.values()].filter((place) => place.item.id !== ROOT_ID && place !== from);
	if (key === "left" || key === "right") {
		const side = places.filter((place) => (key === "right" ? place.col > from.col : place.col < from.col));
		const score = (place: Place): number => Math.abs(place.col - from.col) + Math.abs(place.row - from.row) * 6 + (place.item.level === from.item.level ? 0 : 40);
		return side.sort((a, b) => score(a) - score(b))[0]?.item.id;
	}
	if (from.leaf) {
		const frond = places.filter((place) => place.leaf && place.item.parent === item.parent).concat(from).sort((a, b) => a.row - b.row);
		const at = frond.indexOf(from);
		if (key === "up") return frond[at - 1]?.item.id;
		return frond[at + 1]?.item.id ?? (item.parent && item.parent.id !== ROOT_ID ? item.parent.id : undefined);
	}
	if (key === "down") return item.parent && item.parent.id !== ROOT_ID ? item.parent.id : undefined;
	// Up: into the nearest thing under it.
	const under = item.children.map((child) => plan.places.get(child.id)).filter((place): place is Place => place !== undefined);
	return under.sort((a, b) => Math.abs(a.col - from.col) - Math.abs(b.col - from.col) || b.row - a.row)[0]?.item.id;
}

const ARROWS: Record<string, "up" | "down" | "left" | "right"> = { up: "up", down: "down", left: "left", right: "right", k: "up", j: "down", h: "left", l: "right" };

/** What a key does. Returns the next state and what the host of the screen must do. */
export function interpret(world: World, state: CanopyState, key: CanopyKey, width: number, height: number, asking?: Asking): { state: CanopyState; actions: CanopyAction[] } {
	const plan = planOf(world, state, width, height);
	const here = state.selected ? plan.places.get(state.selected) : undefined;
	const item = here?.item;
	const go = (id: string | undefined): { state: CanopyState; actions: CanopyAction[] } => ({ state: id ? frame({ ...state, selected: id }, plan, width, height) : state, actions: [] });
	const keep = (next: CanopyState, actions: CanopyAction[] = []): { state: CanopyState; actions: CanopyAction[] } => ({ state: next, actions });
	const win = windowOf(state, width, height);
	const pan = (dc: number, dr: number): { state: CanopyState; actions: CanopyAction[] } =>
		keep({ ...state, camera: { col: plan.width <= win.width ? state.camera.col : Math.max(0, Math.min(plan.width - win.width, state.camera.col + dc)), row: plan.height <= win.height ? state.camera.row : Math.max(0, Math.min(plan.height - win.height, state.camera.row + dr)) } });

	// While a line is being typed, every key is for it.
	if (state.typing) {
		const { typing, ...rest } = state;
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
	if (arrow) return go(here ? neighbour(world, plan, here, arrow) : world.root.children[0]?.id);
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
	if (key === "o") {
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
		if (line && line.length + 1 + word.length > width) {
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
		at += [...text].length;
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
	const long = flow.reduce((sum, [text]) => sum + [...text].length, 0);
	if (at + 3 + long <= width - 1) run(grid, width - 1 - long, 1, flow);
	return grid;
}

function footer(world: World, state: CanopyState, width: number, leave?: ReadonlyArray<readonly [string, string]>, away = false, asking?: Asking, banded = false): Grid {
	const grid = new Grid(width, FOOTER);
	const item = state.selected ? world.items.get(state.selected) : undefined;
	if (state.typing && banded) {
		// The line itself is in the band, under the question: here are only its keys.
		run(grid, 1, 0, [[" ⏎ ", KEYCAP], [" send   ", DIM], [" esc ", KEYCAP], [" cancel", DIM]]);
		return grid;
	}
	if (state.typing) {
		const room = Math.max(8, width - [...state.typing.label].length - 30);
		const shown = [...state.typing.text].slice(-room).join("");
		run(grid, 1, 0, [[` ${state.typing.label}: `, { fg: COLOR.bright, bold: true }], [`${shown}▏`, { fg: COLOR.text }], ["   ", DIM], [" ⏎ ", KEYCAP], [" send   ", DIM], [" esc ", KEYCAP], [" cancel", DIM]]);
		return grid;
	}
	const named = (leave ?? []).map(([key, does]): [string, string] => [key, does]);
	const keys: Array<[string, string]> = [];
	if (away) {
		// The keys are not the canopy's while the keyboard is elsewhere: only what leads here is said.
		keys.push(...named);
	} else {
		// In a layout, the keys that lead to the chat are said first: they are what a person arriving
		// needs, and the canopy may be narrow there. As an overlay, escape goes back and is said last.
		keys.push(...named, ["←↑↓→", "move"], ["space", "say what you want"]);
		if (world.changes.length > 0) keys.push(["u", `${world.changes.length} changed by agents`]);
		keys.push(["tab", "next that needs someone"]);
		if (item?.issue) {
			if (item.node) keys.push(["⏎", "open"]);
			keys.push(["s", "put this session on it"]);
		} else if (item?.planned && item.owner === world.me) keys.push(["s", "put a session on it"]);
		else if (item && !item.planned && (item.node || !item.agent?.owner)) keys.push(["⏎", item.owner === world.me ? "open" : "read"]);
		if (item && item.children.length > 0) keys.push(["f", state.folded.has(item.id) ? "unfold" : "fold"]);
		keys.push([".", "next to start"], ["o", state.order === "dependency" ? "as filed" : "first to last"], ["1-9", "one person"], ["a", "panel"], ["shift+←→", "pan"]);
		if (!leave) keys.push(["esc", "back"]);
	}
	// A key that answers what is asked means only that while it is asked: it is not listed twice.
	const taken = new Set(away ? [] : (asking?.keys ?? []).map((entry) => keyName(entry.key)));
	let at = 1;
	for (const [key, does] of keys) {
		if (taken.has(key)) continue;
		if (at + key.length + does.length + 4 > width) break;
		at = run(grid, at, 0, [[` ${key} `, KEYCAP], [` ${does}   `, DIM]]);
	}
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
		const room = Math.max(8, width - [...typing.label].length - 8);
		run(grid, 3, foot, [[`${typing.label} `, amber], ["› ", { fg: COLOR.attention, level: 0.6 }], [`${[...typing.text].slice(-room).join("")}▏`, { fg: COLOR.bright }]]);
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
		rows.push([["› ", { fg: mine, level: 0.6 }], [`${[...state.typing.text].slice(-(room - 3)).join("")}▏`, { fg: COLOR.bright }]]);
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
		else wrap(steer.answer, Math.max(10, room - who.length - 2)).slice(0, 3).forEach((part, index) => rows.push([[index === 0 ? `${who}  ` : " ".repeat(who.length + 2), DIM], [part, { fg: COLOR.bright }]]));
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
	line([[cut(item.name, inner - kind.length - 1), { fg: COLOR.bright, bold: true }]]);
	grid.text(width - 1 - kind.length, 0, kind, DIM);
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
			line([["  ⧗ ", { fg: COLOR.wait }], [name.padEnd(17)], [cut(where, Math.max(1, inner - 21)), DIM]]);
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
				line([[`${branch} `, { fg: COLOR.faint }], [`${glyphOf(child, tick)} `, glyphStyle(world, child)], [name.padEnd(16)], [full, { fg: colorOf(world, child.owner) }], [rest, { fg: COLOR.faint }], [` ${child.landed}/${child.leaves}`, DIM]]);
			} else {
				// Held with nobody on it: what it comes after is what there is to say about it.
				const held = world.flow.held.has(child.id) && !child.agent;
				const holder = (world.flow.before.get(child.id) ?? []).find((other) => !other.done);
				const what = child.failed ? "failed" : child.done ? "landed" : child.agent ? `${child.agent.role}, ${stateWord[child.agent.state]}` : held ? (holder ? `after ${holder.name}` : "held") : "can start";
				line([[`${branch} `, { fg: COLOR.faint }], held ? ["⧗ ", { fg: COLOR.wait }] : [`${glyphOf(child, tick)} `, glyphStyle(world, child)], [name.padEnd(16), child.done || held ? DIM : undefined], [cut(what, inner - 21), DIM]]);
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
			run(grid, 3, row++, [[`${glyphOf(item, tick)} `, glyphStyle(world, item)], [cut(item.agent?.role ?? "", 12).padEnd(13), { fg: color }], [cut(on, width - 19), selected ? { fg: COLOR.bright, bg: COLOR.select } : { fg: COLOR.text }]]);
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
	const selected = view.selected ? plan.places.get(view.selected) : undefined;
	const hidden = selected !== undefined && selected.row - view.camera.row + 2 >= left;
	const canvas = [...lines(tree, camera.col, camera.row + (hidden ? band.length : 0), win.width, left), ...band];
	const panel = side > 0 ? lines(view.side === "roster" ? roster(world, view, side, win.height, tick) : inspector(world, view, side, win.height, tick)) : [];
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
	const place = view.selected ? plan.places.get(view.selected) : undefined;
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
		if (at + rest.reduce((sum, [text]) => sum + [...text].length, 0) < width - hint - 4) run(grid, at, 0, rest);
	}
	if (width > hint + 8) run(grid, width - 2 - hint, 0, [[" "], [` ${leave[0]} `, KEYCAP], [` ${leave[1]} `, DIM]]);
	return grid.lines();
}

/** The screen as text with no colour: what a test compares. */
export const renderPlain = (world: World, state: CanopyState, width: number, height: number, tick = 0, moving?: Moving): string[] =>
	compose(world, state, width, height, tick, moving, (grid, col, row, w, h) => grid.plain(col, row, w, h).map((line) => line.padEnd(w ?? grid.width))).map((line) => line.trimEnd());
