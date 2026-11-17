/**
 * The canopy inside Pi: an overlay that owns the whole screen until it is closed (ADR 0022), or a
 * view the pane puts in its layout, where the canopy is what Pi opens on (ADR 0031).
 * It draws what the pane's hosts report, asked for over the event bus, and hands anything that
 * changes a session back to `/lattice`. It imports no other lattice extension.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { emitEvent, type LatticeEvents, onEvent, SETTINGS } from "@pi-lattice/protocol";
import { type Animation, advance, happenings, type Motion } from "./animate.ts";
import { cells, fit, styled } from "./grid.ts";
import type { Shape } from "./layout.ts";
import { buildWorld, type World } from "./model.ts";
import { type FirstKey, firstKey, renderFirst } from "./first.ts";
import { BEAT } from "./paint.ts";
import { type Appearance, COLOR, useColorDepth, usePalette } from "./palette.ts";
import type { Layout } from "./layout.ts";
import { reordered } from "./order.ts";
import { anchorOf, type Asking, type CanopyKey, type CanopyState, initial, interpret, placed, planOf, render, sessionFrame } from "./screen.ts";

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
/** How long the canopy waits for a tree after the first message before it says that none came. */
const FIRST_MS = 30_000;
/** How long a fold or an unfold takes, and how often it is drawn while it does: as often as Pi draws. */
const MORPH_MS = 420;
const MORPH_FRAME_MS = 16;
const NAMED = ["up", "down", "left", "right", "shift+up", "shift+down", "shift+left", "shift+right", "home", "tab", "enter", "escape", "backspace"] as const;
const DEFAULT_LEVELS = (SETTINGS.find((setting) => setting.key === "canopy.levels")?.default as string[] | undefined) ?? ["epic", "feature", "story", "task"];

