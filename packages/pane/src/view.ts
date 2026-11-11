/** The pane's content: the session hierarchy, with who owns each session and which repository it works in. Pure. */
import { type NodeMeta, type NodeStatus, treeLines, type UiState } from "@pi-lattice/protocol";

/** How text is styled. The extension supplies Pi's theme; tests supply plain text. */
export interface Paint {
	dim(text: string): string;
	bold(text: string): string;
	accent(text: string): string;
	ok(text: string): string;
	warn(text: string): string;
	error(text: string): string;
	inverse(text: string): string;
}

export const PLAIN: Paint = { dim: (t) => t, bold: (t) => t, accent: (t) => t, ok: (t) => t, warn: (t) => t, error: (t) => t, inverse: (t) => t };

export interface PaneView {
	state: UiState | undefined;
	/** The node open in this terminal. */
	current: string | undefined;
	/** The node the cursor is on. */
	selected: string | undefined;
	/** Whether the pane has the keyboard. */
	focused: boolean;
	/** Text shown when there is no tree yet. */
	hint?: string;
}

const GLYPH: Record<NodeStatus, string> = { dormant: "○", starting: "◌", idle: "●", running: "◐", blocked: "!", exited: "✓", failed: "✗" };

function glyph(status: NodeStatus, paint: Paint): string {
	const mark = GLYPH[status];
	if (status === "idle") return paint.ok(mark);
	if (status === "running" || status === "starting") return paint.warn(mark);
	if (status === "blocked" || status === "failed") return paint.error(mark);
	return paint.dim(mark);
}

/** Cut plain text to a number of columns. Styling is applied afterwards, so widths stay exact. */
function fit(text: string, width: number): string {
	const chars = [...text];
	if (chars.length <= width) return text;
	return width <= 1 ? chars.slice(0, width).join("") : `${chars.slice(0, width - 1).join("")}…`;
}

/** The order rows appear in, for moving the cursor. */
export function paneOrder(state: UiState | undefined): string[] {
	return state ? treeLines(state.nodes).map((line) => line.node.id) : [];
}

function owner(node: NodeMeta, state: UiState): string {
	return node.owner === state.owner ? "you" : `@${node.owner}`;
}

/**
 * Render the pane. Each session takes two lines: its name with status and attention marks,
 * then who owns it, its repository and its kind.
 */
export function renderPane(view: PaneView, width: number, paint: Paint = PLAIN): string[] {
	const inner = Math.max(8, width - 1);
	const lines: string[] = [];
	lines.push(view.focused ? paint.accent(paint.bold(fit(" SESSIONS", inner))) : paint.dim(fit(" SESSIONS", inner)));
	const state = view.state;
	if (!state || state.nodes.length === 0) {
		for (const line of (view.hint ?? "No sessions yet.").split("\n")) lines.push(paint.dim(fit(` ${line}`, inner)));
		return lines;
	}
	const offline = new Set((state.sharing?.people ?? []).filter((person) => !person.online && !person.self).map((person) => person.name));
	const known = new Set((state.sharing?.people ?? []).map((person) => person.name));
	for (const { node, prefix } of treeLines(state.nodes)) {
		const gone = node.owner !== state.owner && (offline.has(node.owner) || !known.has(node.owner));
		const attention = state.attention[node.id];
		const marks = [attention?.dialogs ? `?${attention.dialogs}` : "", attention?.pending ? `✉${attention.pending}` : ""].filter(Boolean).join(" ");
		const here = node.id === view.current;
		// The cursor shows only while the pane has the keyboard; otherwise the marker shows what is open here.
		const cursor = view.focused ? (node.id === view.selected ? "›" : " ") : here ? "▸" : " ";
		const indent = prefix.replace(/[├└]─ $/, (match) => match.slice(0, 1)).replace(/ {3}/g, " ").replace(/│ {2}/g, "│");
		const nameWidth = Math.max(4, inner - 2 - [...indent].length - 2 - (marks ? [...marks].length + 1 : 0));
		const name = fit(node.name, nameWidth);
		const head = `${cursor}${indent}`;
		const mark = gone ? paint.dim("○") : glyph(node.status, paint);
		const title = gone ? paint.dim(name) : here ? paint.bold(name) : name;
		let first = `${paint.dim(head)} ${mark} ${title}${marks ? ` ${paint.warn(marks)}` : ""}`;
		const detail = [owner(node, state), node.repo ?? "", node.kind, gone ? "offline" : ""].filter(Boolean).join(" · ");
		const pad = " ".repeat([...head].length + 3);
		let second = paint.dim(fit(`${pad}${detail}`, inner));
		if (node.id === view.selected && view.focused) {
			first = paint.inverse(fit(`${head} ${GLYPH[node.status]} ${name}${marks ? ` ${marks}` : ""}`, inner).padEnd(inner));
			second = paint.inverse(fit(`${pad}${detail}`, inner).padEnd(inner));
		}
		lines.push(first, second);
	}
	const notices = paneNotices(state);
	if (notices.length > 0) {
		lines.push("");
		for (const notice of notices) lines.push(paint.warn(fit(` ${notice}`, inner)));
	}
	if (view.focused) {
		lines.push("");
		for (const hint of ["↑↓ move · enter open", "n new · a approvals", "o sharing · esc back"]) lines.push(paint.dim(fit(` ${hint}`, inner)));
	}
	return lines;
}

/** Short lines about things waiting on this person. */
export function paneNotices(state: UiState): string[] {
	const out: string[] = [];
	const pending = Object.values(state.attention).reduce((sum, entry) => sum + entry.pending, 0);
	if (pending > 0) out.push(`${pending} message${pending === 1 ? "" : "s"} to approve`);
	for (const person of state.sharing?.people ?? []) {
		if (person.trust === "unknown") out.push(`${person.name} wants to pair`);
		if (person.trust === "changed") out.push(`${person.name}: key changed`);
	}
	for (const handoff of state.sharing?.handoffs ?? []) {
		if (handoff.role === "recipient" && handoff.state === "offered") out.push(`${handoff.from} offers ${handoff.nodeName}`);
		if (handoff.role === "owner" && handoff.state === "accepted") out.push(`confirm ${handoff.nodeName} → ${handoff.to}`);
	}
	for (const transfer of state.sharing?.pendingTransfers ?? []) out.push(`sending to ${transfer.to}…`);
	return out;
}

/** One line per session, for terminals where the side pane cannot be shown. */
export function renderCompact(view: PaneView, limit = 8): string[] {
	const state = view.state;
	if (!state || state.nodes.length === 0) return [];
	const rows = treeLines(state.nodes).map(({ node, prefix }) => `${node.id === view.current ? "▸" : " "} ${prefix}${GLYPH[node.status]} ${node.name}  ${owner(node, state)}${node.repo ? ` · ${node.repo}` : ""}`);
	return rows.length > limit ? [...rows.slice(0, limit - 1), `  … ${rows.length - limit + 1} more (/lattice)`] : rows;
}
