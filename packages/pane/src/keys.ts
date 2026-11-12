/** What a key press means while the pane has the keyboard. Pure: the extension carries the actions out. */
import { isHeld, isPlanned } from "@pi-lattice/protocol";
import { findNode, gone, type InboxItem, itemKey, type PaneView, paneInbox, paneOrder } from "./view.ts";

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
	/** Accept or decline a session someone offers, decline someone's request, or take back one's own. */
	| { do: "sharing"; repo: string; action: "accept" | "cancel" | "decline" | "withdraw"; args: string[] }
	/** Create a session under this one. */
	| { do: "new"; nodeId: string | undefined }
	/** Start the host of a repository whose tree is asleep, so its sessions can be seen and opened. */
	| { do: "wake"; repo: string }
	/** Hide a session and everything under it from the tree. */
	| { do: "archive"; repo: string; nodeId: string }
	/** Stop what a session's agent is doing. */
	| { do: "interrupt"; repo: string; nodeId: string }
	/** Start a session that is waiting on others, without waiting for them. */
	| { do: "start"; repo: string; nodeId: string }
	/** Ask for the same key again before doing something that loses work. `what` names it. */
	| { do: "confirm"; what: string }
	/** Show or hide the list of every key. */
	| { do: "help" }
	/** Open the settings screen. */
	| { do: "settings" };

/** The key a person must press twice to stop a session, as the view records it. */
export const stopKey = (nodeId: string): string => `stop:${nodeId}`;

/**
 * What the session under the cursor allows: it is this person's, it is working, it is the one
 * open here, it has not started because it waits on others; whether this person is in a network; and for a teammate's session, whether they
 * can be reached and whether it has already been asked for.
 */
function cursorSession(view: PaneView): { id: string; repo: string; mine: boolean; working: boolean; here: boolean; held: boolean; planned: boolean; network: boolean; reachable: boolean; asked: boolean; remote: boolean } | undefined {
	const id = cursorNode(view);
	const found = id ? findNode(view, id) : undefined;
	if (!found) return undefined;
	const { node, repo } = found;
	const sharing = repo.state.sharing;
	return {
		id: node.id, repo: repo.key, mine: node.owner === repo.state.owner, working: node.status === "running" || node.status === "starting", here: node.id === view.current, held: isHeld(node), planned: isPlanned(node),
		network: sharing !== null, reachable: !gone(node, repo.state), asked: sharing?.requests.some((request) => request.role === "asker" && request.nodeId === node.id) ?? false,
		remote: repo.remote !== undefined,
	};
}

/** The key that hands a session over, and what it does there: offer yours, ask for a teammate's, or set a network up first. */
function handKey(at: ReturnType<typeof cursorSession>): readonly [key: string, does: string] | undefined {
	if (!at || !at.network) return ["o", "network"];
	if (at.mine) return ["o", "offer"];
	if (at.reachable) return ["t", at.asked ? "withdraw" : "take"];
	return undefined;
}

