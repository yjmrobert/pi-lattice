// Spike: can an extension put a persistent left pane inside Pi's own TUI, and switch
// sessions from it? Run by spikes/pane/run.sh inside a pseudo-terminal.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

const STATE = Symbol.for("pi-lattice.pane-spike");
interface PaneState {
	original: Component;
	lines: () => string[];
	focused: boolean;
}
type Hooked = TUI & { layoutRoot?: Component; setLayoutRoot?(component: Component | undefined): void; [STATE]?: PaneState };

function install(tui: Hooked, lines: () => string[]): string {
	const existing = tui[STATE];
	if (existing) {
		existing.lines = lines; // a new extension instance after a session switch: reuse the pane
		return "reused";
	}
	if (!tui.layoutRoot || !tui.setLayoutRoot) return "no layout root (regular mode)";
	const state: PaneState = { original: tui.layoutRoot, lines, focused: false };
	tui[STATE] = state;
	const pane: Component = {
		render: (width) => state.lines().map((line) => truncateToWidth(line, width)),
		invalidate() {},
	};
	const wrap = (inner: Component): Component => new HStack([{ component: pane, basis: 30, shrink: 0 }, { component: inner, basis: 0, grow: 1, minSize: 20 }]);
	const set = tui.setLayoutRoot.bind(tui);
	tui.setLayoutRoot = (component) => {
		if (component) state.original = component;
		set(component ? wrap(component) : undefined);
	};
	tui.setLayoutRoot(state.original);
	return "installed";
}

export default function (pi: ExtensionAPI) {
	let starts = 0;
	pi.on("session_start", async (event, ctx) => {
		starts++;
		if (ctx.mode !== "tui") return;
		const id = ctx.sessionManager.getSessionId().slice(0, 8);
		const lines = () => ["SESSIONS", "● checkout  yan  repo", "  ├ impl  @sam", `session ${id}`, `reason ${event.reason}`];
		ctx.ui.setWidget("lattice-pane-probe", (tui) => {
			const result = install(tui as Hooked, lines);
			ctx.ui.notify(`pane: ${result}`, "info");
			return { render: () => [], invalidate() {} };
		});
	});

	pi.registerCommand("pane-new", {
		description: "spike: replace the session",
		handler: async (_args, ctx) => {
			await ctx.newSession({ withSession: async (next) => next.ui.notify("switched by command", "info") });
		},
	});

	// A key handler has no command context; dispatching a command through the input path gets one.
	pi.registerShortcut("alt+l", {
		description: "spike: switch session from a key",
		handler: async () => {
			pi.sendUserMessage("/pane-new", { expandPromptTemplates: true });
		},
	});
}
