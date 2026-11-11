/**
 * The host's full-screen interface: the session tree beside the conversation of whichever
 * node is attached, with an editor that talks to that node. This is the host's own UI; it
 * does not rely on Pi's interactive mode (ADR 0006).
 */
import { getAgentDir, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component, Container, Editor, getNativeClipboard, HStack, matchesKey, type OverlayHandle, ProcessTerminal, ScrollView,
	stripTerminalSequences, type Terminal, truncateToWidth, TuiAltScreen, VStack,
} from "@earendil-works/pi-tui";
import type { CollabSession } from "@pi-lattice/collab";
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
	/** The node attached at start, if there is one yet. */
	rootId: string | undefined;
	/** Present when the tree is shared with other people. */
	collab?: CollabSession;
	/** Defaults to the process terminal. Tests pass a fake. */
	terminal?: Terminal;
	/** Copies text to the clipboard; resolves true on success. Defaults to the system clipboard. */
	clipboard?: (text: string) => Promise<boolean>;
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
		this.current = options.rootId ?? "";
		this.selected = options.rootId ?? "";
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
		if (this.host.node(this.current)) this.attach(this.current);
		else {
			const first = this.host.nodes()[0];
			if (first) this.attach(first.id);
			else {
				const empty = new Transcript(this.tui, process.cwd());
				empty.placeholder(this.options.collab ? "No sessions yet. Press ctrl+o to pair with someone or show your invite." : "No sessions yet.");
				this.holder.addChild(empty.container);
			}
		}
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
		on("session", (nodeId: string, event: RpcRecord, seq: number) => {
			if (this.transcripts.get(nodeId)?.handle(event, seq) && nodeId === this.current) this.render();
		});
		on("log", (level: string, message: string) => {
			if (level !== "info") this.flash(message);
		});
		const collab = this.options.collab;
		if (collab) {
			const changed = (): void => {
				const node = this.host.node(this.current);
				if (node && node.owner !== this.host.owner && !this.transcripts.get(node.id)?.loaded) void this.loadRemote(node.id, node.owner);
				this.render();
			};
			const log = (_level: string, message: string): void => this.flash(message);
			collab.on("changed", changed);
			collab.on("log", log);
			this.unsubscribe.push(() => collab.off("changed", changed), () => collab.off("log", log));
		}
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
		const collab = this.options.collab;
		const offlineOwners = new Set(nodes.map((node) => node.owner).filter((owner) => owner !== this.host.owner && !collab?.isOnline(owner)));
		return { nodes, selected: this.selected, current: this.current, focused: this.treeFocused, localOwner: this.host.owner, attention, offlineOwners };
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
		const collab = this.options.collab;
		if (collab) {
			for (const person of collab.people()) {
				if (person.trust === "unknown") lines.push(yellow(` ${person.name} wants to connect; pair with them to allow it (ctrl+o)`));
				if (person.trust === "changed") lines.push(red(` Someone tried to connect as ${person.name} with a different key (ctrl+o)`));
			}
			for (const handoff of collab.handoffs()) {
				if (handoff.role === "recipient" && handoff.state === "offered") lines.push(yellow(` ${handoff.from} offers you "${handoff.nodeName}" (ctrl+o)`));
				if (handoff.role === "owner" && handoff.state === "accepted") lines.push(yellow(` ${handoff.to} accepted "${handoff.nodeName}"; confirm the release (ctrl+o)`));
			}
			for (const pending of collab.pendingTransfers()) {
				lines.push(yellow(` "${this.host.node(pending.nodeId)?.name ?? pending.nodeId}" is released to ${pending.to} and will reach them when they are next online`));
			}
		}
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
			: `ctrl+t tree · ctrl+n new child · ctrl+a approvals${this.options.collab ? " · ctrl+o sharing" : ""} · ctrl+c stop/quit`;
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
		const owner = this.host.node(id)?.owner;
		if (owner !== undefined && owner !== this.host.owner) {
			void this.loadRemote(id, owner);
		} else if (this.host.isRunning(id)) {
			if (!transcript.loaded) void this.loadTranscript(id);
		} else if (!transcript.loaded) {
			transcript.placeholder("This session is asleep. Send it a message to wake it.");
		}
		this.presentDialogs();
		this.render();
	}

	/** Show another person's session, read-only: fetched from them while they are online. */
	private async loadRemote(id: string, owner: string): Promise<void> {
		const transcript = this.transcript(id);
		const collab = this.options.collab;
		if (!collab?.isOnline(owner)) {
			if (!transcript.loaded) transcript.placeholder(`This session is owned by ${owner}, who is offline. It will be readable when they are back.`);
			this.render();
			return;
		}
		if (this.loading.has(id)) return;
		this.loading.add(id);
		try {
			if (!transcript.loaded) transcript.placeholder(`Fetching this session from ${owner}...`);
			this.render();
			transcript.load((await collab.fetchMessages(id)) as RpcRecord[]);
			transcript.notice(`Read-only: this session is owned by ${owner} and runs on their machine.`);
		} catch (error) {
			transcript.placeholder(`Could not fetch this session from ${owner}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.loading.delete(id);
			this.render();
		}
	}

	private async loadTranscript(id: string): Promise<void> {
		if (this.loading.has(id)) return;
		this.loading.add(id);
		const transcript = this.transcript(id);
		try {
			// Hold live events while the snapshot is in flight, then apply exactly those that came after it.
			transcript.beginLoad();
			const { data, mark } = await this.host.rpcMarked<{ messages: RpcRecord[] }>(id, { type: "get_messages" });
			transcript.load(data.messages, mark);
		} catch {
			transcript.abandonLoad();
			// The session went away while loading; the next status change retries.
		} finally {
			this.loading.delete(id);
			this.render();
		}
	}

	private onNode(node: NodeMeta): void {
		const transcript = this.transcripts.get(node.id);
		if (transcript && node.owner === this.host.owner) {
			const live = node.status === "idle" || node.status === "running" || node.status === "blocked";
			if (!live) transcript.loaded = false;
			else if (!transcript.loaded && node.id === this.current && this.host.isRunning(node.id)) void this.loadTranscript(node.id);
		}
		if (!this.host.node(this.current)) {
			// The first session has appeared (for example after trusting a collaborator): open it.
			this.attach(node.id);
			return;
		}
		if (node.id === this.current && node.owner !== this.host.owner) this.attach(node.id); // just handed off: show it as theirs
		if (!this.host.node(this.selected)) this.selected = this.current;
		this.render();
	}

	private submit(text: string): void {
		const message = text.trim();
		this.editor.setText("");
		if (message === "") return;
		if (!this.host.node(this.current)) {
			this.flash("There is no session to talk to yet.");
			return;
		}
		this.editor.addToHistory(message);
		const id = this.current;
		this.host.prompt(id, message, "steer").then(
			() => {
				if (!this.transcript(id).loaded) void this.loadTranscript(id);
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

	/** Everything about sharing in one place: pair with people, and move nodes between owners. */
	async sharingFlow(): Promise<void> {
		const collab = this.options.collab;
		if (!collab) {
			this.flash("This tree is not shared. Start pi-lattice with --listen <port>.");
			return;
		}
		const choices: Choice[] = [];
		for (const handoff of collab.handoffs()) {
			const node = `"${handoff.nodeName}"`;
			if (handoff.role === "recipient" && handoff.state === "offered") {
				choices.push({ value: `accept ${handoff.nodeId}`, label: `Accept ${node} from ${handoff.from}`, description: "you take it over once they confirm" });
				choices.push({ value: `cancel ${handoff.nodeId}`, label: `Decline ${node}` });
			} else if (handoff.role === "owner" && handoff.state === "accepted") {
				choices.push({ value: `confirm ${handoff.nodeId}`, label: `Confirm release of ${node} to ${handoff.to}`, description: "this is the step that gives it up" });
				choices.push({ value: `cancel ${handoff.nodeId}`, label: `Cancel the handoff of ${node}` });
			} else {
				choices.push({ value: `cancel ${handoff.nodeId}`, label: `Cancel the handoff of ${node}`, description: handoff.role === "owner" ? `waiting for ${handoff.to} to accept` : `waiting for ${handoff.from} to confirm` });
			}
		}
		for (const person of collab.people()) {
			if (person.trust === "unknown") choices.push({ value: `trust ${person.name}`, label: `Pair with ${person.name}`, description: "they tried to connect" });
			if (person.trust === "changed") choices.push({ value: `trust ${person.name}`, label: `Accept ${person.name}'s new key`, description: "their key has CHANGED" });
		}
		const target = this.host.node(this.treeFocused ? this.selected : this.current);
		if (target && target.owner === this.host.owner) choices.push({ value: `offer ${target.id}`, label: `Offer "${target.name}" to someone` });
		choices.push({ value: "invite", label: "Show my invite", description: "give it to someone so they can pair with you" });
		choices.push({ value: "add", label: "Pair using someone's invite" });
		choices.push({ value: "people", label: "Who is here", description: collab.people().filter((person) => !person.self).map((person) => `${person.name} ${person.online ? "online" : "offline"}`).join(", ") || "nobody yet" });
		choices.push({ value: "refresh", label: "Refresh from everyone online" });

		const picked = await this.askSelect("Sharing", `You are ${this.host.owner}. Sharing is direct between machines: people who are offline are greyed out.`, choices);
		if (picked === undefined) return;
		const [action, arg = ""] = picked.split(" ");
		if (action === "refresh") await collab.refresh();
		else if (action === "accept") await collab.accept(arg);
		else if (action === "cancel") await collab.cancel(arg);
		else if (action === "invite") {
			const invite = collab.invite();
			const copy = this.options.clipboard ?? (async (text: string): Promise<boolean> => {
				const clipboard = getNativeClipboard();
				if (!clipboard?.setText) return false;
				await clipboard.setText(text);
				return true;
			});
			const copied = await copy(invite).catch(() => false);
			await this.askSelect(
				"Your invite",
				`${invite}\n\n${copied ? "Copied to the clipboard. " : ""}Send this to the person you want to work with, over a channel you trust. It names this machine's address and your key. They pair with it; then you pair with them when they connect.`,
				[{ value: "ok", label: "Done" }],
			);
		} else if (action === "add") {
			const invite = await this.askInput("Pair using an invite", "Paste the invite the other person gave you.", { placeholder: "name@host:port#key" });
			if (invite) this.flash(`Paired with ${await collab.addInvite(invite)}.`);
		} else if (action === "people") {
			const lines = collab.people().map((person) => `${person.name}${person.self ? " (you)" : ""}  ${person.self ? "" : person.online ? "online" : "offline"}  ${person.fingerprint}`);
			await this.askSelect("Who is here", lines.join("\n"), [{ value: "ok", label: "Done" }]);
		} else if (action === "trust") {
			const person = collab.people().find((candidate) => candidate.name === arg);
			if (!person) return;
			const sure = await this.askSelect(
				`Pair with ${person.name}?`,
				`Key fingerprint:\n\n  ${person.fingerprint}\n\nCompare it with ${person.name} over a channel you already trust (in person, a call). Once paired, their sessions appear in your tree and their agents can send your agents mail, which still waits for your approval.${person.trust === "changed" ? "\n\nThis key is DIFFERENT from the one you paired with before. Only continue if they told you they replaced it." : ""}`,
				[{ value: "no", label: "Not yet" }, { value: "yes", label: "The fingerprint matches; pair" }],
			);
			if (sure === "yes") await collab.trustPerson(person.name);
		} else if (action === "confirm") {
			const node = this.host.node(arg);
			const sure = await this.askSelect(
				`Release "${node?.name ?? arg}"?`,
				"This stops the session here and sends its whole conversation, including any file contents and command output in it, directly to the new owner, together with its branch if it has one. After this you can no longer run it.",
				[{ value: "no", label: "Not now" }, { value: "yes", label: "Release it" }],
			);
			if (sure === "yes") await collab.confirm(arg);
		} else if (action === "offer") {
			const paired = collab.people().filter((person) => !person.self && person.trust === "trusted");
			if (paired.length === 0) {
				this.flash("You have not paired with anyone yet.");
				return;
			}
			const to = await this.askSelect("Offer to whom?", "They must accept, and you must then confirm, before ownership moves. Both of you need to be online for those steps.", paired.map((person) => ({ value: person.name, label: person.name, description: person.online ? "online" : "offline" })));
			if (to !== undefined) await collab.offer(arg, to);
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
		if (matchesKey(data, "ctrl+o")) {
			this.run(this.sharingFlow());
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
		else if (data === "o") this.run(this.sharingFlow());
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
