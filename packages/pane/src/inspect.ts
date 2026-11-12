/**
 * The inspector: everything about what the pane's cursor is on, shown in place of the chat
 * while the pane has the keyboard. Pure, like the pane itself. See ADR 0015.
 */
import { isHeld, type NodeMeta } from "@pi-lattice/protocol";
import { ALL_KEYS, cursorItem, cursorNode } from "./keys.ts";
import { draw, findNode, fit, flow, gone, type InboxItem, type Paint, type PaneRepo, type PaneView, PLAIN, paneInbox, type Seg, SPINNER, spread, wrap } from "./view.ts";

/** How long ago, in the largest unit that fits: 40s, 14m, 3h, 2d. */
export function ago(from: string, now: number): string {
	const then = Date.parse(from);
	if (!Number.isFinite(then) || then > now) return "";
	const seconds = Math.floor((now - then) / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

/** A session's state in words, with the mark the pane uses for it. */
function statusLine(node: NodeMeta, repo: PaneRepo, view: PaneView, paint: Paint): Seg[] {
	const waiting = (repo.state.attention[node.id]?.dialogs ?? 0) > 0 || node.status === "blocked";
	const since = view.now !== undefined ? ago(node.updatedAt, view.now) : "";
	const tail: Seg = [since ? ` · ${since}` : "", paint.dim];
	if (gone(node, repo.state)) return [["○ ", paint.dim], [`${node.owner} is offline`, paint.dim], tail];
	if (waiting) return [["● ", paint.warn], ["waiting on you"], tail];
	if (node.status === "running" || node.status === "starting") return [[`${SPINNER[(view.frame ?? 0) % SPINNER.length]} `, paint.accent], ["working"], tail];
	if (node.status === "failed") return [["✗ ", paint.error], ["failed"], tail];
	if (node.status === "exited") return [["✓ ", paint.ok], ["finished"], tail];
	if (node.done) return [["✓ ", paint.ok], ["done: it sent its result"], tail];
	if (isHeld(node)) return [["○ ", paint.dim], ["not started: waiting on others"], tail];
	return [[node.status === "idle" ? "● " : "○ ", paint.dim], [node.status === "idle" ? "idle" : "asleep"], tail];
}

/** A session's ancestors and itself, outermost first. */
function lineage(node: NodeMeta, repo: PaneRepo): string {
	const names: string[] = [];
	const seen = new Set<string>();
	let at: NodeMeta | undefined = node;
	while (at && !seen.has(at.id)) {
		seen.add(at.id);
		names.unshift(at.name);
		const parent: string | null = at.parentId;
		at = parent ? repo.state.nodes.find((candidate) => candidate.id === parent) : undefined;
	}
	return names.join(" › ");
}

/** Tokens and cost in a few characters: `12.4k tokens · $0.03`. */
export function usageText(usage: { tokens: number; cost: number }): string {
	const tokens = usage.tokens >= 1_000_000 ? `${(usage.tokens / 1_000_000).toFixed(1)}M` : usage.tokens >= 1000 ? `${(usage.tokens / 1000).toFixed(1)}k` : String(usage.tokens);
	const cost = usage.cost >= 0.01 ? usage.cost.toFixed(2) : usage.cost > 0 ? "<0.01" : "";
	return cost ? `${tokens} tokens · $${cost}` : `${tokens} tokens`;
}

/** A session's facts as label and value rows. */
function facts(node: NodeMeta, repo: PaneRepo): Array<[label: string, value: string]> {
	const rows: Array<[string, string]> = [
		["owner", node.owner === repo.state.owner ? "you" : node.owner],
		["kind", node.kind],
	];
	if (node.fragments.length > 0) rows.push(["roles", node.fragments.join(" · ")]);
	rows.push(["workspace", node.workspace === "worktree" ? `own worktree${node.branch ? ` · branch ${node.branch}` : ""}` : "shared with its parent"]);
	rows.push(["directory", node.cwd]);
	if (node.model) rows.push(["model", node.model]);
	// What it waits on, with the ones that have finished marked: it starts when all are.
	if (isHeld(node)) rows.push(["waits on", (node.waitsOn ?? []).map((id) => repo.state.nodes.find((other) => other.id === id)).flatMap((other) => (other ? `${other.name}${other.done ? " ✓" : ""}` : [])).join(" · ")]);
	if (node.usage) rows.push(["used", usageText(node.usage)]);
	return rows;
}

/** What an item says, in full. */
function itemText(item: InboxItem): string[] {
	if (item.dialog) {
		const lines = [item.dialog.title, ...(item.dialog.message ? item.dialog.message.split("\n") : [])];
		if (item.dialog.options && item.dialog.options.length > 0) lines.push("", ...item.dialog.options.map((option) => `· ${option}`));
		return lines;
	}
	if (item.envelope) return item.envelope.payload.text.split("\n");
	return [item.text];
}

const ITEM_TITLE: Record<InboxItem["kind"], string> = { question: "Question from", message: "Message", pair: "A different key from", offer: "Session offered by", request: "Session asked for by", release: "Handing over" };

/**
 * Render the inspector for whatever the cursor is on: a session, a waiting item, or a
 * repository whose host is asleep. `height`, when given, pins the keys to the bottom.
 */
export function renderInspector(view: PaneView, width: number, paint: Paint = PLAIN, height?: number): string[] {
	const inner = Math.max(20, width - 2);
	const text = Math.min(inner, 76);
	const out: Seg[][] = [];
	const blank = (): void => void out.push([[""]]);
	const heading = (label: string, style: (t: string) => string = paint.dim): void => void out.push([[` ${label}`, style]]);
	const prose = (lines: string[], limit: number, bar?: Seg): void => {
		const rows = lines.flatMap((line) => (line === "" ? [""] : wrap(line.replace(/\s+/g, " ").trim(), text - (bar ? 3 : 1))));
		for (const row of rows.slice(0, limit)) out.push(bar ? [[" "], bar, [` ${row}`]] : [[` ${row}`]]);
		if (rows.length > limit) out.push(bar ? [[" "], bar, [" …", paint.dim]] : [[" …", paint.dim]]);
	};
	const table = (rows: Array<[string, string]>): void => {
		const pad = Math.max(...rows.map(([label]) => label.length)) + 2;
		// A path too long for the row keeps its end, which is the part that tells directories apart.
		const tail = (value: string, room: number): string => ([...value].length <= room ? value : `…${[...value].slice(-(room - 1)).join("")}`);
		for (const [label, value] of rows) out.push([[` ${label.padEnd(pad)}`, paint.dim], [label === "directory" ? tail(value, Math.max(8, inner - pad - 1)) : fit(value, Math.max(8, inner - pad - 1))]]);
	};
	const session = (node: NodeMeta, repo: PaneRepo, withBrief: boolean): void => {
		if (withBrief && node.brief.trim() !== "") {
			heading("BRIEF");
			prose(node.brief.trim().split("\n"), 8);
			blank();
		}
		table(facts(node, repo));
		// What it last said and did, so there is no need to open it to see how it is getting on.
		const fetched = view.tail?.nodeId === node.id ? view.tail.lines : [];
		const live = repo.state.activity?.[node.id];
		const lines = fetched.length > 0 ? (live && fetched[fetched.length - 1] !== live.text ? [...fetched, live.text] : fetched) : live ? [live.text] : [];
		if (lines.length > 0) {
			blank();
			const when = live && view.now !== undefined ? ago(new Date(live.at).toISOString(), view.now) : "";
			out.push([[" RECENT", paint.dim], [when ? `  ${when} ago` : "", paint.dim]]);
			const shown = lines.slice(-6);
			shown.forEach((line, index) => out.push([[` ${fit(line, text - 1)}`, index === shown.length - 1 ? undefined : paint.dim]]));
		}
	};

	if (view.help) {
		out.push([[" Keys", paint.bold], ["  while the pane has the keyboard", paint.dim]]);
		for (const [section, keys] of ALL_KEYS) {
			blank();
			heading(section.toUpperCase());
			for (const [key, does] of keys) out.push([[` ${key.padEnd(12)}`, paint.bold], [fit(does, Math.max(8, inner - 14))]]);
		}
		blank();
		out.push([[` ${fit("Everything else is under /lattice: type it and press tab to see the commands.", inner - 1)}`, paint.dim]]);
		const helpFoot: Seg[][] = [[["─".repeat(inner + 1), paint.dim]], ...flow([["?", "close"], ["esc", "close"]], inner, paint)];
		const helpBody = out.map(draw);
		if (height === undefined) return [...helpBody, ...helpFoot.map(draw)];
		const helpRoom = Math.max(1, height - helpFoot.length);
		return [...helpBody.slice(0, helpRoom), ...Array.from({ length: Math.max(0, helpRoom - helpBody.length) }, () => ""), ...helpFoot.map(draw)];
	}

	const found = cursorItem(view);
	const nodeId = cursorNode(view);
	const node = nodeId ? findNode(view, nodeId) : undefined;
	const sleeping = view.cursor?.startsWith("r:") ? view.asleep?.find((repo) => `r:${repo.key}` === view.cursor) : undefined;

	if (found) {
		const { item } = found;
		const about = item.nodeId ? findNode(view, item.nodeId) : undefined;
		const title = item.kind === "message" ? `Message: ${item.title}` : `${ITEM_TITLE[item.kind]} ${item.title}`;
		out.push(about ? spread([[` ${fit(title, inner - 26)}`, paint.bold]], [...statusLine(about.node, about.repo, view, paint), [" "]], inner) : [[` ${fit(title, inner)}`, paint.bold]]);
		if (about) out.push([[` ${fit(`${about.repo.name} · ${lineage(about.node, about.repo)}`, inner)}`, paint.dim]]);
		blank();
		prose(itemText(item), 14, ["│", paint.warn]);
		if (about && item.kind !== "pair") {
			blank();
			heading(item.kind === "question" ? "THE SESSION ASKING" : "THE SESSION IT IS FOR");
			session(about.node, about.repo, true);
		}
	} else if (node) {
		out.push(spread([[` ${fit(node.node.name, inner - 26)}`, paint.bold]], [...statusLine(node.node, node.repo, view, paint), [" "]], inner));
		out.push([[` ${fit(`${node.repo.name} · ${lineage(node.node, node.repo)}`, inner)}`, paint.dim]]);
		blank();
		session(node.node, node.repo, true);
		const waiting = paneInbox(view).map((entry, index) => ({ ...entry, index })).filter((entry) => entry.item.nodeId === node.node.id);
		if (waiting.length > 0) {
			blank();
			heading("WAITING ON YOU", (t) => paint.warn(paint.bold(t)));
			for (const { item, index } of waiting) out.push([[` ${index < 9 ? index + 1 : "·"} `, paint.bold], [fit(`${item.title}: ${item.text}`, inner - 4)]]);
		}
	} else if (sleeping) {
		out.push([[` ${fit(sleeping.name, inner)}`, paint.bold]]);
		out.push([[` ${fit(sleeping.key, inner)}`, paint.dim]]);
		blank();
		prose(["This repository has a session tree, but its background host is not running. Opening it starts the host; its sessions then appear here."], 6);
	} else {
		out.push([[" Nothing selected.", paint.dim]]);
	}

	const keys: Array<readonly [string, string]> = [...(view.keys ?? []), ...(view.previous ? ([["-", "previous"]] as const) : [])];
	const empty: Seg[][] = [[[" "]]];
	const foot: Seg[][] = [[["─".repeat(inner + 1), paint.dim]], ...(keys.length > 0 ? flow(keys, inner, paint) : empty)];
	const body = out.map(draw);
	if (height === undefined) return [...body, ...foot.map(draw)];
	const room = Math.max(1, height - foot.length);
	const shown = body.length > room ? [...body.slice(0, room - 1), paint.dim(" …")] : body;
	return [...shown, ...Array.from({ length: room - shown.length }, () => ""), ...foot.map(draw)];
}
