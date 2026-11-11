/**
 * The pane sits beside Pi by using parts of Pi's terminal interface that are not a documented
 * extension point (ADR 0013). When a Pi upgrade changes them the pane falls back to two rows
 * above the editor without any error, so nothing else would notice. These tests notice.
 */
import { type Component, HStack, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

const terminal = {
	start() {}, stop() {}, async drainInput() {}, write() {}, columns: 100, rows: 30, kittyProtocolActive: false,
	moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
};
const lines = (text: string): Component => ({ render: () => [text], invalidate() {} });

describe("the Pi internals the pane depends on", () => {
	it("lets the layout root be read and replaced, which is how the pane gets beside Pi", () => {
		const tui = new TuiAltScreen(terminal as never) as unknown as { layoutRoot?: Component; setLayoutRoot?(component: Component | undefined): void };
		expect(typeof tui.setLayoutRoot, "TUI.setLayoutRoot is gone: the pane cannot be installed").toBe("function");
		const root = lines("pi");
		tui.setLayoutRoot?.(root);
		expect(tui.layoutRoot, "TUI.layoutRoot no longer returns what setLayoutRoot was given").toBe(root);
	});

	it("lets a listener take keys before Pi does, which is how the pane has the keyboard", () => {
		const tui = new TuiAltScreen(terminal as never) as unknown as { addInputListener?: unknown };
		expect(typeof tui.addInputListener, "TUI.addInputListener is gone: the pane cannot take the keyboard").toBe("function");
	});

	it("lays columns out with a fixed basis and shows or hides them by a predicate", () => {
		let showPane = true;
		const stack = new HStack([
			{ component: lines("pane"), basis: 10, shrink: 0, visible: () => showPane },
			{ component: lines("pi"), basis: 0, grow: 1, minSize: 20 },
		]);
		const first = (): string => stripTerminalSequences(stack.render(60)[0] ?? "");
		expect(first()).toMatch(/^pane {6}pi/);
		showPane = false;
		expect(first()).toMatch(/^pi/);
	});
});
