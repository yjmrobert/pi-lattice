/**
 * The canopy's screen: a line of people, the path to what is selected, a window on the tree
 * with a panel beside it, and the keys. The tree is as big as it needs to be and the window
 * moves over it. Everything here is a function of the world, the state and the size: no Pi.
 */
import type { Animation } from "./animate.ts";
import { Grid, type Style } from "./grid.ts";
import { cut, type Layout, layout, type Place, type Shape } from "./layout.ts";
import { type Item, pathTo, ROOT_ID, walk, type World } from "./model.ts";
import { FPS, paint, SPINNER } from "./paint.ts";
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
}

export type CanopyKey = "up" | "down" | "left" | "right" | "shift+up" | "shift+down" | "shift+left" | "shift+right" | "home" | "tab" | "enter" | "escape" | (string & {});

export type CanopyAction = { do: "close" } | { do: "open"; id: string; tree: string } | { do: "start"; id: string; tree: string } | { do: "say"; text: string };

/** Narrower or shorter than this, a label and its branch cannot both be read. */
export const FLOOR = { cols: 60, rows: 20 };
const SIDE_WIDTH = 40;
const HEADER = 2;
const FOOTER = 1;

export const initial = (world: World, current?: string, shape: Shape = "grown"): CanopyState => ({
	selected: current && world.items.has(current) ? current : world.root.children[0]?.id,
	camera: { col: 0, row: 0 },
	framed: false,
	folded: new Set(),
	spotlight: undefined,
	side: "inspector",
	letters: false,
	shape,
});

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
		const reach = [...cut(place.item.name)].length + 6;
		col = axis(col, win.width, place.col - 2, place.col + reach, plan.width, 4);
		row = axis(row, win.height, place.row - 1, place.row + 2, plan.height, 2);
	} else {
		col = axis(col, win.width, 0, plan.width, plan.width, 0);
		row = axis(row, win.height, 0, plan.height, plan.height, 0);
	}
	return { ...state, camera: { col, row }, framed: true };
}

export const planOf = (world: World, state: CanopyState): Layout => layout(world, { shape: state.shape, folded: state.folded });

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
export function interpret(world: World, state: CanopyState, key: CanopyKey, width: number, height: number): { state: CanopyState; actions: CanopyAction[] } {
	const plan = planOf(world, state);
	const here = state.selected ? plan.places.get(state.selected) : undefined;
	const item = here?.item;
	const go = (id: string | undefined): { state: CanopyState; actions: CanopyAction[] } => ({ state: id ? frame({ ...state, selected: id }, plan, width, height) : state, actions: [] });
	const keep = (next: CanopyState, actions: CanopyAction[] = []): { state: CanopyState; actions: CanopyAction[] } => ({ state: next, actions });
	const win = windowOf(state, width, height);
	const pan = (dc: number, dr: number): { state: CanopyState; actions: CanopyAction[] } =>
		keep({ ...state, camera: { col: plan.width <= win.width ? state.camera.col : Math.max(0, Math.min(plan.width - win.width, state.camera.col + dc)), row: plan.height <= win.height ? state.camera.row : Math.max(0, Math.min(plan.height - win.height, state.camera.row + dr)) } });

	if (key === "escape" || key === "q") return keep(state, [{ do: "close" }]);
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
	if (key === "a") return keep(frame({ ...state, side: state.side === "inspector" ? "roster" : state.side === "roster" ? "none" : "inspector" }, plan, width, height));
	if (key === "i") return keep({ ...state, letters: !state.letters });
	if (key === "r") return keep(frame({ ...state, shape: state.shape === "grown" ? "ruled" : "grown" }, planOf(world, { ...state, shape: state.shape === "grown" ? "ruled" : "grown" }), width, height, true));
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
		return keep(frame(next, planOf(world, next), width, height));
	}
	if (key === "enter") {
		if (state.folded.has(item.id)) return interpret(world, state, "f", width, height);
		if (item.planned) return keep(state, [{ do: "say", text: `Nobody is on "${item.name}" yet. Press s to put a session on it.` }]);
		return keep(state, [{ do: "open", id: item.id, tree: item.tree }]);
	}
	if (key === "s") {
		if (!item.planned && item.waitsOn.length === 0) return keep(state, [{ do: "say", text: `"${item.name}" has already started.` }]);
		if (item.owner !== world.me) return keep(state, [{ do: "say", text: `"${item.name}" is ${item.owner}'s to start.` }]);
		return keep(state, [{ do: "start", id: item.id, tree: item.tree }]);
	}
	return keep(state);
}

