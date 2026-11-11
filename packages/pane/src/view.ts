/**
 * The pane's content: what is waiting on the person, then the sessions of each repository,
 * one line each. Pure: everything drawn comes from a {@link PaneView}. See ADR 0015.
 */
import { type DialogInfo, type Envelope, type NodeMeta, type NodeStatus, treeLines, type UiState } from "@pi-lattice/protocol";

/** How text is styled. The extension supplies Pi's theme; tests supply plain text. */
export interface Paint {
	dim(text: string): string;
	bold(text: string): string;
	/** Activity and "here": a working session, the open-here mark, the repository this terminal is in. */
	accent(text: string): string;
	ok(text: string): string;
	/** Reserved for things waiting on a person. */
	warn(text: string): string;
	error(text: string): string;
	/** The cursor: a background behind a whole row, leaving its colours as they are. */
	select(text: string): string;
}

const same = (text: string): string => text;
export const PLAIN: Paint = { dim: same, bold: same, accent: same, ok: same, warn: same, error: same, select: same };

/** Something waiting on the person. */
export interface InboxItem {
	/** Stable key; the cursor refers to it. */
	id: string;
	kind: "question" | "message" | "pair" | "offer" | "release";
	/** The session it concerns, when it concerns one. */
	nodeId?: string;
	title: string;
	/** One line of what is asked or said. */
	text: string;
	/** The question itself, when it has been fetched. */
	dialog?: DialogInfo;
	/** The message itself, when it has been fetched. */
	envelope?: Envelope;
	/** The person a pairing request is from. */
	person?: string;
}

/** What has been fetched about waiting items beyond the counts in the state. */
export interface InboxDetails {
	dialogs?: Record<string, DialogInfo[]>;
	mail?: Array<{ nodeId: string; envelope: Envelope }>;
}

/** One repository's tree, as one host reports it. */
export interface PaneRepo {
	/** Identifies the repository's host: its state directory. */
	key: string;
	name: string;
	state: UiState;
	/** Whether this terminal is in this repository. */
	here: boolean;
	inbox: InboxItem[];
}

export interface PaneView {
	repos: PaneRepo[];
	/** Repositories with a tree whose host is not running. Each is one line; opening it starts its host. */
	asleep?: Array<{ key: string; name: string }>;
	/** Whether there is a session to go back to with `-`. */
	previous?: boolean;
	/** Whether the inspector is showing beside the pane. It then lists the keys that act, and the pane keeps the ones that move. */
	inspector?: boolean;
	/** Shown in the footer in place of the keys, while something else has the keyboard (the new-session form). */
	note?: string | undefined;
	/** The time, for saying how long a session has been in its state. */
	now?: number;
	/** The node open in this terminal. */
	current: string | undefined;
	/** What the cursor is on: a key from {@link paneOrder}. */
	cursor: string | undefined;
	/** Whether the pane has the keyboard. */
	focused: boolean;
	/** Text shown when there is no tree yet. */
	hint?: string;
	/** The keys that act on what the cursor is on, shown in the footer while the pane has the keyboard. */
	keys?: ReadonlyArray<readonly [key: string, does: string]>;
	/** Which frame of the working spinner to draw. */
	frame?: number;
	/** Something that needs the same key again before it happens; see `stopKey`. */
	confirm?: string | undefined;
	/** Whether the list of every key is showing in place of the inspector. */
	help?: boolean;
	/** The last few things the session under the cursor said and did, once fetched. */
	tail?: { nodeId: string; lines: string[] } | undefined;
	/** Rows available. When given, the footer is pinned to the bottom and a long list scrolls with the cursor. */
	height?: number | undefined;
}

export const nodeKey = (id: string): string => `n:${id}`;
export const itemKey = (id: string): string => `i:${id}`;
export const repoKey = (key: string): string => `r:${key}`;

export const SPINNER = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
const ITEM_ICON: Record<InboxItem["kind"], string> = { question: "?", message: "✉", pair: "⇄", offer: "⇄", release: "⇄" };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Cut plain text to a number of columns. Styling is applied afterwards, so widths stay exact. */
export function fit(text: string, width: number): string {
	const chars = [...text];
	if (chars.length <= width) return text;
	return width <= 1 ? chars.slice(0, Math.max(0, width)).join("") : `${chars.slice(0, width - 1).join("")}…`;
}

