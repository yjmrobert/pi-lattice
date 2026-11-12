# 0022 The canopy: what Pi lets an extension do

The first step of [the canopy plan](../design/canopy-plan.md). Status: found out; [0024](0024-the-canopy.md) is built on it.

The canopy is a full-screen view that redraws about twelve times a second and wants every key. Before building it, `spikes/canopy/` asked real Pi, in a pseudo-terminal, whether an extension can do that. `npm run spike:canopy` runs it again and rewrites `spikes/canopy/report.json`.

**Found**

- **The whole screen, through the documented API.** `ctx.ui.custom(…, { overlay: true })` with a width and height of 100% gave the extension all 40 of 40 rows. The pane needs Pi's layout root, which is why it has a fallback ([0013](0013-pane-inside-pi.md)); the canopy does not.
- **Every key.** Arrows, shift with arrows, tab, letters, digits and escape all reached the overlay, and none reached Pi's editor. Escape does not close an overlay by itself, so the canopy decides what it means.
- **Every frame asked for is drawn.** A timer asking for a redraw every 83 ms got 13 renders a second: that is the rate asked for, not a ceiling. Pi draws at most every 16 ms, and a canopy frame takes 1.3 ms to make at 150×40 and 1.6 ms at 240×70, so the canopy draws thirty a second while something moves.
- **An escape sequence of our own passes through.** A kitty graphics command inside a line reached the terminal, and Pi measured the line as if it were not there. So a picture can be sent by the canopy itself, without Pi's image component, which has no way to put a picture under text.
- **The glyphs are one column wide** as Pi measures them and as a terminal emulator places them: `◆◇◉○●✓✗⧗▸▲⇄✉·…│╰╮╯╭─┄━`, braille, and the block characters.

**Decision**

- **The canopy is an overlay.** It is opened with `ctx.ui.custom` and owns the screen until it is closed. It does not wrap the layout root.
- **Braille first; pixels stay possible.** Nothing found rules out the pixel renderer, and nothing proves it either: see below.
- **Colour is written in runs, not per cell.** The spike coloured each cell separately and wrote 130 kB a second for one thin moving line, because Pi rewrites every line that changed. The painter groups cells of one colour, and an animation that touches few rows is cheap where one that touches all of them is not.

**Not verified**

- **A picture under text in a real terminal.** The emulator the tests use has no graphics protocol. That the command arrives is known; that kitty, ghostty, wezterm or iTerm2 draw it under the canopy's text, and keep up at 60 frames a second, is not.
- **Glyph widths in real terminals and fonts.** One emulator agrees with Pi. `⧗` and `◉` are the ones most likely to be drawn wide by a font; the list of glyphs is kept in one place so one can be swapped.
- **tmux, and a slow link.**
