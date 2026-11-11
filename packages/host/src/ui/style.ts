/** Minimal ANSI styling for the host's own chrome. Uses the terminal's palette, so it follows the user's theme. */
import type { NodeStatus } from "@pi-lattice/protocol";

const wrap = (open: number, close: number) => (text: string): string => `\x1b[${open}m${text}\x1b[${close}m`;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const inverse = wrap(7, 27);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const cyan = wrap(36, 39);

const BADGES: Record<NodeStatus, { glyph: string; paint: (text: string) => string }> = {
	dormant: { glyph: "○", paint: dim },
	starting: { glyph: "◌", paint: cyan },
	idle: { glyph: "●", paint: green },
	running: { glyph: "◐", paint: yellow },
	blocked: { glyph: "!", paint: red },
	exited: { glyph: "✓", paint: dim },
	failed: { glyph: "✗", paint: red },
};

export function statusBadge(status: NodeStatus): string {
	const badge = BADGES[status];
	return badge.paint(badge.glyph);
}
