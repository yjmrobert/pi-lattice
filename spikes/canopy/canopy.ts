// Spike: can an extension take the whole of Pi's screen, get every key, and redraw it a dozen
// times a second? Run by spikes/canopy/run.ts inside a pseudo-terminal.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, parseKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const FRAME_MS = 83;
/** A kitty graphics query: answered by a terminal that has the protocol, ignored by one that has not. */
const APC = "\x1b_Ga=q,i=31,s=1,v=1,f=24;AAAA\x1b\\";

function braille(dots: boolean[]): string {
	// Dot order in a cell: (0,0) (0,1) (0,2) (1,0) (1,1) (1,2) (0,3) (1,3), as Unicode numbers them.
	let bits = 0;
	for (let i = 0; i < 8; i++) if (dots[i]) bits |= 1 << i;
	return String.fromCodePoint(0x2800 + bits);
}

function screen(tui: TUI, done: (result: string) => void): Component & { dispose(): void } {
	const started = Date.now();
	let frame = 0;
	let renders = 0;
	const keys: string[] = [];
	const timer = setInterval(() => {
		frame++;
		tui.requestRender();
	}, FRAME_MS);
	const finish = (): void => {
		clearInterval(timer);
		const out = process.env.CANOPY_SPIKE_OUT;
		if (out) writeFileSync(out, JSON.stringify({ frames: frame, renders, ms: Date.now() - started, keys, apcWidth: visibleWidth(`${APC}APC-OK`) }));
		done("closed");
	};
	return {
		render(width) {
			renders++;
			const rows = tui.terminal.rows;
			const lines = [`▏CANOPY-SPIKE ${width}x${rows} frame ${frame} keys [${keys.slice(-6).join(" ")}]`.padEnd(width).slice(0, width), `▏${APC}APC-OK`];
			for (let row = 2; row < rows; row++) {
				let line = "▏";
				for (let col = 1; col < width; col++) {
					// A sine wave that moves one dot a frame: only the cells it passes through change.
					const dots = Array.from({ length: 8 }, (_unused, i) => {
						const dx = col * 2 + (i >= 3 && i !== 6 ? 1 : 0);
						const dy = (row - 2) * 4 + (i === 6 || i === 7 ? 3 : i % 3);
						return Math.round((rows - 2) * 2 + Math.sin((dx + frame) / 9) * (rows - 4) * 1.5) === dy;
					});
					line += dots.some(Boolean) ? `\x1b[38;2;95;212;208m${braille(dots)}\x1b[39m` : " ";
				}
				lines.push(line);
			}
			return lines;
		},
		handleInput(data) {
			const key = parseKey(data) ?? JSON.stringify(data);
			keys.push(String(key));
			if (data === "q") finish();
			else tui.requestRender();
		},
		invalidate() {},
		dispose() {
			clearInterval(timer);
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("canopy-spike", {
		description: "spike: take the whole screen",
		handler: async (_args, ctx) => {
			const result = await ctx.ui.custom<string>((tui, _theme, _keys, done) => screen(tui, done), {
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
			});
			ctx.ui.notify(`canopy spike ${result}`, "info");
		},
	});
}