/** Break plain text into rows of at most `width` columns, at spaces where it can. */
export function wrap(text: string, width: number): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of text.split(" ")) {
		let rest = word;
		while ([...rest].length > width) {
			if (row) rows.push(row);
			row = "";
			rows.push([...rest].slice(0, width).join(""));
			rest = [...rest].slice(width).join("");
		}
		if (row && [...row].length + 1 + [...rest].length > width) {
			rows.push(row);
			row = rest;
		} else row = row ? `${row} ${rest}` : rest;
	}
	if (row) rows.push(row);
	return rows;
}

/** A run of text with one style. Widths are counted on the plain text. */
export type Seg = readonly [text: string, style?: ((text: string) => string) | undefined];
export const widthOf = (segs: readonly Seg[]): number => segs.reduce((sum, [text]) => sum + [...text].length, 0);
export const draw = (segs: readonly Seg[]): string => segs.map(([text, style]) => (style && text !== "" ? style(text) : text)).join("");
/** Left and right parts on one row, the right one against the edge. The caller makes sure they fit. */
export function spread(left: readonly Seg[], right: readonly Seg[], width: number): Seg[] {
	return [...left, [" ".repeat(Math.max(1, width - widthOf(left) - widthOf(right)))], ...right];
}
const padTo = (segs: readonly Seg[], width: number): Seg[] => [...segs, [" ".repeat(Math.max(0, width - widthOf(segs)))]];

/**
 * The things waiting on the person in one tree. With only the state, a session's questions and
 * messages are one line each with a count; with details, every question and message is its own item.
 */
export function inboxItems(state: UiState, details: InboxDetails = {}): InboxItem[] {
	const items: InboxItem[] = [];
	const nameOf = (id: string): string => state.nodes.find((node) => node.id === id)?.name ?? id;
	for (const { node } of treeLines(state.nodes)) {
		const attention = state.attention[node.id];
		if (!attention) continue;
		if (attention.dialogs > 0) {
			const dialogs = details.dialogs?.[node.id];
			if (dialogs && dialogs.length > 0) {
				for (const dialog of dialogs) items.push({ id: `q:${node.id}:${dialog.id}`, kind: "question", nodeId: node.id, title: node.name, text: oneLine(dialog.title), dialog });
			} else items.push({ id: `q:${node.id}`, kind: "question", nodeId: node.id, title: node.name, text: attention.dialogs === 1 ? "asks a question" : `asks ${attention.dialogs} questions` });
		}
		if (attention.pending > 0) {
			const mail = details.mail?.filter((entry) => entry.nodeId === node.id);
			if (mail && mail.length > 0) {
				for (const { envelope } of mail) {
					items.push({ id: `m:${node.id}:${envelope.id}`, kind: "message", nodeId: node.id, title: `${nameOf(envelope.from)} → ${node.name}`, text: oneLine(envelope.payload.text), envelope });
				}
			} else items.push({ id: `m:${node.id}`, kind: "message", nodeId: node.id, title: node.name, text: `${plural(attention.pending, "message")} to approve` });
		}
	}
	for (const person of state.sharing?.people ?? []) {
		if (person.trust === "unknown") items.push({ id: `p:${person.name}`, kind: "pair", title: person.name, text: "wants to pair", person: person.name });
		if (person.trust === "changed") items.push({ id: `p:${person.name}`, kind: "pair", title: person.name, text: "key changed", person: person.name });
	}
	for (const handoff of state.sharing?.handoffs ?? []) {
		if (handoff.role === "recipient" && handoff.state === "offered") items.push({ id: `o:${handoff.nodeId}`, kind: "offer", nodeId: handoff.nodeId, title: handoff.from, text: `offers ${handoff.nodeName}` });
		if (handoff.role === "owner" && handoff.state === "accepted") items.push({ id: `r:${handoff.nodeId}`, kind: "release", nodeId: handoff.nodeId, title: handoff.nodeName, text: `confirm release to ${handoff.to}` });
	}
	return items;
}

/** Every waiting item across the repositories, with the repository each is from. */
export function paneInbox(view: PaneView): Array<{ item: InboxItem; repo: PaneRepo }> {
	return view.repos.flatMap((repo) => repo.inbox.map((item) => ({ item, repo })));
}

/** What the cursor can be on, in the order shown: waiting items, then every session. */
export function paneOrder(view: PaneView): string[] {
	return [
		...paneInbox(view).map(({ item }) => itemKey(item.id)),
		...view.repos.flatMap((repo) => treeLines(repo.state.nodes).map((line) => nodeKey(line.node.id))),
		...(view.asleep ?? []).map((repo) => repoKey(repo.key)),
	];
}

