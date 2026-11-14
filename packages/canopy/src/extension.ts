/**
 * The canopy inside Pi: an overlay that owns the whole screen until it is closed (ADR 0022), or a
 * view the pane puts in its layout, where the canopy is what Pi opens on (ADR 0031).
 * It draws what the pane's hosts report, asked for over the event bus, and hands anything that
 * changes a session back to `/lattice`. It imports no other lattice extension.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { emitEvent, type LatticeEvents, onEvent, SETTINGS } from "@pi-lattice/protocol";
import { type Animation, advance, happenings, type Motion } from "./animate.ts";
import type { Shape } from "./layout.ts";
import { buildWorld, type World } from "./model.ts";
import { BEAT } from "./paint.ts";
import { type CanopyKey, type CanopyState, initial, interpret, render } from "./screen.ts";

/**
 * How often the canopy is drawn while something moves. A frame costs about a millisecond to make,
 * and Pi draws at most every 16 ms, so this is a choice, not a limit: thirty a second is smooth
 * for a dot running along a branch and writes half of what sixty would.
 */
const FPS = 30;
const FRAME_MS = Math.round(1000 / FPS);
/** How often the world is asked for again while nothing moves. */
const LOOK_EVERY = 10;
const SAY_MS = 4000;
const NAMED = ["up", "down", "left", "right", "shift+up", "shift+down", "shift+left", "shift+right", "home", "tab", "enter", "escape", "backspace"] as const;
const DEFAULT_LEVELS = (SETTINGS.find((setting) => setting.key === "canopy.levels")?.default as string[] | undefined) ?? ["epic", "feature", "story", "task"];

function keyOf(data: string): CanopyKey | undefined {
	const named = NAMED.find((key) => matchesKey(data, key));
	if (named) return named;
	if (matchesKey(data, "alt+l")) return "escape";
	return data.length === 1 && data >= " " ? data : undefined;
}

