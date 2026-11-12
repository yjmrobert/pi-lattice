/**
 * The work of a network as the canopy sees it: items on levels, who owns each, and the agent
 * sitting on it. Built from the same state the pane reads. No Pi, no terminal.
 */
import { isPlanned, type NodeMeta, type UiState } from "@pi-lattice/protocol";

/** One host's tree, or what a teammate has in a repository that is not on this machine. */
export interface TreeSource {
	key: string;
	/** What the repository is called. */
	repo: string;
	state: UiState;
}

export type AgentState = "working" | "asking" | "waiting" | "idle" | "failed";

/** The session sitting on an item. */
export interface Agent {
	/** What it is there to do: its role, or the item's name when it has none. */
	role: string;
	state: AgentState;
	/** The item below it that it is working on now, when that is not its own. */
	focus?: string;
	focusAt?: number;
	/** The last thing it said or did. */
	activity?: string;
	/** It is open in a terminal. */
	open: boolean;
}

export interface Item {
	id: string;
	name: string;
	kind: string;
	/** Where its kind is in the ladder. The root of the canopy is -1. */
	level: number;
	owner: string;
	/** Its owner cannot be reached: what is shown is what was last heard. */
	away: boolean;
	repo: string;
	tree: string;
	parent: Item | undefined;
	children: Item[];
	/** Helpers whose kind is not a level: a review, a verification. */
	buds: Item[];
	agent: Agent | undefined;
	/** Nobody has been put on it. */
	planned: boolean;
	/** It reported its result. */
	done: boolean;
	failed: boolean;
	/** The items at the tips under it, itself included when it has none, and how many of them are done. */
	leaves: number;
	landed: number;
	/** Things on it waiting for a person. */
	asks: number;
	/** Ids of what it waits on before it starts. */
	waitsOn: string[];
	node: NodeMeta | undefined;
}

export interface Person {
	name: string;
	me: boolean;
	online: boolean;
	/** Stable position in the palette. */
	index: number;
	working: number;
	asking: number;
	owned: number;
}

export interface World {
	root: Item;
	items: Map<string, Item>;
	people: Person[];
	levels: string[];
	me: string;
	traffic: Array<{ from: string; to: string; intent: string; at: number }>;
}

export const ROOT_ID = "canopy:root";
const PLUMBING = new Set(["protocol", "reporting"]);

/** What an agent is called on the canopy: the last role it was given that is about the work. */
export function roleOf(node: Pick<NodeMeta, "fragments" | "name">): string {
	return node.fragments.filter((name) => !PLUMBING.has(name)).at(-1) ?? node.name;
}

function agentOf(node: NodeMeta, state: UiState, mine: boolean): Agent | undefined {
	if (isPlanned(node)) return undefined;
	const attention = state.attention[node.id];
	const asking = (attention?.dialogs ?? 0) > 0 || (attention?.pending ?? 0) > 0 || node.status === "blocked";
	const held = (node.waitsOn?.length ?? 0) > 0;
	const agentState: AgentState = node.status === "failed" ? "failed" : asking ? "asking" : held ? "waiting" : node.status === "running" || node.status === "starting" ? "working" : "idle";
	const focus = mine ? state.focus?.[node.id] : undefined;
	const activity = state.activity?.[node.id]?.text;
	return { role: roleOf(node), state: agentState, open: state.foreground.includes(node.id), ...(focus ? { focus: focus.nodeId, focusAt: focus.at } : {}), ...(activity ? { activity } : {}) };
}

/**
 * Build the canopy's world from every tree in view. An item's level is where its kind is in
 * `levels`; a child always sits above its parent, and a kind that is not a level makes a bud.
 */