/** The repository a session belongs to, and the session. */
export function findNode(view: PaneView, id: string): { node: NodeMeta; repo: PaneRepo } | undefined {
	for (const repo of view.repos) {
		const node = repo.state.nodes.find((candidate) => candidate.id === id);
		if (node) return { node, repo };
	}
	return undefined;
}

interface Tally {
	working: number;
	waiting: number;
	total: number;
}

function tally(repo: PaneRepo): Tally {
	const working = repo.state.nodes.filter((node) => node.status === "running" || node.status === "starting").length;
	return { working, waiting: repo.inbox.length, total: repo.state.nodes.length };
}

/** Whether a session belongs to someone who cannot be reached right now. */
export function gone(node: NodeMeta, state: UiState): boolean {
	if (node.owner === state.owner) return false;
	const person = state.sharing?.people.find((candidate) => candidate.name === node.owner);
	return !person || (!person.online && !person.self);
}

function statusMark(node: Pick<NodeMeta, "status" | "done">, waiting: boolean, away: boolean, frame: number, paint: Paint): Seg {
	const status: NodeStatus = node.status;
	if (away) return ["○", paint.dim];
	if (waiting || status === "blocked") return ["●", paint.warn];
	if (status === "running" || status === "starting") return [SPINNER[frame % SPINNER.length] as string, paint.accent];
	if (status === "failed") return ["✗", paint.error];
	// It sent its parent the result of what it was given, and has been given nothing since.
	if (status === "exited" || node.done) return ["✓", paint.ok];
	return [status === "idle" ? "●" : "○", paint.dim];
}

/** Tree guides at two columns a level: `├─ ` becomes `├ `. */
const guides = (prefix: string): string => (prefix.match(/.{3}/gu) ?? []).map((unit) => `${[...unit][0]} `).join("");

/**
 * One session: the open-here mark in its own column, the tree, status and name, then on the right
 * what is waiting and the kind (or the owner, when it is someone else's). When there is no room
 * the kind goes first, then the name is cut; what is waiting is never dropped.
 */
function sessionRow(node: NodeMeta, prefix: string, repo: PaneRepo, view: PaneView, width: number, paint: Paint, folded = 0): Seg[] {
	const state = repo.state;
	const away = gone(node, state);
	const attention = state.attention[node.id];
	const marks = [attention?.dialogs ? `?${attention.dialogs}` : "", attention?.pending ? `✉${attention.pending}` : ""].filter(Boolean).join(" ");
	const here = node.id === view.current;
	const sending = state.sharing?.pendingTransfers.find((transfer) => transfer.nodeId === node.id);
	// A finished session with finished work under it says how much is folded away, in place of its kind.
	const tag = sending ? `→ ${sending.to}…` : folded > 0 ? `+${folded} done` : node.owner === state.owner ? node.kind : `@${node.owner}${away ? " offline" : ""}`;
	const lead: Seg[] = [[here ? "▸" : " ", paint.accent], [` ${guides(prefix)}`, paint.dim], statusMark(node, (attention?.dialogs ?? 0) > 0, away, view.frame ?? 0, paint), [" "]];
	const room = width - 1 - widthOf(lead);
	const marksWidth = marks ? [...marks].length + 1 : 0;
	const nameWidth = [...node.name].length;
	const tagWidth = (text: string): number => (text ? [...text].length + 1 : 0);
	// "@sam offline" may lose "offline" before it loses "@sam".
	const shownTag = [tag, tag.split(" ")[0] as string, ""].find((text) => nameWidth + marksWidth + tagWidth(text) <= room) ?? "";
	const name = fit(node.name, Math.max(4, room - marksWidth - tagWidth(shownTag) - (marks || shownTag ? 0 : 1)));
	const quiet = away || node.status === "dormant" || node.done === true;
	const right: Seg[] = [[marks, paint.warn], [marks && shownTag ? " " : ""], [shownTag, paint.dim], [" "]];
	return spread([...lead, [name, quiet ? paint.dim : here ? paint.bold : undefined]], right, width);
}

/**
 * What is folded away while the pane is at rest: everything under a finished session, once all
 * of it is finished or asleep too. Finished work stays one line until the pane has the keyboard,
 * when every session shows so the cursor can reach it.
 */
