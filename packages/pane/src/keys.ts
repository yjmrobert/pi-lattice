/** What a key press means while the pane has the keyboard. Pure: the extension carries the actions out. */
import { findNode, type InboxItem, itemKey, type PaneView, paneInbox, paneOrder } from "./view.ts";

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
	/** Create a session under this one. */
	| { do: "new"; nodeId: string | undefined }
	/** Start the host of a repository whose tree is asleep, so its sessions can be seen and opened. */
	| { do: "wake"; repo: string }
	/** Hide a session and everything under it from the tree. */
	| { do: "archive"; repo: string; nodeId: string }
	/** Stop what a session's agent is doing. */
	| { do: "interrupt"; repo: string; nodeId: string }
	/** Ask for the same key again before doing something that loses work. `what` names it. */
	| { do: "confirm"; what: string }
	/** Show or hide the list of every key. */
	| { do: "help" }
	/** Open the settings screen. */
	| { do: "settings" };

/** The key a person must press twice to stop a session, as the view records it. */
export const stopKey = (nodeId: string): string => `stop:${nodeId}`;

/** What the session under the cursor allows: it is this person's, it is working, it is the one open here. */
function cursorSession(view: PaneView): { id: string; repo: string; mine: boolean; working: boolean; here: boolean } | undefined {
	const id = cursorNode(view);
	const found = id ? findNode(view, id) : undefined;
	if (!found) return undefined;
	const { node, repo } = found;
	return { id: node.id, repo: repo.key, mine: node.owner === repo.state.owner, working: node.status === "running" || node.status === "starting", here: node.id === view.current };
}

/** Every key the pane takes, for the help screen. */
export const ALL_KEYS: ReadonlyArray<readonly [section: string, keys: ReadonlyArray<readonly [key: string, does: string]>]> = [
	["Moving", [["↑ ↓  j k", "move through what is waiting, then the sessions"], ["1-9", "jump to a waiting item"], ["esc  alt+l", "give the keyboard back to Pi"], [",", "settings"], ["?", "show or hide this list"]]],
	["A session", [["enter", "open it in this terminal"], ["-", "go back to the session you were in before"], ["n", "create a session under it"], ["r", "rename it"], ["s", "stop what its agent is doing (press twice)"], ["d", "archive it and everything under it"], ["o", "share: pair, offer, accept"]]],
	["Something waiting", [["y  n", "answer a yes/no question"], ["a  x", "approve or reject a message; accept or decline an offer"], ["enter", "answer or review it with Pi's prompts"]]],
	["A sleeping repository", [["enter", "start its host"]]],
];

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
	if (!found) {
		const at = cursorSession(view);
		const keys: Array<readonly [string, string]> = [];
		if (at && !at.here) keys.push(["⏎", "open"]);
		keys.push(["n", "new"]);
		if (at?.mine) keys.push(["r", "rename"]);
		if (at?.mine && at.working) keys.push(["s", view.confirm === stopKey(at.id) ? "again to stop" : "stop"]);
		if (at?.mine && !at.here) keys.push(["d", "archive"]);
		keys.push(["o", "share"], [",", "settings"], ["?", "keys"]);
		return keys;
	}
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
	if (view.help) return key === "escape" || key === "?" ? [{ do: "help" }] : [];
	if (key === "?") return [{ do: "help" }];
	if (key === ",") return [{ do: "settings" }];
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
	if (key === "n") return [{ do: "new", nodeId: target }];
	const on = cursorSession(view);
	if (on?.mine) {
		if (key === "r") return [{ do: "leave" }, { do: "command", text: `/lattice rename ${on.id}` }];
		if (key === "d" && !on.here) return [{ do: "archive", repo: on.repo, nodeId: on.id }];
		// Stopping loses the step in flight, so it takes the key twice.
		if (key === "s" && on.working) return view.confirm === stopKey(on.id) ? [{ do: "interrupt", repo: on.repo, nodeId: on.id }] : [{ do: "confirm", what: stopKey(on.id) }];
	}
	if (key === "a") return [{ do: "leave" }, { do: "command", text: "/lattice approvals" }];
	if (key === "o") return [{ do: "leave" }, { do: "command", text: `/lattice share ${target ?? ""}`.trim() }];
	return [];
}