/** Every key the pane takes, for the help screen. */
export const ALL_KEYS: ReadonlyArray<readonly [section: string, keys: ReadonlyArray<readonly [key: string, does: string]>]> = [
	["Moving", [["↑ ↓  j k", "move through what is waiting, then the sessions"], ["1-9", "jump to a waiting item"], ["esc  alt+l", "give the keyboard back to Pi"], [",", "settings"], ["?", "show or hide this list"]]],
	["A session", [["enter", "open it in this terminal"], ["-", "go back to the session you were in before"], ["n", "create a session under it"], ["r", "rename it"], ["s", "stop what its agent is doing (press twice); start one that is waiting on others"], ["d", "archive it and everything under it"], ["o", "offer it to a teammate; before that, create or join a network"], ["t", "ask a teammate for theirs, or take the request back; in a repository you do not have, it is cloned first"]]],
	["Something waiting", [["y  n", "answer a yes/no question"], ["a  x", "approve or reject a message; accept or decline an offer; hand over or keep a session someone asks for"], ["enter", "answer or review it with Pi's prompts"]]],
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
		// A session that is waiting on others has nothing to open yet.
		if (at && !at.here && !(at.mine && at.held)) keys.push(["⏎", at.remote ? "read" : "open"]);
		// Nothing can be created in a repository that is not on this machine.
		if (!at?.remote) keys.push(["n", "new"]);
		if (at?.mine) keys.push(["r", "rename"]);
		if (at?.mine && at.working) keys.push(["s", view.confirm === stopKey(at.id) ? "again to stop" : "stop"]);
		if (at?.mine && at.held) keys.push(["s", at.planned ? "put a session on it" : "start now"]);
		if (at?.mine && !at.here) keys.push(["d", "archive"]);
		const hand = handKey(at);
		if (hand) keys.push(hand);
		keys.push([",", "settings"], ["?", "keys"]);
		return keys;
	}
	const { item } = found;
	if (yesNo(item)) return [["y", "yes"], ["n", "no"]];
	if (item.kind === "question") return [["⏎", "answer"]];
	if (item.kind === "message") return item.envelope ? [["a", "approve"], ["x", "reject"]] : [["⏎", "review"]];
	if (item.kind === "offer") return [["a", "accept"], ["x", "decline"]];
	if (item.kind === "request") return [["a", "hand over"], ["x", "keep"]];
	if (item.kind === "release") return [["⏎", "send now"], ["x", "cancel"]];
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
		if (item.kind === "offer" && (key === "a" || key === "x")) return [{ do: "sharing", repo, action: key === "a" ? "accept" : "cancel", args: [nodeId] }];
		if (item.kind === "request" && item.person) {
			// Handing over sends the conversation away, so it is confirmed with Pi's prompt; keeping it is one key.
			if (key === "a" || key === "enter") return [{ do: "leave" }, { do: "command", text: `/lattice approve ${nodeId} ${item.person}` }];
			if (key === "x") return [{ do: "sharing", repo, action: "decline", args: [nodeId, item.person] }];
			return [];
		}
		if (item.kind === "release") {
			if (key === "enter") return [{ do: "leave" }, { do: "command", text: `/lattice release ${nodeId}` }];
			if (key === "x") return [{ do: "sharing", repo, action: "cancel", args: [nodeId] }];
			return [];
		}
		if (key === "enter") return [{ do: "leave" }, { do: "command", text: "/lattice network" }];
		return [];
	}
	const target = cursorNode(view) ?? view.current;
	const on = cursorSession(view);
	if (key === "enter" && on?.mine && on.held && !on.here) return [];
	if (key === "enter") return target && target !== view.current ? [{ do: "leave" }, { do: "command", text: `/lattice open ${target}` }] : [{ do: "leave" }];
	if (key === "n") return on?.remote ? [] : [{ do: "new", nodeId: target }];
	if (on?.mine) {
		if (key === "r") return [{ do: "leave" }, { do: "command", text: `/lattice rename ${on.id}` }];
		if (key === "d" && !on.here) return [{ do: "archive", repo: on.repo, nodeId: on.id }];
		// Stopping loses the step in flight, so it takes the key twice.
		if (key === "s" && on.held) return [{ do: "start", repo: on.repo, nodeId: on.id }];
		if (key === "s" && on.working) return view.confirm === stopKey(on.id) ? [{ do: "interrupt", repo: on.repo, nodeId: on.id }] : [{ do: "confirm", what: stopKey(on.id) }];
	}
	if (key === "a") return [{ do: "leave" }, { do: "command", text: "/lattice approvals" }];
	const hand = handKey(on);
	if (hand && key === hand[0]) {
		if (!on || hand[1] === "network") return [{ do: "leave" }, { do: "command", text: "/lattice network" }];
		if (hand[1] === "withdraw") return [{ do: "sharing", repo: on.repo, action: "withdraw", args: [on.id] }];
		return [{ do: "leave" }, { do: "command", text: `/lattice ${hand[1]} ${on.id}` }];
	}
	return [];
}