export function foldedUnder(repo: PaneRepo, view: PaneView): { inside: Set<string>; under: Map<string, number> } {
	const inside = new Set<string>();
	const under = new Map<string, number>();
	if (view.focused) return { inside, under };
	const nodes = repo.state.nodes;
	const kids = (id: string): NodeMeta[] => nodes.filter((node) => node.parentId === id);
	const descendants = (id: string): NodeMeta[] => kids(id).flatMap((kid) => [kid, ...descendants(kid.id)]);
	const settled = (node: NodeMeta): boolean => {
		const attention = repo.state.attention[node.id];
		const waiting = (attention?.dialogs ?? 0) > 0 || (attention?.pending ?? 0) > 0;
		return !waiting && node.id !== view.current && (node.done === true || node.status === "dormant" || node.status === "idle" || node.status === "exited");
	};
	for (const node of nodes) {
		if (!node.done || inside.has(node.id)) continue;
		const below = descendants(node.id);
		if (below.length === 0 || !settled(node) || !below.every(settled)) continue;
		for (const each of below) inside.add(each.id);
		under.set(node.id, below.length);
	}
	// A session folded inside another does not also report a count of its own.
	for (const id of inside) under.delete(id);
	return { inside, under };
}

/** A repository's header: its name, and how many sessions it has or what they are doing. */
function repoHeader(repo: PaneRepo, only: boolean, folded: boolean, frame: number, width: number, paint: Paint): Seg[] {
	const counts = tally(repo);
	const strong = (text: string): string => paint.accent(paint.bold(text));
	const right: Seg[] = only
		? [[plural(counts.total, "session"), paint.dim], [" "]]
		: folded
			? [[`${counts.total} idle`, paint.dim], [" "]]
			: [
					[counts.working ? `${SPINNER[frame % SPINNER.length]}${counts.working}` : "", paint.accent],
					[counts.working && counts.waiting ? " " : ""],
					[counts.waiting ? `●${counts.waiting}` : "", paint.warn],
					[!counts.working && !counts.waiting ? plural(counts.total, "session") : "", paint.dim],
					[" "],
				];
	const mark = repo.here ? "◆" : "◇";
	const name = fit(repo.name, Math.max(4, width - 4 - widthOf(right)));
	const left: Seg[] = folded ? [[` ${mark} ${name}`, paint.dim]] : repo.here ? [[` ${mark} ${name}`, strong]] : [[` ${mark} `, paint.accent], [name, paint.bold]];
	return spread(left, right, width);
}

/** Key hints, as many to a row as fit. */
export function flow(hints: ReadonlyArray<readonly [key: string, does: string]>, width: number, paint: Paint): Seg[][] {
	const rows: Seg[][] = [];
	let row: Seg[] = [];
	for (const [key, does] of hints) {
		const hint: Seg[] = [[row.length === 0 ? " " : "  "], [key, paint.bold], [` ${does}`, paint.dim]];
		if (row.length > 0 && widthOf(row) + widthOf(hint) > width) {
			rows.push(row);
			row = [[" "], [key, paint.bold], [` ${does}`, paint.dim]];
		} else row.push(...hint);
	}
	if (row.length > 0) rows.push(row);
	return rows;
}

/** What the footer says: how to get in while the pane is at rest, the keys while it has the keyboard. */
function footer(view: PaneView, waiting: number, width: number, paint: Paint): Seg[][] {
	const key = (text: string): Seg => [text, paint.bold];
	const word = (text: string): Seg => [text, paint.dim];
	const rule: Seg[] = [["─".repeat(width), paint.dim]];
	if (!view.focused) {
		const right: Seg[] = waiting > 0 ? [[`${waiting} waiting`, paint.warn], [" "]] : [["nothing waiting", paint.dim], [" "]];
		const left: Seg[] = [[" "], key("alt+l"), word(waiting > 0 ? " to answer" : " sessions")];
		return [rule, widthOf(left) + widthOf(right) + 1 <= width ? spread(left, right, width) : left];
	}
	if (view.note) return [rule, [[fit(` ${view.note}`, width), paint.dim]]];
	if (view.inspector) return [rule, ...flow([["↑↓", "move"], ...(waiting > 0 ? ([["1-9", "jump"]] as const) : []), ["esc", "close"]], width, paint)];
	const back: Array<readonly [string, string]> = view.previous ? [["-", "previous"]] : [];
	return [rule, ...flow([...(view.keys ?? [["⏎", "open"], ["n", "new"], ["o", "share"]]), ...back, ["↑↓", "move"], ["esc", "close"]], width, paint)];
}

/**
 * Render the pane into rows of at most `width - 1` columns; the last column is left for the
 * divider, which the caller draws.
 */
