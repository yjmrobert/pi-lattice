/** The session tree as a panel: one row per node with status, kind, owner and attention badges. */
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { type NodeMeta, treeLines } from "@pi-lattice/protocol";
import { bold, cyan, dim, inverse, red, statusBadge, yellow } from "./style.ts";

export interface TreeViewState {
	nodes: readonly NodeMeta[];
	/** The node the cursor is on. */
	selected: string | undefined;
	/** The node whose conversation is shown. */
	current: string | undefined;
	/** Whether the tree has keyboard focus. */
	focused: boolean;
	/** The owner this host acts as; other owners get a badge. */
	localOwner: string;
	/** Per node: how many dialogs block it and how many messages await approval. */
	attention: ReadonlyMap<string, { dialogs: number; pending: number }>;
}

/** Render the tree rows. Pure, so it is tested without a terminal. */
export function renderTreeRows(state: TreeViewState, width: number): string[] {
	const rows = treeLines(state.nodes).map(({ node, prefix }) => {
		const attention = state.attention.get(node.id);
		const marks = [
			attention?.dialogs ? red(`? ${attention.dialogs}`) : "",
			attention?.pending ? yellow(`✉ ${attention.pending}`) : "",
			node.owner !== state.localOwner ? cyan(`@${node.owner}`) : "",
		].filter(Boolean);
		const name = node.id === state.current ? bold(node.name) : node.name;
		const body = `${dim(prefix)}${statusBadge(node.status)} ${name} ${dim(node.kind)}${marks.length > 0 ? ` ${marks.join(" ")}` : ""}`;
		const cursor = node.id === state.selected ? (state.focused ? "›" : dim("›")) : " ";
		const line = truncateToWidth(`${cursor} ${body}`, width);
		return node.id === state.selected && state.focused ? inverse(line) : line;
	});
	return rows.length > 0 ? rows : [dim("  (no sessions)")];
}

export class TreePanel implements Component {
	private readonly getState: () => TreeViewState;
	private readonly title: string;

	constructor(getState: () => TreeViewState, title = "Sessions") {
		this.getState = getState;
		this.title = title;
	}

	render(width: number): string[] {
		const state = this.getState();
		const heading = truncateToWidth(state.focused ? bold(` ${this.title}`) : dim(` ${this.title}`), width);
		return [heading, ...renderTreeRows(state, width)];
	}

	invalidate(): void {}
}
