/**
 * The work of a network as the canopy sees it: items on levels, who owns each, and the agent
 * sitting on it. Built from the same state the pane reads. No Pi, no terminal.
 */
import { type Issue, isPlanned, misfit, type NodeMeta, roleOf, stateKind, type UiState, type WorkState } from "@pi-lattice/protocol";

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
	/** Whose session it is, when the item it sits on may be someone else's: an issue assigned to one person with another's session on it. */
	owner?: string;
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
	/** The issue it is, when the canopy is drawn from a team's server. */
	issue?: Issue;
	/** Why the issue does not fit the team's scheme as it is now. */
	misfit?: string;
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
export { roleOf };

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
	// With a server, the work is its issues and the sessions sit on them; without one, the work is the sessions.
	const work = sources.map((source) => source.state.work).find((state) => state !== undefined);
	if (work) return buildFromWork(sources, work, rootName);
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

	const names = new Set<string>([me]);
	for (const item of items.values()) if (item !== root) names.add(item.owner);
	for (const name of online.keys()) names.add(name);
	return finish(root, items, [me, ...[...names].filter((name) => name !== me && name !== "").sort()], online, levels, me, sources);
}

/** Count progress at the tips, and what each person has. */
function finish(root: Item, items: Map<string, Item>, names: string[], online: ReadonlyMap<string, boolean>, levels: readonly string[], me: string, sources: readonly TreeSource[]): World {
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
	const people: Person[] = names.map((name, index) => ({ name, me: name === me, online: name === me || online.get(name) !== false, index, working: 0, asking: 0, owned: 0 }));
	const byName = new Map(people.map((person) => [person.name, person]));
	for (const item of items.values()) {
		if (item === root) continue;
		const owner = byName.get(item.owner);
		if (owner) owner.owned++;
		// What is running is counted for whoever runs it, which on an issue need not be who it is assigned to.
		const runner = byName.get(item.agent?.owner ?? item.owner);
		if (!runner) continue;
		if (item.agent?.state === "working") runner.working++;
		if (item.asks > 0 || item.agent?.state === "asking") runner.asking++;
	}
	const traffic = sources.flatMap((source) => source.state.traffic ?? []);
	return { root, items, people, levels: [...levels], me, traffic };
}

/** A session as the canopy seats it: one of this person's, with everything the host knows, or a teammate's as the server tells it. */
interface Sitter {
	id: string;
	owner: string;
	name: string;
	repo: string;
	tree: string;
	issue: number | undefined;
	agent: Agent;
	asks: number;
	node: NodeMeta | undefined;
}

const URGENCY: Record<AgentState, number> = { asking: 0, failed: 1, working: 2, waiting: 3, idle: 4 };

/**
 * The canopy of a team with a server. An item is an issue, on the level its type has in the
 * team's scheme; whoever it is assigned to owns it; and the sessions on it sit there, the first
 * as its agent and the rest beside it. Sessions on no issue are at the foot, so nothing running is hidden.
 */
