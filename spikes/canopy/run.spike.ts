// Runs the canopy spike in real Pi inside a pseudo-terminal and reports what it found.
//   npm run spike:canopy
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Terminal } from "@xterm/headless";
import { createSandbox } from "../../test/support/harness.ts";
import { PiTui } from "../../test/support/tui.ts";

const COLS = 140;
const ROWS = 40;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

it("reports what a canopy can rely on in Pi", { timeout: 120_000 }, async () => {
	const sandbox = createSandbox();
	const out = join(sandbox.root, "spike.json");
	const pi = PiTui.start(sandbox, { cols: COLS, rows: ROWS, extensions: [fileURLToPath(new URL("./canopy.ts", import.meta.url))], env: { CANOPY_SPIKE_OUT: out } });
	const raw = (): string => (pi as unknown as { raw: string }).raw;
	const report: Record<string, unknown> = {};
	try {
		await pi.see("[Extensions]");
		await pi.submit("/canopy-spike");
		const first = await pi.see("CANOPY-SPIKE");
		report.size = first[0]?.match(/\d+x\d+/)?.[0];
		report.rowsOwned = `${first.filter((row) => row.startsWith("▏")).length} of ${ROWS}`;
		report.apcReachedTerminal = raw().includes("\x1b_Ga=q");
		report.apcLineIntact = first[1]?.trimEnd() === "▏APC-OK";

		// Keys a canopy needs: arrows, shift+arrows, tab, escape, letters, digits.
		pi.press("\x1b[C", "\x1b[1;2C", "\x1b[1;2A", "\t", "x", "1", "\x1b");
		await sleep(400);
		report.keysSeen = (await pi.screen())[0]?.match(/keys \[(.*?)\]/)?.[1];
		report.stillOpenAfterEscape = (await pi.screen())[0]?.includes("CANOPY-SPIKE");

		// How much is written while one thin wave moves.
		const before = raw().length;
		await sleep(3000);
		report.bytesPerSecondWhileAnimating = Math.round((raw().length - before) / 3);

		pi.press("q");
		await pi.see("canopy spike closed");
		const after = await pi.screen();
		report.editorGotTheKeys = after.some((row) => /x1/.test(row));
		const stats = JSON.parse(readFileSync(out, "utf8")) as { frames: number; renders: number; ms: number; apcWidth: number };
		report.framesAsked = stats.frames;
		report.rendersDone = stats.renders;
		report.rendersPerSecond = Math.round((stats.renders / stats.ms) * 10000) / 10;
		report.apcWidthAsPiMeasuresIt = stats.apcWidth;
	} finally {
		await pi.stop();
		sandbox.cleanup();
	}

	// Which glyphs are one column wide, as Pi measures them and as a terminal emulator places them.
	const glyphs = [..."◆◇◉○●✓✗⧗▸▲⇄✉·…│╰╮╯╭─┄━⠹⠒⣿▏█░"];
	const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
	const widths: Record<string, string> = {};
	for (const glyph of glyphs) {
		await new Promise<void>((resolve) => terminal.write(`\r\x1b[2K${glyph}`, resolve));
		const placed = terminal.buffer.active.cursorX;
		const measured = visibleWidth(glyph);
		if (placed !== 1 || measured !== 1) widths[glyph] = `pi ${measured}, xterm ${placed}`;
	}
	report.glyphsNotOneColumn = Object.keys(widths).length ? widths : "none";
	writeFileSync(fileURLToPath(new URL("./report.json", import.meta.url)), `${JSON.stringify(report, null, 2)}\n`);
});