export default function (pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	let closeOpen: (() => void) | undefined;

	const settings = (): Record<string, unknown> => {
		const request: LatticeEvents["lattice:settings:query"] = {};
		emitEvent(pi.events, "lattice:settings:query", request);
		return request.values ?? {};
	};
	const levels = (): string[] => {
		const value = settings()["canopy.levels"];
		return Array.isArray(value) && value.length > 0 ? (value as string[]) : DEFAULT_LEVELS;
	};
	const look = (): { world: World; current: string | undefined } => {
		const request: LatticeEvents["lattice:trees:query"] = {};
		emitEvent(pi.events, "lattice:trees:query", request);
		return { world: buildWorld(request.trees ?? [], levels()), current: request.current };
	};

	/** Where the canopy is shown: an overlay that closes, or a place in someone's layout that it never leaves. */
	interface Place {
		/** The rows it has. */
		height(): number;
		/** Escape, with nothing of the canopy's own for it to do. */
		back(): void;
		open(id: string): void;
		/** Keys the place adds, and what leads out of it. */
		keys?(): Array<{ key: string; does: string; run?: () => void }>;
		/** Whether the keyboard is somewhere else. */
		away?(): boolean;
		memory?: { state?: unknown };
	}

	function screen(tui: TUI, on: string | undefined, place: Place): { render(width: number): string[]; key(data: string): void; dispose(): void } {
		let { world, current } = look();
		const chosen = settings();
		const motion: Motion = chosen["canopy.motion"] === "off" || process.env.NO_COLOR ? "off" : chosen["canopy.motion"] === "calm" ? "calm" : "full";
		const kept = place.memory?.state as CanopyState | undefined;
		let state: CanopyState = kept && !on ? { ...kept, framed: false } : initial(world, on ?? current, (chosen["canopy.shape"] === "ruled" ? "ruled" : "grown") satisfies Shape, chosen["canopy.order"] === "filed" ? "filed" : "dependency");
		// Opening plays nothing: only what changes while the canopy is open moves.
		let moving: Animation[] = [];
		let frames = 0;
		let width = tui.terminal.columns;
		const opened = Date.now();
		/** Beats since the canopy opened; never zero, which draws a still. */
		const beat = (): number => Math.max(0.001, ((Date.now() - opened) / 1000) * BEAT);
		let said: { text: string; until: number } | undefined;
		/** What was drawn last. Once this session has ended there is nobody to ask, and it is drawn again as it was. */
		let drawn: string[] = [];
		const timer = setInterval(() => {
			if (!context) return;
			frames++;
			const busy = motion !== "off" && (moving.length > 0 || [...world.items.values()].some((item) => item.agent?.state === "working" || item.asks > 0 || item.agent?.state === "asking"));
			if (said && Date.now() > said.until) said = undefined;
			if (busy || frames % LOOK_EVERY === 0) tui.requestRender();
		}, FRAME_MS);
		timer.unref?.();
		const dispose = (): void => clearInterval(timer);
		return {
			render(columns) {
				// A session being replaced leaves this view on the screen for a moment, with a `pi` that may no longer be used.
				if (!context) return drawn;
				// The room changed, because the chat slid in or out or the terminal was resized: place the window again.
				if (columns !== width) state = { ...state, framed: false };
				width = columns;
				const before = world;
				({ world, current } = look());
				const now = Date.now();
				moving = advance(moving, motion === "full" ? happenings(before, world) : [], world, now);
				// What was selected may be gone: archived, or handed to someone whose tree is not shown.
				// Nothing may be selected yet either: the canopy was put in the layout before there was a tree.
				if (!state.selected || !world.items.has(state.selected)) {
					const selected = current && world.items.has(current) ? current : world.root.children[0]?.id;
					if (selected !== state.selected) state = { ...state, selected, framed: false };
				}
				const leave = place.keys?.().map((entry) => [entry.key, entry.does] as const);
				const lines = render(world, state, width, place.height(), motion === "off" ? 0 : beat(), { animations: moving, now, ...(leave ? { leave } : {}), ...(place.away?.() ? { away: true } : {}) });
				if (said && lines.length > 0) {
					const text = said.text.slice(0, Math.max(0, width - 2));
					lines[lines.length - 1] = ` \x1b[38;2;243;246;251m${text}\x1b[0m${" ".repeat(Math.max(0, width - 1 - text.length))}`;
				}
				drawn = lines;
				return lines;
			},
			key(data) {
				const key = keyOf(data);
				if (!key || !context) return;
				// A key the place added, unless a line is being typed: then every key is for the line.
				const added = state.typing ? undefined : place.keys?.().find((entry) => entry.key === key && entry.run);
				if (added?.run) {
					added.run();
					tui.requestRender();
					return;
				}
				const next = interpret(world, state, key, width, place.height());
				state = next.state;
				if (place.memory) place.memory.state = state;
				for (const action of next.actions) {
					if (action.do === "close") return place.back();
					if (action.do === "say") said = { text: action.text, until: Date.now() + SAY_MS };
					if (action.do === "open") return place.open(action.id);
					if (action.do === "run") {
						said = { text: action.saying, until: Date.now() + SAY_MS };
						run(action.command);
					}
					if (action.do === "on") {
						said = { text: `Putting this session on #${action.number}…`, until: Date.now() + SAY_MS };
						run(`/lattice on ${action.number}`);
					}
					if (action.do === "start") {
						said = { text: "Putting a session on it…", until: Date.now() + SAY_MS };
						run(`/lattice start ${action.id}`);
					}
				}
				tui.requestRender();
			},
			dispose,
		};
	}

	/** Hand a command to `/lattice`, through the input path, which runs it even while the agent is working. */
	const run = (command: string): void => {
		const ctx = context;
		if (!ctx) return;
		try {
			pi.sendUserMessage(command, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "steer" });
		} catch {
			// The session ended between the key press and now.
		}
	};

	const open = async (ctx: ExtensionContext, on: string | undefined): Promise<void> => {
		if (closeOpen) return;
		const then = await ctx.ui.custom<string | undefined>(
			(tui, _theme, _keys, done): Component & { dispose(): void } => {
				const close = (result?: string): void => {
					view.dispose();
					closeOpen = undefined;
					done(result);
				};
				// Opening a session switches this terminal to it: the canopy steps aside first.
				const view = screen(tui, on, { height: () => tui.terminal.rows, back: () => close(), open: (id) => close(`/lattice open ${id}`) });
				closeOpen = () => close();
				return {
					render: (width) => view.render(width),
					handleInput: (data) => view.key(data),
					invalidate() {},
					dispose() {
						view.dispose();
						closeOpen = undefined;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
			},
		);
		if (then && context === ctx) run(then);
	};

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
	});
	pi.on("session_shutdown", async () => {
		// The event bus outlives a session: from here on this instance does nothing.
		closeOpen?.();
		context = undefined;
	});

	// Where the canopy is what Pi opens on, the pane gives it a place in its layout and the keys.
	onEvent(pi.events, "lattice:canopy:mount", (request) => {
		if (!context || context.mode !== "tui" || request.view) return;
		const view = screen(request.tui as TUI, undefined, { height: () => (request.tui as TUI).terminal.rows, back: request.back, open: request.open, keys: request.keys, away: request.away, memory: request.memory });
		request.view = { render: (width) => view.render(width), key: (data) => view.key(data), dispose: () => view.dispose() };
	});

	onEvent(pi.events, "lattice:canopy:open", (request) => {
		const ctx = context;
		if (!ctx || ctx.mode !== "tui" || request.claimed) return;
		request.claimed = true;
		void open(ctx, request.nodeId);
	});
}