export function renderPane(view: PaneView, width: number, paint: Paint = PLAIN): string[] {
	const inner = Math.max(8, width - 1);
	const frame = view.frame ?? 0;
	const body: Seg[][] = [];
	let cursorRow: number | undefined;
	const push = (segs: Seg[], key?: string, clip = true): void => {
		const row = clip && widthOf(segs) > inner ? [[fit(segs.map(([text]) => text).join(""), inner), segs[0]?.[1]] as Seg] : segs;
		if (key !== undefined && key === view.cursor && view.focused) {
			cursorRow ??= body.length;
			// Styled first, then given the cursor's background across the whole row.
			body.push([[draw(padTo(row, inner)), paint.select]]);
		} else body.push(row);
	};

	const inbox = paneInbox(view);
	const asleep = view.asleep ?? [];
	const groups = view.repos.filter((repo) => repo.state.nodes.length > 0);
	const several = groups.length + asleep.length > 1;
	if (inbox.length > 0) {
		push(spread([[" NEEDS YOU", (text) => paint.warn(paint.bold(text))]], [[String(inbox.length), paint.warn], [" "]], inner));
		inbox.forEach(({ item, repo }, index) => {
			const key = itemKey(item.id);
			const number = view.focused && index < 9 ? `${index + 1} ` : "";
			const from = repo.here ? "" : repo.name;
			const lead: Seg[] = [[` ${number}`, paint.bold], [ITEM_ICON[item.kind], paint.warn], [" "]];
			const title = fit(item.title, Math.max(4, inner - widthOf(lead) - (from ? [...from].length + 2 : 1)));
			push(from ? spread([...lead, [title, paint.bold]], [[fit(from, 14), paint.accent], [" "]], inner) : [...lead, [title, paint.bold]], key);
			const indent = `   ${" ".repeat(number.length)}`;
			// Under the cursor an item shows all of what it says, so it can be answered where it is.
			if (view.focused && key === view.cursor && !view.inspector) for (const text of wrap(item.text, inner - indent.length - 1).slice(0, 6)) push([[`${indent}${text}`]], key);
			else push([[fit(`${indent}${item.text}`, inner), paint.dim]], key);
		});
		push([["─".repeat(inner), paint.dim]]);
	}

	// With no tree in the repository this terminal is in, say how to start one before listing the others.
	if (!groups.some((repo) => repo.here)) {
		for (const text of (view.hint ?? "No sessions yet.").split("\n")) push([[fit(` ${text}`, inner), paint.dim]]);
		if (groups.length + asleep.length > 0) push([[""]]);
	}
	for (const repo of groups) {
		const counts = tally(repo);
		// A repository this terminal is not in stays folded to one line while nothing in it is working or waiting.
		const folded = !repo.here && !view.focused && counts.working === 0 && counts.waiting === 0;
		push(repoHeader(repo, !several, folded, frame, inner, paint));
		if (folded) continue;
		const hidden = foldedUnder(repo, view);
		for (const { node, prefix } of treeLines(repo.state.nodes)) {
			if (hidden.inside.has(node.id)) continue;
			push(sessionRow(node, prefix, repo, view, inner, paint, hidden.under.get(node.id) ?? 0), nodeKey(node.id), false);
		}
	}

	for (const repo of asleep) push(spread([[` ◇ ${fit(repo.name, Math.max(4, inner - 11))}`, paint.dim]], [["asleep", paint.dim], [" "]], inner), repoKey(repo.key));

	const foot = footer(view, inbox.length, inner, paint);
	const rows = body.map(draw);
	if (view.height === undefined) return [...rows, ...foot.map(draw)];
	const room = Math.max(1, view.height - foot.length);
	let shown = rows;
	if (rows.length > room) {
		// Keep the cursor in view; say how much is cut off at either end.
		const start = Math.min(Math.max(0, (cursorRow ?? 0) - room + 2), rows.length - room);
		shown = rows.slice(start, start + room);
		if (start > 0) shown[0] = paint.dim(` ↑ ${start} more`);
		const below = rows.length - start - room;
		if (below > 0) shown[shown.length - 1] = paint.dim(` ↓ ${below} more`);
	}
	return [...shown, ...Array.from({ length: room - shown.length }, () => ""), ...foot.map(draw)];
}