// --- drawing --------------------------------------------------------------------

const DIM: Style = { fg: COLOR.dim };
const KEYCAP: Style = { fg: COLOR.bright, bg: "#272e3d" };

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
const glyphOf = (item: Item, tick: number): string => (item.failed ? "✗" : item.done ? "✓" : item.agent ? (item.agent.state === "working" ? (SPINNER[tick % SPINNER.length] as string) : item.agent.state === "asking" ? "●" : item.agent.state === "waiting" ? "⧗" : "·") : "○");
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
		if (person.working > 0) at = run(grid, at, 0, [[" "], [`${SPINNER[tick % SPINNER.length]}${person.working}`, style]]);
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
	if (item && item.level >= 0) run(grid, at, 1, [[`  ${item.parent?.buds.includes(item) ? item.kind : (world.levels[item.level] ?? item.kind)}`, DIM]]);
	return grid;
}

function footer(world: World, state: CanopyState, width: number): Grid {
	const grid = new Grid(width, FOOTER);
	const item = state.selected ? world.items.get(state.selected) : undefined;
	const keys: Array<[string, string]> = [["←↑↓→", "move"], ["tab", "next that needs someone"]];
	if (item?.planned && item.owner === world.me) keys.push(["s", "put a session on it"]);
	else if (item && !item.planned) keys.push(["⏎", item.owner === world.me ? "open" : "read"]);
	if (item && item.children.length > 0) keys.push(["f", state.folded.has(item.id) ? "unfold" : "fold"]);
	keys.push(["1-9", "one person"], ["a", "panel"], ["shift+←→", "pan"], ["esc", "back"]);
	let at = 1;
	for (const [key, does] of keys) {
		if (at + key.length + does.length + 4 > width) break;
		at = run(grid, at, 0, [[` ${key} `, KEYCAP], [` ${does}   `, DIM]]);
	}
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
	const kind = item.parent?.buds.includes(item) ? item.kind : (world.levels[item.level] ?? item.kind);
	line([[cut(item.name, inner - kind.length - 1), { fg: COLOR.bright, bold: true }]]);
	grid.text(width - 1 - kind.length, 0, kind, DIM);
	line([[`@${item.owner}`, { fg: color }], [item.away ? " away: as last heard" : "", DIM], [item.repo ? `  ◆ ${item.repo}` : "", DIM]]);
	if (item.leaves > 0 && item.children.length > 0) {
		const [full, rest] = bar(item.landed, item.leaves, 14);
		line([[full, { fg: color }], [rest, { fg: COLOR.faint }], [` ${item.landed} of ${item.leaves} done`, DIM]]);
		if (item.done && item.landed < item.leaves) line([["reported done, with work still open", { fg: COLOR.attention }]]);
	}
	row++;
	line([["SITTING HERE", DIM]]);
	if (item.agent) {
		line([[`${glyphOf(item, tick)} `, glyphStyle(world, item)], [item.agent.role, { fg: color, bold: true }], [`  ${item.done ? "done: it sent its result" : stateWord[item.agent.state]}`, DIM]]);
		if (item.node?.model) line([[`  on ${item.node.model}`, DIM]]);
		const target = item.agent.focus ? world.items.get(item.agent.focus) : undefined;
		if (target) line([["  working on ", DIM], [cut(target.name, inner - 13), { fg: COLOR.text }]]);
		if (item.agent.activity) line([[`  ${cut(item.agent.activity, inner - 2)}`, DIM]]);
		if (item.agent.open) line([["  ▸ open in a terminal", DIM]]);
	} else line([["  nobody: ", DIM], [item.planned ? "it is planned" : "it never started", DIM]]);
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
	const under = [...item.children, ...item.buds];
	if (under.length > 0) {
		row++;
		line([[state.folded.has(item.id) ? "UNDER IT (folded)" : "UNDER IT", DIM]]);
		under.forEach((child, index) => {
			if (row >= height - 1) return;
			const branch = index === under.length - 1 ? "└" : "├";
			const name = cut(child.name, 15);
			if (child.children.length > 0) {
				const [full, rest] = bar(child.landed, child.leaves, 8);
				line([[`${branch} `, { fg: COLOR.faint }], [`${glyphOf(child, tick)} `, glyphStyle(world, child)], [name.padEnd(16)], [full, { fg: colorOf(world, child.owner) }], [rest, { fg: COLOR.faint }], [` ${child.landed}/${child.leaves}`, DIM]]);
			} else {
				const what = child.failed ? "failed" : child.done ? "landed" : child.agent ? `${child.agent.role}, ${stateWord[child.agent.state]}` : "nobody yet";
				line([[`${branch} `, { fg: COLOR.faint }], [`${glyphOf(child, tick)} `, glyphStyle(world, child)], [name.padEnd(16), child.done || child.planned ? DIM : undefined], [cut(what, inner - 21), DIM]]);
			}
		});
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
}

function compose(world: World, state: CanopyState, width: number, height: number, tick: number, moving: Moving | undefined, lines: (grid: Grid, col?: number, row?: number, width?: number, height?: number) => string[]): string[] {
	if (width < FLOOR.cols || height < FLOOR.rows) {
		const grid = new Grid(width, height);
		run(grid, 1, 1, [["The canopy needs ", DIM], [`${FLOOR.cols} columns by ${FLOOR.rows} rows`, { fg: COLOR.bright }], [".", DIM]]);
		run(grid, 1, 2, [[`This terminal is ${width} by ${height}. esc goes back.`, DIM]]);
		return lines(grid);
	}
	const plan = planOf(world, state);
	const view = state.framed ? state : frame(state, plan, width, height, true);
	const win = windowOf(view, width, height);
	const side = sideWidth(view, width);
	const tree = paint(world, plan, { frame: tick, letters: view.letters, folded: view.folded, ...(moving ? { animations: moving.animations, now: moving.now } : {}), ...(view.selected ? { selected: view.selected } : {}), ...(view.spotlight ? { spotlight: view.spotlight } : {}) });
	const blink = tick === 0 || tick % FPS < FPS / 2;
	for (const edge of edges(plan, view, win)) tree.text(view.camera.col + edge.col, view.camera.row + edge.row, edge.text, { fg: COLOR.attention, bold: true, level: blink ? 1 : 0.45 });
	const canvas = lines(tree, view.camera.col, view.camera.row, win.width, win.height);
	const panel = side > 0 ? lines(view.side === "roster" ? roster(world, view, side, win.height, tick) : inspector(world, view, side, win.height, tick)) : [];
	return [...lines(header(world, view, width, tick)), ...canvas.map((line, index) => line + (panel[index] ?? "")), ...lines(footer(world, view, width))];
}

/** The screen as terminal lines, exactly `height` of them and `width` cells wide. */
export const render = (world: World, state: CanopyState, width: number, height: number, tick = 0, moving?: Moving): string[] =>
	compose(world, state, width, height, tick, moving, (grid, col, row, w, h) => grid.lines(col, row, w, h));

/** The screen as text with no colour: what a test compares. */
export const renderPlain = (world: World, state: CanopyState, width: number, height: number, tick = 0, moving?: Moving): string[] =>
	compose(world, state, width, height, tick, moving, (grid, col, row, w, h) => grid.plain(col, row, w, h).map((line) => line.padEnd(w ?? grid.width))).map((line) => line.trimEnd());