function buildFromWork(sources: readonly TreeSource[], work: WorkState, rootName: string): World {
	const me = work.me;
	const scheme = work.scheme;
	const rungs = [...new Set(scheme.types.map((type) => type.level))].sort((a, b) => a - b);
	const levels = rungs.map((level) => scheme.types.filter((type) => type.level === level).map((type) => type.name).join(" / "));
	const levelOf = (type: string): number => rungs.indexOf(scheme.types.find((entry) => entry.name === type)?.level ?? -1);
	let host = work.url;
	try {
		host = new URL(work.url).host;
	} catch {
		// Shown as it is.
	}
	const root: Item = {
		id: ROOT_ID, name: rootName || host, kind: "team", level: -1, owner: me, away: false, repo: "", tree: "",
		parent: undefined, children: [], buds: [], agent: undefined, planned: false, done: false, failed: false, leaves: 0, landed: 0, asks: 0, waitsOn: [], node: undefined,
	};
	const items = new Map<string, Item>([[ROOT_ID, root]]);

	// This person's sessions come from their own hosts, which know more than the server is told; everyone else's come from the server.
	const sitters: Sitter[] = [];
	const local = new Set<string>();
	for (const source of sources) {
		for (const node of source.state.nodes) {
			if (node.archived || node.owner !== source.state.owner || isPlanned(node)) continue;
			const agent = agentOf(node, source.state, true);
			if (!agent) continue;
			local.add(node.id);
			const attention = source.state.attention[node.id];
			sitters.push({ id: node.id, owner: me, name: node.name, repo: node.repo ?? source.repo, tree: source.key, issue: node.issue, agent: { ...agent, owner: me }, asks: (attention?.dialogs ?? 0) + (attention?.pending ?? 0), node });
		}
	}
	for (const session of work.sessions) {
		if (local.has(session.id) || session.owner === me) continue;
		sitters.push({
			id: session.id, owner: session.owner, name: session.name, repo: session.repo, tree: `${session.owner}:${session.host}`, issue: session.issue,
			agent: { role: session.role || session.name, state: session.state, open: false, owner: session.owner, ...(session.activity ? { activity: session.activity } : {}) }, asks: session.asks, node: undefined,
		});
	}

	const byNumber = new Map(work.issues.map((issue) => [issue.number, issue]));
	// Dropped work is not drawn; nothing unfinished can be under it.
	const shown = (issue: Issue): boolean => stateKind(scheme, issue.state) !== "dropped";
	const kids = new Map<number | undefined, Issue[]>();
	for (const issue of work.issues) {
		if (!shown(issue)) continue;
		const above = issue.parent !== undefined ? byNumber.get(issue.parent) : undefined;
		const parent = above && shown(above) ? above.number : undefined;
		kids.set(parent, [...(kids.get(parent) ?? []), issue]);
	}
	const seated = new Set<string>();
	const sessionItem = (sitter: Sitter, parent: Item, level: number): Item => ({
		id: sitter.id, name: sitter.name, kind: sitter.agent.role, level, owner: sitter.owner, away: false, repo: sitter.repo, tree: sitter.tree,
		parent, children: [], buds: [], agent: sitter.agent, planned: false, done: sitter.node?.done === true, failed: sitter.agent.state === "failed",
		leaves: 0, landed: 0, asks: sitter.asks, waitsOn: [], node: sitter.node,
	});
	const place = (issue: Issue, parent: Item, helping: boolean): void => {
		const at = levelOf(issue.type);
		// A type the scheme no longer has, or one that is not deeper than what it is under, hangs on its parent like a helper.
		const bud = helping || (parent !== root && at <= parent.level);
		const on = sitters.filter((sitter) => sitter.issue === issue.number).sort((a, b) => URGENCY[a.agent.state] - URGENCY[b.agent.state]);
		for (const sitter of on) seated.add(sitter.id);
		const lead = on[0];
		const kind = stateKind(scheme, issue.state);
		const why = misfit(scheme, issue, byNumber);
		const item: Item = {
			id: `#${issue.number}`, name: issue.title, kind: issue.type, level: parent === root ? Math.max(at, 0) : bud ? parent.level : at, owner: issue.assignee ?? lead?.owner ?? "", away: false,
			repo: lead?.repo ?? "", tree: lead?.tree ?? "", parent, children: [], buds: [], agent: lead?.agent, planned: !lead && kind !== "done", done: kind === "done", failed: lead?.agent.state === "failed",
			leaves: 0, landed: 0, asks: on.reduce((sum, sitter) => sum + sitter.asks, 0), waitsOn: [], node: lead?.node, issue, ...(why ? { misfit: why } : {}),
		};
		items.set(item.id, item);
		(bud ? parent.buds : parent.children).push(item);
		// More than one session on an issue: the others sit beside it.
		for (const other of on.slice(1)) {
			const helper = sessionItem(other, item, item.level);
			items.set(helper.id, helper);
			(bud ? parent : item).buds.push(helper);
		}
		for (const child of kids.get(issue.number) ?? []) place(child, bud ? parent : item, bud);
	};
	for (const issue of kids.get(undefined) ?? []) place(issue, root, false);
	// Sessions on no issue, or on one that is gone.
	for (const sitter of sitters) {
		if (seated.has(sitter.id)) continue;
		const item = sessionItem(sitter, root, 0);
		items.set(item.id, item);
		root.children.push(item);
	}

	const online = new Map(work.people.map((person) => [person.name, person.online]));
	const names = new Set<string>([me, ...work.people.map((person) => person.name)]);
	for (const item of items.values()) if (item !== root && item.owner) names.add(item.owner);
	return finish(root, items, [me, ...[...names].filter((name) => name !== me).sort()], online, levels, me, sources);
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