/** One line per session, for terminals where the side pane cannot be shown. */
export function renderCompact(view: PaneView, limit = 8): string[] {
	const rows = view.repos.flatMap((repo) =>
		treeLines(repo.state.nodes).map(({ node, prefix }) => {
			const owner = node.owner === repo.state.owner ? "you" : `@${node.owner}`;
			const mark = statusMark(node, (repo.state.attention[node.id]?.dialogs ?? 0) > 0, gone(node, repo.state), view.frame ?? 0, PLAIN)[0];
			return `${node.id === view.current ? "▸" : " "} ${prefix}${mark} ${node.name}  ${owner}${node.repo ? ` · ${node.repo}` : ""}`;
		}),
	);
	return rows.length > limit ? [...rows.slice(0, limit - 1), `  … ${rows.length - limit + 1} more (/lattice)`] : rows;
}

/**
 * The pane in two rows, for a terminal too narrow for it (or where it cannot be installed):
 * the sessions of this repository with the others counted, then the first thing waiting.
 * Sessions are placed by what matters most: the one open here, then waiting, then working.
 */
export function renderStrip(view: PaneView, width: number, paint: Paint = PLAIN): string[] {
	const groups = view.repos.filter((repo) => repo.state.nodes.length > 0);
	if (groups.length === 0 && (view.asleep ?? []).length === 0) return [];
	const frame = view.frame ?? 0;
	const here = groups.find((repo) => repo.here);
	const row: Seg[] = [];
	const others: Seg[] = [];
	for (const repo of groups) {
		if (repo.here) continue;
		const counts = tally(repo);
		others.push(["  ◇ ", paint.accent], [fit(repo.name, 16)], [counts.working ? ` ${SPINNER[frame % SPINNER.length]}${counts.working}` : "", paint.accent], [counts.waiting ? ` ●${counts.waiting}` : "", paint.warn]);
	}
	if (here) {
		row.push([` ◆ ${fit(here.name, 16)} `, (text) => paint.accent(paint.bold(text))]);
		const rank = (node: NodeMeta): number => {
			const attention = here.state.attention[node.id];
			if (node.id === view.current) return 0;
			if ((attention?.dialogs ?? 0) > 0 || (attention?.pending ?? 0) > 0 || node.status === "blocked") return 1;
			return node.status === "running" || node.status === "starting" ? 2 : 3;
		};
		const nodes = treeLines(here.state.nodes).map((line) => line.node).sort((a, b) => rank(a) - rank(b));
		let shown = 0;
		for (const node of nodes) {
			const attention = here.state.attention[node.id];
			const marks = [attention?.dialogs ? `?${attention.dialogs}` : "", attention?.pending ? `✉${attention.pending}` : ""].filter(Boolean).join(" ");
			const open = node.id === view.current;
			const cell: Seg[] = [
				[shown > 0 ? " │ " : " ", paint.dim],
				[open ? "▸" : "", paint.accent],
				statusMark(node, (attention?.dialogs ?? 0) > 0, gone(node, here.state), frame, paint),
				[` ${fit(node.name, 18)}`, open ? paint.bold : undefined],
				[marks ? ` ${marks}` : "", paint.warn],
			];
			const rest = nodes.length - shown - 1;
			// Leave room to say how many are not shown, and for the other repositories.
			if (shown > 0 && widthOf(row) + widthOf(cell) + (rest > 0 ? 6 : 0) + widthOf(others) > width - 1) break;
			row.push(...cell);
			shown++;
		}
		if (shown < nodes.length) row.push([` │ +${nodes.length - shown}`, paint.dim]);
	}
	row.push(...(here ? others : others.length > 0 ? [[" "] as Seg, ...others.slice(0)] : []));
	for (const repo of view.asleep ?? []) if (widthOf(row) + [...repo.name].length + 12 < width) row.push([`  ◇ ${repo.name} asleep`, paint.dim]);
	const lines = [widthOf(row) > width ? fit(row.map(([text]) => text).join(""), width) : draw(row)];
	const inbox = paneInbox(view);
	const first = inbox[0];
	const hint: Seg[] = [["alt+l", paint.bold], [inbox.length > 1 ? ` ${inbox.length} waiting ` : " to answer ", paint.dim]];
	if (first) {
		const from = first.repo.here ? "" : ` (${first.repo.name})`;
		const lead: Seg[] = [[" "], [ITEM_ICON[first.item.kind], paint.warn], [" "]];
		const room = width - widthOf(lead) - widthOf(hint) - 2;
		const title = fit(`${first.item.title}${from}`, Math.max(6, Math.min(30, room)));
		const text = fit(first.item.text, Math.max(0, room - [...title].length - 2));
		lines.push(draw(spread([...lead, [title, paint.bold], [text ? `  ${text}` : "", paint.dim]], hint, width)));
	}
	return lines;
}
