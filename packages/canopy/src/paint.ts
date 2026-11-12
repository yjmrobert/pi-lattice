/**
 * Draw a laid-out canopy into a grid. Hue is the person; a ring is an agent; amber is "needs
 * someone". What moves here moves with the frame it is given: a working agent's ring turns,
 * and amber blinks. No Pi, no terminal.
 */
import { type Animation, centre, progress, trail } from "./animate.ts";
import { Grid, type Style } from "./grid.ts";
import { chipOf, cut, type Layout, type Place, under } from "./layout.ts";
import type { Agent, Item, World } from "./model.ts";
import { COLOR, colorOf, letterOf } from "./palette.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Frames a second the canopy is drawn at. */
export const FPS = 12;

export interface PaintOptions {
	/** The item the cursor is on. */
	selected?: string;
	/** Counts up twelve times a second. Zero draws a still. */
	frame?: number;
	/** Only this person's work keeps its colour. */
	spotlight?: string;
	/** Items drawn as one node: each says how many it holds. */
	folded?: ReadonlySet<string>;
	/** What is moving because something just happened, and the time it is drawn at. */
	animations?: readonly Animation[];
	now?: number;
	/** Put each owner's letter beside their items, for reading without colour. */
	letters?: boolean;
}

const agentGlyph = (agent: Agent, frame: number): string =>
	agent.state === "working" ? (SPINNER[frame % SPINNER.length] as string) : agent.state === "asking" ? "●" : agent.state === "waiting" ? "⧗" : agent.state === "failed" ? "✗" : "·";

/** Whether anything is being worked on at an item or under it. */
const alive = (item: Item): boolean => item.agent?.state === "working" || item.children.some(alive) || item.buds.some(alive);

