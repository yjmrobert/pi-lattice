/**
 * The host's full-screen interface: the session tree beside the conversation of whichever
 * node is attached, with an editor that talks to that node. This is the host's own UI; it
 * does not rely on Pi's interactive mode (ADR 0006).
 */
import { getAgentDir, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component, Container, Editor, HStack, matchesKey, type OverlayHandle, ProcessTerminal, ScrollView,
	stripTerminalSequences, type Terminal, truncateToWidth, TuiAltScreen, VStack,
} from "@earendil-works/pi-tui";
import { type NodeMeta, treeLines, WORKSPACE_MODES, type WorkspaceMode } from "@pi-lattice/protocol";
import { fragmentRoots, loadFragments } from "@pi-lattice/roles";
import type { Dialog, LatticeHost } from "../host.ts";
import type { RpcRecord } from "../pi-process.ts";
import { type Choice, inputModal, type Modal, multiSelectModal, selectModal } from "./modal.ts";
import { bold, dim, red, statusBadge, yellow } from "./style.ts";
import { Transcript } from "./transcript.ts";
import { TreePanel, type TreeViewState } from "./tree-panel.ts";

export interface TreeAppOptions {
	host: LatticeHost;
	/** The node attached at start. */
	rootId: string;
	/** Defaults to the process terminal. Tests pass a fake. */
	terminal?: Terminal;
	/** Role fragments offered when spawning. Defaults to the user's and the built-in fragments. */
	fragments?: () => Choice[];
}

type LayoutViewport = { width: number; height: number };

/** A component whose lines are computed on every render. */
class Lines implements Component {
	private readonly compute: (width: number) => string[];
	constructor(compute: (width: number) => string[]) {
		this.compute = compute;
	}
	render(width: number): string[] {
		return this.compute(width).map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
}

const WIDE = 100;
const QUIT_WINDOW_MS = 2000;

export class TreeApp {
	readonly tui: TuiAltScreen;
	/** The node whose conversation is shown and that the editor talks to. */
	current: string;
	/** The node the tree cursor is on. */
	selected: string;
	treeFocused = false;
	/** Resolves when the user quits. */
	readonly done: Promise<void>;

	private readonly host: LatticeHost;
	private readonly options: TreeAppOptions;
	private readonly transcripts = new Map<string, Transcript>();
	private readonly loading = new Set<string>();
	private readonly holder = new Container();
	private readonly root: VStack;
	private readonly treePanel: TreePanel;
	private readonly editor: Editor;
	private modal: { component: Modal; handle: OverlayHandle } | undefined;
	private asking: Promise<unknown> = Promise.resolve();
	private presentingDialogs = false;
	private flashText = "";
	private flashTimer: NodeJS.Timeout | undefined;
	private lastInterrupt = 0;
	private stopped = false;
	private finish!: () => void;
	private readonly unsubscribe: Array<() => void> = [];

	constructor(options: TreeAppOptions) {
		this.options = options;
		this.host = options.host;
		this.current = options.rootId;
		this.selected = options.rootId;
		this.done = new Promise<void>((resolve) => {
			this.finish = resolve;
		});
		initTheme(undefined, false);
		this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal());

		this.editor = new Editor(this.tui, { borderColor: dim, selectList: getSelectListTheme() });
		this.editor.onSubmit = (text) => this.submit(text);

		const state = (): TreeViewState => this.treeState();
		const wide = (viewport: LayoutViewport): boolean => viewport.width >= WIDE;
		const scroll = new ScrollView(this.holder, { follow: "end", primary: true, overscroll: "chain" });
		this.treePanel = new TreePanel(state);
		this.root = new VStack([
			{ component: new Lines(() => [this.headerLine()]), basis: "auto" },
			{ component: this.treePanel, basis: "auto", maxSize: 10, visible: (viewport) => !wide(viewport) },
			{
				component: new HStack([
					{ component: new TreePanel(state), basis: 40, shrink: 0, visible: wide },
					{ component: scroll, basis: 0, grow: 1, minSize: 10 },
				]),
				basis: 0, grow: 1, minSize: 3,
			},
			{ component: new Lines(() => this.attentionLines()), basis: "auto" },
			{ component: this.editor, basis: "auto", shrink: 1, minSize: 3 },
			{ component: new Lines(() => [this.footerLine()]), basis: "auto" },
		]);
		this.tui.setLayoutRoot(this.root);
		this.tui.setFocus(this.editor);
		this.unsubscribe.push(this.tui.addInputListener((data) => this.onKey(data)));
		this.listen();
	}