export function buildWorld(sources: readonly TreeSource[], levels: readonly string[], rootName = ""): World {
	const first = sources[0]?.state;
	const me = first?.owner ?? "";
	const network = sources.map((source) => source.state.sharing?.network).find((name) => name);
	const root: Item = {
		id: ROOT_ID, name: rootName || network || (sources.length === 1 ? (sources[0]?.repo ?? "") : "your work"), kind: "network", level: -1, owner: me, away: false, repo: "", tree: "",
		parent: undefined, children: [], buds: [], agent: undefined, planned: false, done: false, failed: false, leaves: 0, landed: 0, asks: 0, waitsOn: [], node: undefined,
	};
	const items = new Map<string, Item>([[ROOT_ID, root]]);
	const online = new Map<string, boolean>();
	for (const source of sources) for (const person of source.state.sharing?.people ?? []) online.set(person.name, (online.get(person.name) ?? false) || person.online || person.self);

	const add = (source: { key: string; repo: string; state: UiState }, nodes: readonly NodeMeta[], owned: boolean, away: (owner: string) => boolean): void => {
		const byId = new Map(nodes.map((node) => [node.id, node]));
		const kids = new Map<string | null, NodeMeta[]>();
		for (const node of nodes) {
			if (node.archived) continue;
			const parent = node.parentId && byId.has(node.parentId) ? node.parentId : null;
			kids.set(parent, [...(kids.get(parent) ?? []), node]);
		}
		const place = (node: NodeMeta, parent: Item, helping: boolean): void => {
			const at = levels.indexOf(node.kind);
			// A root whose kind is not a level is the top level. Below that, a kind that is not a level, or not a deeper one, is a helper,
			// and so is everything under a helper: they all hang on the item being helped.
			const bud = helping || (parent !== root && at <= parent.level);
			const attention = source.state.attention[node.id];
			const mine = owned && node.owner === source.state.owner;
			if (items.has(node.id)) return;
			const item: Item = {
				id: node.id, name: node.name, kind: node.kind, level: parent === root ? Math.max(at, 0) : bud ? parent.level : at, owner: node.owner, away: away(node.owner), repo: node.repo ?? source.repo, tree: source.key,
				parent, children: [], buds: [], agent: agentOf(node, source.state, mine), planned: isPlanned(node), done: node.done === true, failed: node.status === "failed",
				leaves: 0, landed: 0, asks: (attention?.dialogs ?? 0) + (attention?.pending ?? 0), waitsOn: node.waitsOn ?? [], node,
			};
			items.set(item.id, item);
			(bud ? parent.buds : parent.children).push(item);
			for (const kid of kids.get(node.id) ?? []) place(kid, bud ? parent : item, bud);
		};
		for (const node of kids.get(null) ?? []) place(node, root, false);
	};

	for (const source of sources) {
		const state = source.state;
		add(source, state.nodes, true, (owner) => owner !== state.owner && online.get(owner) === false);
		for (const tree of state.sharing?.elsewhere ?? []) {
			online.set(tree.owner, (online.get(tree.owner) ?? false) || tree.online);
			add({ key: `${tree.owner}:${tree.scope}`, repo: tree.repo, state: { ...state, attention: {}, foreground: [], activity: {}, focus: {} } }, tree.nodes, false, () => !tree.online);
		}
	}

	// Progress is counted at the tips.
	const count = (item: Item): void => {
		for (const child of item.children) count(child);
		if (item.children.length === 0) {
			item.leaves = item === root ? 0 : 1;
			item.landed = item.done ? 1 : 0;
		} else {
			item.leaves = item.children.reduce((sum, child) => sum + child.leaves, 0);
			item.landed = item.children.reduce((sum, child) => sum + child.landed, 0);
		}
	};
	count(root);

	const names = new Set<string>([me]);
	for (const item of items.values()) if (item !== root) names.add(item.owner);
	for (const name of online.keys()) names.add(name);
	const ordered = [me, ...[...names].filter((name) => name !== me && name !== "").sort()];
	const people: Person[] = ordered.map((name, index) => ({ name, me: name === me, online: name === me || online.get(name) !== false, index, working: 0, asking: 0, owned: 0 }));
	const byName = new Map(people.map((person) => [person.name, person]));
	for (const item of items.values()) {
		const person = byName.get(item.owner);
		if (!person || item === root) continue;
		person.owned++;
		if (item.agent?.state === "working") person.working++;
		if (item.asks > 0 || item.agent?.state === "asking") person.asking++;
	}
	const traffic = sources.flatMap((source) => source.state.traffic ?? []);
	return { root, items, people, levels: [...levels], me, traffic };
}

/** Every item under one, itself first, parents before children; helpers after the item they serve. */
export function walk(item: Item): Item[] {
	return [item, ...item.buds, ...item.children.flatMap(walk)];
}

/** An item and everything above it, nearest first. */
export function pathTo(item: Item): Item[] {
	const out: Item[] = [];
	for (let at: Item | undefined = item; at; at = at.parent) out.push(at);
	return out;
}
