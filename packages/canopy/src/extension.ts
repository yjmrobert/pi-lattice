/**
 * The canopy inside Pi: an overlay that owns the whole screen until it is closed (ADR 0022).
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

	function screen(tui: TUI, on: string | undefined, done: (result: string | undefined) => void): Component & { dispose(): void } {
		let { world, current } = look();
		const chosen = settings();
		const motion: Motion = chosen["canopy.motion"] === "off" || process.env.NO_COLOR ? "off" : chosen["canopy.motion"] === "calm" ? "calm" : "full";
		let state: CanopyState = initial(world, on ?? current, (chosen["canopy.shape"] === "ruled" ? "ruled" : "grown") satisfies Shape);
		// Opening plays nothing: only what changes while the canopy is open moves.
		let moving: Animation[] = [];
		let frames = 0;
		const opened = Date.now();
		/** Beats since the canopy opened; never zero, which draws a still. */
		const beat = (): number => Math.max(0.001, ((Date.now() - opened) / 1000) * BEAT);
		let said: { text: string; until: number } | undefined;
		const size = (): [number, number] => [tui.terminal.columns, tui.terminal.rows];
		const timer = setInterval(() => {
			frames++;
			const busy = motion !== "off" && (moving.length > 0 || [...world.items.values()].some((item) => item.agent?.state === "working" || item.asks > 0 || item.agent?.state === "asking"));
			if (said && Date.now() > said.until) said = undefined;
			if (busy || frames % LOOK_EVERY === 0) tui.requestRender();
		}, FRAME_MS);
		const close = (result?: string): void => {
			clearInterval(timer);
			closeOpen = undefined;
			done(result);
		};
		closeOpen = () => close();
		return {
			render(width) {
				const before = world;
				({ world, current } = look());
				const now = Date.now();
				moving = advance(moving, motion === "full" ? happenings(before, world) : [], world, now);
				// What was selected may be gone: archived, or handed to someone whose tree is not shown.
				if (state.selected && !world.items.has(state.selected)) state = { ...state, selected: world.root.children[0]?.id, framed: false };
				const lines = render(world, state, width, tui.terminal.rows, motion === "off" ? 0 : beat(), { animations: moving, now });
				if (said && lines.length > 0) {
					const text = said.text.slice(0, Math.max(0, width - 2));
					lines[lines.length - 1] = ` \x1b[38;2;243;246;251m${text}\x1b[0m${" ".repeat(Math.max(0, width - 1 - text.length))}`;
				}
				return lines;
			},
			handleInput(data) {
				const key = keyOf(data);
				if (!key) return;
				const [width, height] = size();
				const next = interpret(world, state, key, width, height);
				state = next.state;
				for (const action of next.actions) {
					if (action.do === "close") return close();
					if (action.do === "say") said = { text: action.text, until: Date.now() + SAY_MS };
					// Opening a session switches this terminal to it: the canopy steps aside first.
					if (action.do === "open") return close(`/lattice open ${action.id}`);
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
			invalidate() {},
			dispose() {
				clearInterval(timer);
				closeOpen = undefined;
			},
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
		const then = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => screen(tui, on, done), {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
		});
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

	onEvent(pi.events, "lattice:canopy:open", (request) => {
		const ctx = context;
		if (!ctx || ctx.mode !== "tui" || request.claimed) return;
		request.claimed = true;
		void open(ctx, request.nodeId);
	});
}