/** A key press as the first message sees it. Anything that is not a key it acts on is text, pasted text included. */
function firstKeyOf(data: string): FirstKey | undefined {
	if (matchesKey(data, "shift+enter") || matchesKey(data, "alt+enter")) return "newline";
	if (matchesKey(data, "enter")) return "enter";
	if (matchesKey(data, "backspace")) return "backspace";
	if (matchesKey(data, "escape")) return "escape";
	// Pasted text arrives between markers; other escape sequences are keys the message has no use for.
	const text = data.replace(/\x1b\[20[01]~/g, "").replace(/\r\n?/g, "\n");
	if (text === "" || text.includes("\x1b") || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return undefined;
	return { text };
}

/** What the canopy says at its foot, in place of the keys, exactly as wide as the screen. */
function saying(text: string, width: number): string {
	const shown = fit(text, Math.max(0, width - 2));
	return ` ${styled(shown, { fg: COLOR.bright })}${" ".repeat(Math.max(0, width - 1 - cells(shown)))}`;
}

/**
 * Lines no wider than the screen, as Pi measures them. Pi stops with an error on a line that is
 * wider, and its measure of an unusual character may not be the canopy's: such a line is cut.
 */
function within(lines: string[], width: number): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: telling plain text from text that needs measuring
	return lines.map((line) => (/^[\x1b\x20-\x7e\u2800-\u28ff]*$/.test(line) || visibleWidth(line) <= width ? line : truncateToWidth(line, width, "")));
}

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
	/**
	 * Draw for the terminal as it is: the setting when it says, else what Pi's theme is, which follows
	 * the terminal's background. Asked at every draw, since either can change while the canopy is open.
	 */
	const palette = (): void => {
		// A session being replaced leaves its view on the screen for a moment, with a `pi` that may no longer be asked anything: what was in use stays.
		if (!context) return;
		try {
			const chosen = settings()["canopy.palette"];
			const appearance: Appearance = chosen === "light" || chosen === "dark" ? chosen : (context.ui.theme as { appearance?: string } | undefined)?.appearance === "light" ? "light" : "dark";
			usePalette(appearance);
			// A terminal without 24-bit colour gets the nearest of the 256 it has, as the rest of Pi does.
			useColorDepth((context.ui.theme as { getColorMode?: () => string }).getColorMode?.() === "256color" ? "256" : "truecolor");
		} catch {
			// The session ended between the check and the asking.
		}
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
		/** How bright it is drawn: less while something is open over it. */
		dim?(): number;
		/** Where there is no tree yet and a first message would start one (ADR 0035). */
		first?(): { repo: string; starting: boolean } | undefined;
		/** Run a command where its answer is shown. */
		command?(text: string): void;
		memory?: { state?: unknown };
	}

	/** What the selected item's session waits on a person for: the first thing, and how many follow. Asked of the pane, which can answer it. */
	const askingOf = (world: World, selected: string | undefined): Asking | undefined => {
		const item = selected ? world.items.get(selected) : undefined;
		if (!item || !(item.asks > 0 || item.agent?.state === "asking")) return undefined;
		const request: LatticeEvents["lattice:waiting:query"] = { nodeId: item.node?.id ?? item.id };
		emitEvent(pi.events, "lattice:waiting:query", request);
		const first = request.items?.[0];
		return first ? { ...first, more: (request.items?.length ?? 1) - 1 } : undefined;
	};

	function screen(tui: TUI, on: string | undefined, place: Place): NonNullable<LatticeEvents["lattice:canopy:mount"]["view"]> {
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
		let asking: Asking | undefined;
		/** A fold or unfold under way: the tree as it was drawn when the key was pressed. */
		let morph: { from: Layout; camera: { col: number; row: number }; start: number } | undefined;
		let again: ReturnType<typeof setTimeout> | undefined;
		/** The first message, while it is written, and once sent, until the tree it starts is drawn. */
		let draft = "";
		let sent: { text: string; at: number; started: boolean } | undefined;
		/** Whether the first message is what the canopy shows now, and what is drawn while it is. */
		const firstNow = (): { repo: string; starting: boolean } | undefined => {
			const first = place.first?.();
			if (!first) {
				sent = undefined;
				return undefined;
			}
			if (sent) {
				if (first.starting) sent.started = true;
				// A tree was being started and stopped without one, or none was ever started: the message is back to be sent again.
				else if (sent.started || Date.now() - sent.at > FIRST_MS) {
					draft = sent.text;
					sent = undefined;
					said = { text: "No tree started. alt+l shows the chat, and /lattice doctor says why.", until: Date.now() + SAY_MS * 2 };
				}
			}
			return first;
		};
		const timer = setInterval(() => {
			if (!context) return;
			frames++;
			const busy = motion !== "off" && (moving.length > 0 || world.steers.some((steer) => steer.answer === undefined) || [...world.items.values()].some((item) => item.agent?.state === "working" || item.asks > 0 || item.agent?.state === "asking"));
			if (said && Date.now() > said.until) said = undefined;
			if (busy || frames % LOOK_EVERY === 0) tui.requestRender();
		}, FRAME_MS);
		timer.unref?.();
		const dispose = (): void => {
			clearInterval(timer);
			if (again) clearTimeout(again);
		};
		return {
			render(columns) {
				// A session being replaced leaves this view on the screen for a moment, with a `pi` that may no longer be used.
				if (!context) return drawn;
				palette();
				// The room changed, because the chat slid in or out or the terminal was resized: place the window again.
				if (columns !== width) state = { ...state, framed: false };
				width = columns;
				const first = firstNow();
				if (first) {
					const lines = renderFirst({ repo: first.repo, draft, ...(sent ? { sent: sent.text } : first.starting ? { sent: "" } : {}), leave: place.keys?.().filter((entry) => !entry.run).map((entry) => [entry.key, entry.does] as const) ?? [], ...(place.away?.() ? { away: true } : {}), dim: Math.max(0, Math.min(1, place.dim?.() ?? 1)) }, width, place.height(), motion === "off" ? 0 : beat());
					if (said && lines.length > 0) lines[lines.length - 1] = saying(said.text, width);
					drawn = within(lines, width);
					return drawn;
				}
				const before = world;
				({ world, current } = look());
				const now = Date.now();
				moving = advance(moving, motion === "full" ? happenings(before, world) : [], world, now);
				// Something changed place among its siblings: the tree moves there, as it does when an item is folded.
				if (motion !== "off" && !morph && reordered(before, world, state.order)) morph = { from: planOf(before, state, width, place.height()), camera: state.camera, start: now };
				// What was selected may be gone: archived, or handed to someone whose tree is not shown.
				// Nothing may be selected yet either: the canopy was put in the layout before there was a tree.
				if (!state.selected || !world.items.has(state.selected)) {
					const selected = current && world.items.has(current) ? current : world.root.children[0]?.id;
					if (selected !== state.selected) state = { ...state, selected, framed: false };
				}
				asking = askingOf(world, state.selected);
				if (morph && now - morph.start >= MORPH_MS) morph = undefined;
				if (morph && !again) {
					again = setTimeout(() => {
						again = undefined;
						tui.requestRender();
					}, MORPH_FRAME_MS);
					again.unref?.();
				}
				const leave = place.keys?.().map((entry) => [entry.key, entry.does] as const);
				const dim = Math.max(0, Math.min(1, place.dim?.() ?? 1));
				const lines = render(world, state, width, place.height(), motion === "off" ? 0 : beat(), { animations: moving, now, ...(leave ? { leave } : {}), ...(place.away?.() ? { away: true } : {}), ...(asking ? { asking } : {}), ...(dim < 1 ? { dim } : {}), ...(morph ? { morph: { from: morph.from, camera: morph.camera, t: (now - morph.start) / MORPH_MS } } : {}) });
				if (said && lines.length > 0) lines[lines.length - 1] = saying(said.text, width);
				drawn = within(lines, width);
				return drawn;
			},
			key(data) {
				// Before there is a tree, every key is for the first message: there is nothing else to move to.
				if (context && firstNow()) {
					const key = firstKeyOf(data);
					if (!key || sent) return;
					const next = firstKey(draft, key);
					draft = next.draft;
					if (next.send !== undefined) {
						// A command is run where its answer is read: it may ask something first, and says what it did in the chat.
						// Anything else is the message that starts the tree.
						if (next.send.startsWith("/") && place.command) place.command(next.send);
						else {
							if (!next.send.startsWith("/")) sent = { text: next.send, at: Date.now(), started: false };
							send(next.send);
						}
					}
					tui.requestRender();
					return;
				}
				const key = keyOf(data);
				if (!key || !context) return;
				// A key the place added, unless a line is being typed: then every key is for the line.
				const added = state.typing ? undefined : place.keys?.().find((entry) => entry.key === key && entry.run);
				if (added?.run) {
					added.run();
					tui.requestRender();
					return;
				}
				// What is on the screen now is where a fold starts from.
				state = placed(world, state, width, place.height());
				const was = state;
				const next = interpret(world, state, key, width, place.height(), asking, place.keys?.().map((entry) => [entry.key, entry.does] as const));
				state = next.state;
				if (motion !== "off" && state.folded !== was.folded) morph = { from: planOf(world, was, width, place.height()), camera: was.camera, start: Date.now() };
				if (place.memory) place.memory.state = state;
				for (const action of next.actions) {
					if (action.do === "close") return place.back();
					if (action.do === "answer") {
						const request: LatticeEvents["lattice:waiting:answer"] = { id: action.id, key: action.key, ...(action.text !== undefined ? { text: action.text } : {}) };
						emitEvent(pi.events, "lattice:waiting:answer", request);
						if (request.done && action.text !== undefined) said = { text: "Told it instead.", until: Date.now() + SAY_MS };
						if (!request.done) said = { text: "That could not be answered from here. Open the session to answer it.", until: Date.now() + SAY_MS };
					}
					if (action.do === "say") said = { text: action.text, until: Date.now() + SAY_MS };
					if (action.do === "open") return place.open(action.id);
					if (action.do === "steer") {
						// The pane has the connection to the host; what is answered comes back in the state and is drawn at the foot.
						const request: LatticeEvents["lattice:steer"] = { text: action.text, ...(action.number !== undefined ? { number: action.number } : {}), ...(action.nodeId !== undefined ? { nodeId: action.nodeId } : {}) };
						emitEvent(pi.events, "lattice:steer", request);
						if (!request.done) said = { text: "That could not be said from here: the pane is not there to carry it.", until: Date.now() + SAY_MS };
					}
					// Handing a session over asks who to, or whether to: it is run where that is asked and answered.
					if (action.do === "hand") {
						const command = `/lattice ${action.what} ${action.id}`;
						if (place.command) return place.command(command);
						run(command);
					}
					if (action.do === "seen") emitEvent(pi.events, "lattice:seen", {} satisfies LatticeEvents["lattice:seen"]);
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
			anchor: () => anchorOf(world, state, width, place.height()),
			frame: (nodeId, columns, rows, leave) => (palette(), sessionFrame(world, nodeId, columns, rows, leave, motion === "off" ? 0 : beat())),
		};
	}

	/** Send what was written as this session's own message, as if typed into its editor. */
	const send = (text: string): void => {
		const ctx = context;
		if (!ctx) return;
		try {
			pi.sendUserMessage(text, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "steer" });
		} catch {
			// The session ended between the key press and now.
		}
	};

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
				const view = screen(tui, on, { height: () => tui.terminal.rows, back: () => close(), open: (id) => close(`/lattice open ${id}`), command: (text) => close(text) });
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
		const view = screen(request.tui as TUI, undefined, { height: () => (request.tui as TUI).terminal.rows, back: request.back, open: request.open, keys: request.keys, away: request.away, memory: request.memory, ...(request.dim ? { dim: request.dim } : {}), ...(request.first ? { first: request.first } : {}), ...(request.command ? { command: request.command } : {}) });
		request.view = view;
	});

	onEvent(pi.events, "lattice:canopy:open", (request) => {
		const ctx = context;
		if (!ctx || ctx.mode !== "tui" || request.claimed) return;
		request.claimed = true;
		void open(ctx, request.nodeId);
	});
}
