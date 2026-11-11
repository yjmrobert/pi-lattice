/** What a key press means while the pane has the keyboard. Pure: the extension carries the actions out. */
import { type InboxItem, itemKey, type PaneView, paneInbox, paneOrder } from "./view.ts";

/** A key as the pane sees it: a name for the special ones, else the character typed. */
export type PaneKey = "up" | "down" | "enter" | "escape" | (string & {});

export type PaneAction =
	/** Move the cursor. */
	| { do: "move"; cursor: string }
	/** Give the keyboard back to Pi. */
	| { do: "leave" }
	/** Run a `/lattice` command, which may open Pi's own dialogs or switch session. */
	| { do: "command"; text: string }
	/** Answer a yes/no question a background session is blocked on. */
	| { do: "answer"; repo: string; nodeId: string; dialogId: string; confirmed: boolean }
	/** Approve or reject a message waiting for approval. */
	| { do: "decide"; repo: string; nodeId: string; envelopeId: string; action: "approve" | "reject" }
	/** Accept or decline a session someone offers. */
	| { do: "sharing"; repo: string; action: "accept" | "cancel"; nodeId: string }
	/** Start the host of a repository whose tree is asleep, so its sessions can be seen and opened. */
	| { do: "wake"; repo: string };

/** The item the cursor is on, with the repository it is from. */
export function cursorItem(view: PaneView): { item: InboxItem; repo: string } | undefined {
	const found = paneInbox(view).find((entry) => itemKey(entry.item.id) === view.cursor);
	return found ? { item: found.item, repo: found.repo.key } : undefined;
}

/** The session the cursor is on. */
export function cursorNode(view: PaneView): string | undefined {
	return view.cursor?.startsWith("n:") ? view.cursor.slice(2) : undefined;
}

/** Whether a question can be answered with one key. */
const yesNo = (item: InboxItem): boolean => item.kind === "question" && item.dialog?.method === "confirm";

/**
 * The keys that act on what the cursor is on, with what each does, in the order shown in the
 * footer. The same table decides what a key press does, so the footer cannot lie.
 */
export function cursorKeys(view: PaneView): Array<readonly [key: string, does: string]> {
	const found = cursorItem(view);
	if (view.cursor?.startsWith("r:")) return [["⏎", "wake"]];
	if (!found) return cursorNode(view) && cursorNode(view) !== view.current ? [["⏎", "open"], ["n", "new"], ["o", "share"]] : [["n", "new"], ["o", "share"]];
	const { item } = found;
	if (yesNo(item)) return [["y", "yes"], ["n", "no"]];
	if (item.kind === "question") return [["⏎", "answer"]];
	if (item.kind === "message") return item.envelope ? [["a", "approve"], ["x", "reject"]] : [["⏎", "review"]];
	if (item.kind === "offer") return [["a", "accept"], ["x", "decline"]];
	return [["⏎", "review"]];
}

export function interpretKey(view: PaneView, key: PaneKey): PaneAction[] {
	const order = paneOrder(view);
	const at = Math.max(0, order.indexOf(view.cursor ?? ""));
	const step = (delta: number): PaneAction[] => {
		const cursor = order[Math.min(order.length - 1, Math.max(0, at + delta))];
		return cursor ? [{ do: "move", cursor }] : [];
	};
	if (key === "up" || key === "k") return step(-1);
	if (key === "down" || key === "j") return step(1);
	if (key === "escape") return [{ do: "leave" }];
	// A digit jumps straight to that waiting item.
	if (/^[1-9]$/.test(key)) {
		const entry = paneInbox(view)[Number(key) - 1];
		return entry ? [{ do: "move", cursor: itemKey(entry.item.id) }] : [];
	}
	// `-` goes back to the session this terminal was in before, whichever repository it is in.
	if (key === "-") return view.previous ? [{ do: "leave" }, { do: "command", text: "/lattice back" }] : [];
	if (view.cursor?.startsWith("r:")) return key === "enter" ? [{ do: "wake", repo: view.cursor.slice(2) }] : [];
	const found = cursorItem(view);
	if (found) {
		const { item, repo } = found;
		const nodeId = item.nodeId ?? "";
		if (yesNo(item) && item.dialog && (key === "y" || key === "n")) return [{ do: "answer", repo, nodeId, dialogId: item.dialog.id, confirmed: key === "y" }];
		if (item.kind === "question" && key === "enter") return [{ do: "leave" }, { do: "command", text: `/lattice answer ${nodeId}` }];
		if (item.kind === "message" && item.envelope && (key === "a" || key === "x")) return [{ do: "decide", repo, nodeId, envelopeId: item.envelope.id, action: key === "a" ? "approve" : "reject" }];
		if (item.kind === "message" && key === "enter") return [{ do: "leave" }, { do: "command", text: "/lattice approvals" }];
		if (item.kind === "offer" && (key === "a" || key === "x")) return [{ do: "sharing", repo, action: key === "a" ? "accept" : "cancel", nodeId }];
		if (key === "enter") return [{ do: "leave" }, { do: "command", text: `/lattice share ${nodeId}`.trim() }];
		return [];
	}
	const target = cursorNode(view) ?? view.current;
	if (key === "enter") return target && target !== view.current ? [{ do: "leave" }, { do: "command", text: `/lattice open ${target}` }] : [{ do: "leave" }];
	if (key === "n") return [{ do: "leave" }, { do: "command", text: `/lattice new ${target ?? ""}`.trim() }];
	if (key === "a") return [{ do: "leave" }, { do: "command", text: "/lattice approvals" }];
	if (key === "o") return [{ do: "leave" }, { do: "command", text: `/lattice share ${target ?? ""}`.trim() }];
	return [];
}