	// --- lifecycle -------------------------------------------------------------

	start(): void {
		this.tui.start();
		this.attach(this.current);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const off of this.unsubscribe) off();
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.host.unpin(this.current);
		this.tui.stop();
		this.finish();
	}

	private listen(): void {
		const on = <K extends "node" | "dialog" | "mail" | "session" | "log" | "envelope">(name: K, handler: (...args: never[]) => void): void => {
			this.host.on(name, handler as never);
			this.unsubscribe.push(() => this.host.off(name, handler as never));
		};
		on("node", (node: NodeMeta) => this.onNode(node));
		on("dialog", (nodeId: string) => {
			if (nodeId === this.current) this.presentDialogs();
			this.render();
		});
		on("mail", () => this.render());
		on("envelope", () => this.render());
		on("session", (nodeId: string, event: RpcRecord) => {
			if (this.transcripts.get(nodeId)?.handle(event) && nodeId === this.current) this.render();
		});
		on("log", (level: string, message: string) => {
			if (level !== "info") this.flash(message);
		});
	}

	private render(): void {
		if (!this.stopped) this.tui.requestRender();
	}

	// --- view state ------------------------------------------------------------

	private treeState(): TreeViewState {
		const attention = new Map<string, { dialogs: number; pending: number }>();
		const bump = (id: string, key: "dialogs" | "pending", by: number): void => {
			const entry = attention.get(id) ?? { dialogs: 0, pending: 0 };
			entry[key] += by;
			attention.set(id, entry);
		};
		const nodes = this.host.nodes();
		for (const node of nodes) {
			const dialogs = this.host.dialogs(node.id).length;
			if (dialogs > 0) bump(node.id, "dialogs", dialogs);
		}
		for (const record of this.host.pendingMail()) bump(record.recipient, "pending", 1);
		return { nodes, selected: this.selected, current: this.current, focused: this.treeFocused, localOwner: this.host.owner, attention };
	}

	private headerLine(): string {
		const nodes = this.host.nodes();
		const count = (status: string): number => nodes.filter((node) => node.status === status).length;
		const parts = [`${nodes.length} session${nodes.length === 1 ? "" : "s"}`];
		if (count("running") > 0) parts.push(`${count("running")} running`);
		if (count("blocked") > 0) parts.push(red(`${count("blocked")} blocked`));
		return `${bold(" pi-lattice")} ${dim(`· ${parts.join(" · ")}`)}`;
	}

	private attentionLines(): string[] {
		const lines: string[] = [];
		const { attention } = this.treeState();
		const elsewhere = [...attention.entries()].filter(([id, entry]) => id !== this.current && entry.dialogs > 0);
		if (elsewhere.length > 0) {
			lines.push(red(` Waiting on you: ${elsewhere.map(([id]) => this.host.node(id)?.name ?? id).join(", ")} (ctrl+t, select, enter)`));
		}
		const pending = this.host.pendingMail().length;
		if (pending > 0) lines.push(yellow(` ${pending} message${pending === 1 ? "" : "s"} waiting for approval (ctrl+a)`));
		if (this.flashText) lines.push(dim(` ${this.flashText}`));
		return lines;
	}

	private footerLine(): string {
		const node = this.host.node(this.current);
		const where = node
			? `${statusBadge(node.status)} ${bold(node.name)} ${dim(`${node.kind} · ${node.status}${node.fragments.length > 0 ? ` · ${node.fragments.join("+")}` : ""}${node.branch ? ` · ${node.branch}` : ""}`)}`
			: "";
		const keys = this.treeFocused
			? "↑↓ move · enter open · n new child · s sleep · a approvals · esc back"
			: "ctrl+t tree · ctrl+n new child · ctrl+a approvals · ctrl+c stop/quit";
		return ` ${where}  ${dim(keys)}`;
	}

	private flash(text: string): void {
		this.flashText = text.split("\n")[0] ?? "";
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => {
			this.flashText = "";
			this.render();
		}, 8000);
		this.flashTimer.unref();
		this.render();
	}

	// --- conversations ---------------------------------------------------------

	private transcript(id: string): Transcript {
		let transcript = this.transcripts.get(id);
		if (!transcript) {
			transcript = new Transcript(this.tui, this.host.node(id)?.cwd ?? process.cwd());
			this.transcripts.set(id, transcript);
		}
		return transcript;
	}

	/** Show a node's conversation and direct the editor at it. Does not wake a sleeping node. */
	attach(id: string): void {
		if (!this.host.node(id)) return;
		this.host.unpin(this.current);
		this.current = id;
		this.selected = id;
		this.host.pin(id);
		const transcript = this.transcript(id);
		this.holder.clear();
		this.holder.addChild(transcript.container);
		if (this.host.isRunning(id)) {
			if (!transcript.loaded) void this.loadTranscript(id);
		} else if (!transcript.loaded) {
			transcript.placeholder("This session is asleep. Send it a message to wake it.");
		}
		this.presentDialogs();
		this.render();
	}

	private async loadTranscript(id: string): Promise<void> {
		if (this.loading.has(id)) return;
		this.loading.add(id);
		try {
			const { messages } = await this.host.rpc<{ messages: RpcRecord[] }>(id, { type: "get_messages" });
			this.transcript(id).load(messages);
		} catch {
			// The session went away while loading; the next status change retries.
		} finally {
			this.loading.delete(id);
			this.render();
		}
	}

	private onNode(node: NodeMeta): void {
		const transcript = this.transcripts.get(node.id);
		if (transcript) {
			const live = node.status === "idle" || node.status === "running" || node.status === "blocked";
			if (!live) transcript.loaded = false;
			else if (!transcript.loaded && node.id === this.current && this.host.isRunning(node.id)) void this.loadTranscript(node.id);
		}
		if (!this.host.node(this.selected)) this.selected = this.current;
		this.render();
	}

	private submit(text: string): void {
		const message = text.trim();
		this.editor.setText("");
		if (message === "") return;
		this.editor.addToHistory(message);
		const id = this.current;
		const wasLoaded = this.transcript(id).loaded;
		this.host.prompt(id, message, "steer").then(
			() => {
				if (!wasLoaded) void this.loadTranscript(id);
			},
			(error: unknown) => this.flash(error instanceof Error ? error.message : String(error)),
		);
		this.render();
	}

	// --- modals ----------------------------------------------------------------

	/** The modal currently shown, if any. Exposed for tests. */
	get activeModal(): Modal | undefined {
		return this.modal?.component;
	}

	/** Show one modal at a time and resolve with its result. */
	private ask<T>(build: (done: (value: T) => void) => Modal): Promise<T> {
		const next = this.asking.then(
			() =>
				new Promise<T>((resolve) => {
					if (this.stopped) return;
					const component = build((value) => {
						this.modal?.handle.hide();
						this.modal = undefined;
						this.tui.setFocus(this.editor);
						this.render();
						resolve(value);
					});
					const handle = this.tui.showOverlay(component, { width: "70%", minWidth: 40, maxHeight: "80%" });
					this.modal = { component, handle };
					this.render();
				}),
		);
		this.asking = next.catch(() => {});
		return next;
	}

	private askInput(title: string, message: string, options: { placeholder?: string; initial?: string } = {}): Promise<string | undefined> {
		return this.ask<string | undefined>((done) => inputModal(title, message, options, done));
	}

	private askSelect(title: string, message: string, choices: readonly Choice[]): Promise<string | undefined> {
		return this.ask<string | undefined>((done) => selectModal(title, message, choices, done));
	}

	/** Put every dialog blocking the attached node in front of the human, one at a time. */
	private presentDialogs(): void {
		if (this.presentingDialogs) return;
		this.presentingDialogs = true;
		void (async () => {
			try {
				for (;;) {
					const id = this.current;
					const dialog = this.host.dialogs(id)[0];
					if (!dialog || this.stopped) return;
					const answer = await this.askDialog(this.host.node(id)?.name ?? id, dialog);
					try {
						this.host.answerDialog(id, dialog.id, answer);
					} catch {
						// The session answered it another way, or went away.
					}
				}
			} finally {
				this.presentingDialogs = false;
			}
		})();
	}

	private async askDialog(nodeName: string, dialog: Dialog): Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }> {
		const title = `${nodeName} asks: ${dialog.title}`;
		const message = dialog.message ?? "";
		if (dialog.method === "confirm") {
			const choice = await this.askSelect(title, message, [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
			return choice === undefined ? { cancelled: true } : { confirmed: choice === "yes" };
		}
		if (dialog.method === "select") {
			const choice = await this.askSelect(title, message, (dialog.options ?? []).map((option) => ({ value: option, label: option })));
			return choice === undefined ? { cancelled: true } : { value: choice };
		}
		const text = await this.askInput(title, message, {
			...(dialog.placeholder !== undefined ? { placeholder: dialog.placeholder } : {}),
			...(dialog.prefill !== undefined ? { initial: dialog.prefill } : {}),
		});
		return text === undefined ? { cancelled: true } : { value: text };
	}

	private fragmentChoices(): Choice[] {
		if (this.options.fragments) return this.options.fragments();
		const roots = fragmentRoots({ cwd: this.host.node(this.current)?.cwd ?? process.cwd(), agentDir: getAgentDir(), projectTrusted: false });
		return [...loadFragments(roots).values()].map((fragment) => ({ value: fragment.name, label: fragment.name, description: fragment.summary }));
	}

	/** Walk the human through creating a child under a node. */
	async spawnFlow(parentId: string): Promise<void> {
		const parent = this.host.node(parentId);
		if (!parent) return;
		const name = (await this.askInput("New child session", `Under "${parent.name}". What should it be called?`, { placeholder: "name" }))?.trim();
		if (!name) return;
		const kind = (await this.askInput("Kind", "A free-form label for the kind of work.", { initial: "task" }))?.trim();
		if (kind === undefined) return;
		const fragments = await this.ask<string[] | undefined>((done) => multiSelectModal("Roles", "Role fragments for the child, applied in the order you pick them.", this.fragmentChoices(), [], done));
		if (fragments === undefined) return;
		const workspace = await this.askSelect("Workspace", "Where should the child work?", [
			{ value: "shared", label: "shared", description: "the parent's directory" },
			{ value: "worktree", label: "worktree", description: "its own git worktree and branch" },
		]);
		if (workspace === undefined || !(WORKSPACE_MODES as readonly string[]).includes(workspace)) return;
		const brief = (await this.askInput("Brief", "What should it do? It sees only this text.", { placeholder: "brief" }))?.trim();
		if (!brief) return;
		try {
			const node = await this.host.spawnChild(parentId, { name, brief, kind: kind || "task", fragments, workspace: workspace as WorkspaceMode });
			this.selected = node.id;
			this.flash(`Created "${node.name}".`);
		} catch (error) {
			this.flash(error instanceof Error ? error.message : String(error));
		}
	}

	/** Let the human approve or reject mail held anywhere in the tree. */
	async approvalsFlow(): Promise<void> {
		for (;;) {
			if (this.stopped) return;
			const pending = this.host.pendingMail();
			if (pending.length === 0) {
				this.flash("Nothing is waiting for approval.");
				return;
			}
			const name = (id: string): string => this.host.node(id)?.name ?? id;
			const picked = await this.askSelect(
				"Messages waiting for approval",
				"Nothing here reaches an agent until you approve it.",
				pending.map((record) => ({
					value: `${record.recipient} ${record.envelope.id}`,
					label: `${name(record.envelope.from)} → ${name(record.recipient)}`,
					description: record.envelope.payload.text.replace(/\s+/g, " ").slice(0, 80),
				})),
			);
			if (picked === undefined) return;
			const record = pending.find((candidate) => `${candidate.recipient} ${candidate.envelope.id}` === picked);
			if (!record) continue;
			const action = await this.askSelect(
				`${name(record.envelope.from)} (${record.envelope.fromOwner}) → ${name(record.recipient)}`,
				record.envelope.payload.text,
				[{ value: "approve", label: "Approve", description: "deliver it to the agent" }, { value: "reject", label: "Reject", description: "the agent never sees it" }, { value: "later", label: "Decide later" }],
			);
			if (action === "approve" || action === "reject") {
				try {
					await this.host.decideMail(record.recipient, record.envelope.id, action);
					await new Promise((resolve) => setTimeout(resolve, 150));
				} catch (error) {
					this.flash(error instanceof Error ? error.message : String(error));
					return;
				}
			} else return;
		}
	}

	// --- keys ------------------------------------------------------------------

	/** Run a user-initiated flow in the background; a failure becomes a notice, never a crash. */
	private run(flow: Promise<void>): void {
		flow.catch((error: unknown) => {
			if (!this.stopped) this.flash(error instanceof Error ? error.message : String(error));
		});
	}

	private moveSelection(delta: number): void {
		const order = treeLines(this.host.nodes()).map((line) => line.node.id);
		if (order.length === 0) return;
		const at = Math.max(0, order.indexOf(this.selected));
		this.selected = order[Math.min(order.length - 1, Math.max(0, at + delta))] ?? this.selected;
		this.render();
	}

	private interrupt(): void {
		const node = this.host.node(this.current);
		if (node?.status === "running") {
			void this.host.abort(this.current).catch(() => {});
			this.flash("Stopping the agent's current work.");
			return;
		}
		const now = Date.now();
		if (now - this.lastInterrupt < QUIT_WINDOW_MS) {
			this.stop();
			return;
		}
		this.lastInterrupt = now;
		this.flash("Press ctrl+c again to quit. Sessions are saved and resume next time.");
	}

	private onKey(data: string): { consume?: boolean } | undefined {
		if (this.modal) return undefined; // the modal has focus
		const consumed = { consume: true };
		if (matchesKey(data, "ctrl+c")) {
			this.interrupt();
			return consumed;
		}
		if (matchesKey(data, "ctrl+d") && this.editor.getText() === "") {
			this.stop();
			return consumed;
		}
		if (matchesKey(data, "ctrl+t")) {
			this.treeFocused = !this.treeFocused;
			if (!this.treeFocused) this.selected = this.current;
			this.render();
			return consumed;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.run(this.spawnFlow(this.treeFocused ? this.selected : this.current));
			return consumed;
		}
		if (matchesKey(data, "ctrl+a")) {
			this.run(this.approvalsFlow());
			return consumed;
		}
		if (matchesKey(data, "alt+up") || matchesKey(data, "alt+down")) {
			this.selected = this.current;
			this.moveSelection(matchesKey(data, "alt+up") ? -1 : 1);
			this.attach(this.selected);
			return consumed;
		}
		if (!this.treeFocused) return undefined; // the editor handles it

		if (matchesKey(data, "up") || data === "k") this.moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.moveSelection(1);
		else if (matchesKey(data, "enter")) {
			this.treeFocused = false;
			this.attach(this.selected);
		} else if (matchesKey(data, "escape")) {
			this.treeFocused = false;
			this.selected = this.current;
			this.render();
		} else if (data === "n") this.run(this.spawnFlow(this.selected));
		else if (data === "a") this.run(this.approvalsFlow());
		else if (data === "s") void this.host.sleep(this.selected).catch(() => {});
		return consumed;
	}

	// --- test support ----------------------------------------------------------

	/**
	 * The interface's content as plain text: header, tree, conversation, notices, editor,
	 * footer and any open modal, stacked. Independent of the terminal's size and layout.
	 */
	text(width = 120): string {
		const lines = [
			this.headerLine(),
			...this.treePanel.render(width),
			...this.holder.render(width),
			...this.attentionLines(),
			...this.editor.render(width),
			this.footerLine(),
			...(this.modal ? this.modal.component.render(Math.min(width, 80)) : []),
		];
		return lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
	}
}
