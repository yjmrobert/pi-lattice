/** Pure helpers over a flat list of nodes. */
import type { NodeMeta } from "./node.ts";

export function childrenOf(nodes: readonly NodeMeta[], id: string): NodeMeta[] {
	return nodes.filter((node) => node.parentId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Depth of a node; a root is 0. Stops at a missing parent or a cycle. */
export function depthOf(nodes: readonly NodeMeta[], id: string): number {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	let depth = 0;
	let current = byId.get(id);
	const seen = new Set<string>();
	while (current?.parentId && !seen.has(current.id)) {
		seen.add(current.id);
		current = byId.get(current.parentId);
		if (current) depth++;
	}
	return depth;
}

/** Every node in the tree rooted at `rootId`, parents before children. */
export function treeOf(nodes: readonly NodeMeta[], rootId: string): NodeMeta[] {
	const out: NodeMeta[] = [];
	const visit = (id: string): void => {
		const node = nodes.find((candidate) => candidate.id === id);
		if (!node || out.includes(node)) return;
		out.push(node);
		for (const child of childrenOf(nodes, id)) visit(child.id);
	};
	visit(rootId);
	return out;
}

/** The sessions a node is still waiting for before it starts: those it names that have not sent their result. */
export function waitingFor(nodes: readonly NodeMeta[], node: Pick<NodeMeta, "waitsOn">): NodeMeta[] {
	return (node.waitsOn ?? []).flatMap((id) => nodes.filter((candidate) => candidate.id === id && !candidate.done));
}

const PLUMBING = new Set(["protocol", "reporting"]);

/** What a session is there to do: the last role it was given that is about the work, or its name. */
export function roleOf(node: Pick<NodeMeta, "fragments" | "name">): string {
	return node.fragments.filter((name) => !PLUMBING.has(name)).at(-1) ?? node.name;
}

/** Whether a node is planned work that nobody has been put on yet. */
export const isPlanned = (node: Pick<NodeMeta, "planned">): boolean => node.planned === true;

/** Whether a node has yet to be given its brief: because it waits on others, or because it is only planned. */
export const isHeld = (node: Pick<NodeMeta, "waitsOn" | "planned">): boolean => (node.waitsOn?.length ?? 0) > 0 || isPlanned(node);

/**
 * The session a node answers to: its nearest ancestor that has one. Planned items above it are
 * passed over, because there is nobody there to read a report.
 */
export function reportsTo(nodes: readonly NodeMeta[], node: Pick<NodeMeta, "parentId">): NodeMeta | undefined {
	const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
	const seen = new Set<string>();
	let above = node.parentId ? byId.get(node.parentId) : undefined;
	while (above && isPlanned(above) && above.parentId && !seen.has(above.id)) {
		seen.add(above.id);
		above = byId.get(above.parentId);
	}
	return above;
}

/** A node's ancestors, nearest first. Stops at a missing parent or a cycle. */
export function ancestorsOf(nodes: readonly NodeMeta[], id: string): NodeMeta[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const out: NodeMeta[] = [];
	let current = byId.get(id);
	while (current?.parentId) {
		current = byId.get(current.parentId);
		if (!current || out.includes(current)) break;
		out.push(current);
	}
	return out;
}

export interface TreeLine {
	node: NodeMeta;
	depth: number;
	/** Box-drawing prefix for this row. */
	prefix: string;
}

/** Rows of a tree view, in display order. */
export function treeLines(nodes: readonly NodeMeta[]): TreeLine[] {
	const lines: TreeLine[] = [];
	const ids = new Set(nodes.map((node) => node.id));
	const roots = nodes
		.filter((node) => node.parentId === null || !ids.has(node.parentId))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const visit = (node: NodeMeta, depth: number, indent: string, last: boolean): void => {
		lines.push({ node, depth, prefix: depth === 0 ? "" : `${indent}${last ? "└─ " : "├─ "}` });
		const children = childrenOf(nodes, node.id);
		children.forEach((child, index) => {
			visit(child, depth + 1, depth === 0 ? "" : `${indent}${last ? "   " : "│  "}`, index === children.length - 1);
		});
	};
	for (const root of roots) visit(root, 0, "", true);
	return lines;
}

/** A plain-text tree for tool results and logs. */
export function formatTree(nodes: readonly NodeMeta[], options: { self?: string } = {}): string {
	return treeLines(nodes)
		.map(({ node, prefix }) => {
			const parts = [`${prefix}${node.name}`, `[${node.kind}]`, node.id, node.status];
			if (node.fragments.length > 0) parts.push(`roles=${node.fragments.join("+")}`);
			if (node.branch) parts.push(`branch=${node.branch}`);
			if (isPlanned(node)) parts.push("planned");
			if ((node.waitsOn?.length ?? 0) > 0) parts.push(`waits-on=${(node.waitsOn ?? []).map((id) => nodes.find((other) => other.id === id)?.name ?? id).join("+")}`);
			if (node.id === options.self) parts.push("(you)");
			return parts.join("  ");
		})
		.join("\n");
}