export function paint(world: World, plan: Layout, options: PaintOptions = {}): Grid {
	const grid = new Grid(plan.width, plan.height);
	const frame = options.frame ?? 0;
	const blink = frame % FPS < FPS / 2;
	const lit = (item: Item): boolean => !options.spotlight || item.owner === options.spotlight;
	const hue = (item: Item): string => (lit(item) ? colorOf(world, item.owner) : COLOR.faint);
	const strength = (item: Item, level: number): number => (lit(item) ? (item.away ? level * 0.55 : level) : Math.min(level, 0.5));
	const grey = (item: Item, color: string): string => (lit(item) ? color : COLOR.faint);

	const now = options.now ?? 0;
	const animations = options.animations ?? [];
	// An item that was just planned grows out of its parent; one that just changed hands takes its new colour from the node outward.
	const growing = new Map<string, number>();
	const sweeping = new Map<string, { t: number; from: string }>();
	for (const animation of animations) {
		const happening = animation.happening;
		if (happening.kind === "planted") growing.set(happening.id, progress(animation, now));
		if (happening.kind === "handed") sweeping.set(happening.id, { t: progress(animation, now), from: happening.from });
	}

	// Branches: bright once everything on them has landed, dotted while only planned.
	for (const branch of plan.branches) {
		const item = branch.to;
		const landed = item.leaves > 0 && item.landed === item.leaves;
		const planned = !landed && item.landed === 0 && !alive(item) && (item.planned || item.children.length > 0) && !item.agent;
		const style: Style = { fg: item.failed ? COLOR.failed : hue(item), level: strength(item, landed ? 1 : planned ? 0.5 : 0.62) };
		const weight = landed ? 2 : planned ? 0 : 1;
		const thick = branch.kind === "branch" && item.level === 0;
		const grown = branch.kind === "stem" ? 1 : (growing.get(item.id) ?? 1);
		const sweep = branch.kind === "stem" ? undefined : sweeping.get(item.id);
		const old: Style | undefined = sweep ? { fg: lit(item) ? colorOf(world, sweep.from) : COLOR.faint, level: style.level ?? 1 } : undefined;
		const count = branch.points.length;
		branch.points.forEach(([x, y], index) => {
			if (index > grown * count) return;
			if (planned && branch.kind !== "twig" && index % 7 > 1) return;
			// The new colour spreads from the item back toward its parent.
			const paintAs = old && index < (1 - (sweep?.t ?? 1)) * count ? old : style;
			grid.plot(x, y, paintAs, weight);
			if (thick) grid.plot(x + 1, y, paintAs, weight);
		});
	}

	// What waits on what: a dashed arc between the two, in no person's colour.
	for (const place of plan.places.values()) {
		for (const id of place.item.waitsOn) {
			const other = plan.places.get(id);
			if (!other || other.item.done) continue;
			const [ax, ay, bx, by] = [place.col * 2 + 1, place.row * 4 - 1, other.col * 2 + 1, other.row * 4 - 1];
			const reach = Math.hypot(bx - ax, by - ay);
			const lift = Math.min(18, reach * 0.2 + 4);
			const steps = Math.ceil(reach * 2.4);
			for (let i = 0; i <= steps; i++) {
				const t = i / steps;
				if (((i - frame) % 8 + 8) % 8 < 4) grid.plot(ax + (bx - ax) * t, ay + (by - ay) * t - 4 * lift * t * (1 - t), { fg: other.item.failed ? COLOR.failed : COLOR.wait, level: 0.9 }, 3);
			}
		}
	}

	// An agent working on something that is not its own seat is tied to it.
	for (const place of plan.places.values()) {
		const agent = place.item.agent;
		const target = agent?.focus ? plan.places.get(agent.focus) : undefined;
		if (!agent || !target || target === place) continue;
		const [ax, ay, bx, by] = [place.col * 2 - 2, place.row * 4 + 1, target.col * 2 - 2, target.row * 4 + 1];
		const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
		const bow = Math.min(10, steps * 0.06);
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			if (i % 4 < 2) grid.plot(ax + (bx - ax) * t - 4 * bow * t * (1 - t), ay + (by - ay) * t, { fg: hue(place.item), level: strength(place.item, 0.95) }, 4);
		}
		// Its mark at the far end: a small ring beside the item it is on.
		for (let a = 0; a < 6.28; a += 0.8) grid.plot(bx + Math.cos(a) * 1.6, by + Math.sin(a) * 1.6, { fg: hue(place.item), level: strength(place.item, 1) }, 5);
	}

	// What just happened.
	for (const animation of animations) {
		const happening = animation.happening;
		const t = progress(animation, now);
		if (happening.kind === "message" || happening.kind === "landed") {
			const from = world.items.get(happening.kind === "message" ? happening.from : happening.id);
			let to = happening.kind === "message" ? world.items.get(happening.to) : from?.parent;
			// A landing carries on down through every item it completes.
			if (happening.kind === "landed") while (to?.parent && to.level >= 0 && to.leaves > 0 && to.landed === to.leaves) to = to.parent;
			if (!from || !to) continue;
			const dots = trail(plan, from, to);
			const head = Math.round(t * (dots.length + 14));
			const tail = happening.kind === "landed" ? 22 : 12;
			const color = lit(from) ? colorOf(world, from.owner) : COLOR.faint;
			for (let i = Math.max(0, head - tail); i <= Math.min(dots.length - 1, head); i++) {
				const [x, y] = dots[i] as [number, number];
				// A bright head and a tail in the sender's colour.
				grid.plot(x, y, head - i < 4 ? { fg: lit(from) ? COLOR.bright : COLOR.dim } : { fg: color, level: 1 }, 20);
			}
			continue;
		}
		const place = plan.places.get(happening.id);
		if (!place || place.item.level < 0) continue;
		const [cx, cy] = centre(place);
		if (happening.kind === "asked" || happening.kind === "seated") {
			// A question spreads outward once, in amber; a session arrives inward, in its owner's colour.
			const radius = happening.kind === "asked" ? 2 + t * 9 : 9 - t * 5.7;
			const style: Style = happening.kind === "asked" ? { fg: grey(place.item, COLOR.attention), level: 1 - t * 0.6 } : { fg: hue(place.item), level: 0.5 + t * 0.5 };
			for (let a = 0; a < 6.28; a += 0.22) grid.plot(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius * 0.95, style, 15);
		}
	}

	// The root.
	const [rx, ry] = plan.root;
	const pulse = 5.2 + (frame === 0 ? 0 : Math.sin(frame / 4) * 0.8);
	for (let y = -8; y <= 8; y++) {
		for (let x = -8; x <= 8; x++) {
			const far = Math.hypot(x, y);
			if (far <= pulse) grid.plot(rx + x, ry + y, { fg: COLOR.root }, 9);
			else if (far <= pulse + 2.5 && (x + y) % 2 === 0) grid.plot(rx + x, ry + y, { fg: COLOR.root, level: 0.5 }, 8);
		}
	}
	const rootPlace = plan.places.get(world.root.id) as Place;
	const people = world.people.length;
	const rootLabel = `${world.root.name}${people > 1 ? ` · ${people} people` : ""}`;
	grid.text(rootPlace.col - Math.floor(rootLabel.length / 2), rootPlace.row + 2, world.root.name, { fg: COLOR.root, bold: true });
	grid.text(rootPlace.col - Math.floor(rootLabel.length / 2) + world.root.name.length, rootPlace.row + 2, rootLabel.slice(world.root.name.length), { fg: COLOR.dim });

	for (const place of plan.places.values()) {
		const item = place.item;
		if (item.level < 0) continue;
		const { col, row } = place;
		const color = hue(item);
		const selected = item.id === options.selected;
		const landed = item.leaves > 0 && item.landed === item.leaves;
		const asking = item.asks > 0 || item.agent?.state === "asking";
		const amber: Style = { fg: grey(item, COLOR.attention), level: blink || frame === 0 ? 1 : 0.45, bold: true };
		const name = cut(item.name);
		const nameStyle: Style = { fg: place.leaf && (item.done || item.planned) ? grey(item, COLOR.dim) : grey(item, place.leaf ? COLOR.text : COLOR.bright), bold: !place.leaf, ...(selected ? { bg: COLOR.select, fg: COLOR.bright } : {}) };

		if (place.leaf) {
			const glyph = item.failed ? "✗" : item.done ? "✓" : item.agent ? agentGlyph(item.agent, frame) : "○";
			grid.text(col, row, glyph, item.failed ? { fg: COLOR.failed } : asking ? amber : { fg: item.planned ? grey(item, COLOR.dim) : color, level: strength(item, 1) });
			grid.text(col + 2, row, name, nameStyle);
			let at = col + 3 + [...name].length;
			if (item.asks > 0) {
				grid.text(at, row, `●${item.asks}`, amber);
				at += 2 + String(item.asks).length;
			}
			if (item.parent && item.parent.owner !== item.owner) grid.text(at, row, `@${item.owner}`, { fg: color, level: strength(item, 1) });
			else if (options.letters) grid.text(at, row, letterOf(world, item.owner), { fg: color });
			continue;
		}

		// A ring round the node says an agent sits there. It turns while the agent works.
		if (item.agent && !landed) {
			const turn = item.agent.state === "working" ? frame * 0.5 : 0;
			const ring: Style = asking ? amber : { fg: item.agent.state === "failed" ? COLOR.failed : color, level: strength(item, item.agent.state === "idle" ? 0.6 : 1) };
			for (let a = 0; a < 6.28; a += 0.3) {
				const gap = item.agent.state === "working" && frame > 0 && ((a - turn) % 6.28 + 6.28) % 6.28 < 1.5;
				if (!gap) grid.plot(col * 2 + 1 + Math.cos(a) * 3.3, row * 4 + 1.5 + Math.sin(a) * 3.3, ring, 6);
			}
		}
		grid.text(col, row, item.failed ? "✗" : landed ? "✓" : item.agent ? "◉" : "○", { fg: item.failed ? COLOR.failed : item.agent || landed ? color : grey(item, COLOR.dim), level: strength(item, 1) });
		grid.text(col + 2, row, name, nameStyle);
		let at = col + 3 + [...name].length;
		if (item.asks > 0) {
			grid.text(at, row, `●${item.asks}`, amber);
			at += 2 + String(item.asks).length;
		}
		if (options.folded?.has(item.id)) grid.text(at, row, `+${under(item)}`, { fg: grey(item, COLOR.dim) });

		// Under the name: who sits here, how far along it is, and whose it is.
		const chip = chipOf(item);
		at = col + 2;
		const sep = (): void => {
			if (at > col + 2) {
				grid.text(at, row + 1, " · ", { fg: grey(item, COLOR.dim) });
				at += 3;
			}
		};
		if (item.agent) {
			grid.text(at, row + 1, agentGlyph(item.agent, frame), item.agent.state === "asking" ? amber : { fg: item.agent.state === "failed" ? COLOR.failed : color, level: strength(item, 1) });
			grid.text(at + 2, row + 1, chip.agent, { fg: color, level: strength(item, 1) });
			at += 2 + chip.agent.length;
		} else if (chip.agent) {
			grid.text(at, row + 1, chip.agent, { fg: grey(item, COLOR.dim) });
			at += chip.agent.length;
		}
		if (chip.progress) {
			sep();
			// Reported done with tips still open: both are shown.
			grid.text(at, row + 1, chip.progress, { fg: grey(item, item.done && !landed ? COLOR.attention : COLOR.dim) });
			at += chip.progress.length;
		}
		if (chip.owner) {
			sep();
			grid.text(at, row + 1, chip.owner, { fg: color, level: strength(item, 1) });
			at += chip.owner.length;
		} else if (options.letters) {
			sep();
			grid.text(at, row + 1, letterOf(world, item.owner), { fg: color });
		}
		// Helpers: a review, a verification. Two are shown, the rest counted.
		item.buds.slice(0, 2).forEach((bud, index) => {
			const more = index === 1 && item.buds.length > 2 ? ` +${item.buds.length - 2}` : "";
			grid.text(col + 2, row + 2 + index, "╰", { fg: grey(bud, COLOR.faint) });
			grid.text(col + 4, row + 2 + index, bud.failed ? "✗" : bud.done ? "✓" : bud.agent ? agentGlyph(bud.agent, frame) : "○", bud.asks > 0 || bud.agent?.state === "asking" ? amber : { fg: hue(bud), level: strength(bud, 1) });
			grid.text(col + 6, row + 2 + index, `${cut(bud.name, 16)}${more}`, { fg: bud.id === options.selected ? COLOR.bright : grey(bud, COLOR.dim), ...(bud.id === options.selected ? { bg: COLOR.select } : {}) });
		});
	}
	return grid;
}
