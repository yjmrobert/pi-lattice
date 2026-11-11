/**
 * pi-lattice pane: the session trees inside Pi.
 *
 * Shows a left pane listing what is waiting on the person and the sessions of every repository
 * they have work in, and lets them open any of them in this terminal. Each repository's tree
 * lives in its own background host, started on demand; opening a session takes it over from
 * its host, and leaving it hands it back. See ADR 0013 and ADR 0015.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, matchesKey, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { emitEvent, formatSetting, type HostAssignment, isTemplateName, renderTemplate, TEMPLATE_NAMES, TEMPLATES, type HostClient, type KnownTree, type NodeMeta, numberSetting, onEvent, parseSettingInput, SETTINGS, type SettingScope, settingAccepts, settingOf, type SharingTree, textSetting, toggleSetting, type UiState } from "@pi-lattice/protocol";
import { type ChildForm, type FormKey, formKey, newChildForm, renderForm } from "./form.ts";
import { renderInspector } from "./inspect.ts";
import { cursorItem, cursorKeys, cursorNode, interpretKey, type PaneAction } from "./keys.ts";
import { connectHost, hasTree, inRepository, knownTrees, launchHost, projectRoot, stateDirFor } from "./locate.ts";
import { newSettingsScreen, renderSettings, type SettingsData, type SettingsLink, type SettingsScreen, settingsKey } from "./settings.ts";
import { readSettings, readTemplate, type SettingsRead, templatePath, writeSetting, writeTemplate } from "./settings-io.ts";
import { type InboxDetails, inboxItems, networkLine, nodeKey, type Paint, type PaneView, paneInbox, paneOrder, PLAIN, remoteRepos, renderCompact, renderPane, renderStrip } from "./view.ts";

const NODE_ENTRY = "lattice:node";
const MIN_TERMINAL_WIDTH = 90;
const SPINNER_MS = 120;
/** How often to look for hosts of other repositories starting or stopping. */
const SCAN_MS = 3000;

type Hooked = TUI & { layoutRoot?: Component; setLayoutRoot?(component: Component | undefined): void };

/** A connection to one repository's host, and what it last reported. */
interface Link {
	stateDir: string;
	client: HostClient;
	state: UiState | undefined;
	/** The questions and messages behind the counts in the state, fetched so they can be shown and answered in place. */
	details: InboxDetails;
	refreshing: Promise<void> | undefined;
}

/**
 * State that must outlive a session switch. Pi builds a new extension instance for every
 * session, but the connections to the hosts, the pane and what is open here belong to the
 * terminal, so they live once per process.
 */
interface Shared {
	/** One per repository with a running host, by state directory. */
	links: Map<string, Link>;
	/** The state directory of the repository this terminal's session is in. */
	home: string | undefined;
	/** Trees of other repositories whose host is not running. */
	asleep: KnownTree[];
	/** The node open in this terminal, and the state directory of the host that owns it. */
	current: string | undefined;
	currentDir: string | undefined;
	/** The node this terminal had open before the current one, for going back. */
	previous: string | undefined;
	/** What lets the open session speak as that node. Announced to the other extensions at each session start. */
	assignment: HostAssignment | undefined;
	/** What the pane's cursor is on: a key from the view's order. */
	cursor: string | undefined;
	focused: boolean;
	/** The new-session form, while it is being filled in. It takes the inspector's place and the keyboard. */
	form: ChildForm | undefined;
	/** The settings screen, while it is open. Like the form, it takes the inspector's place and the keyboard. */
	screen: SettingsScreen | undefined;
	/** Whether closing the settings gives the keyboard back to Pi, because they were opened from there. */
	screenLeaves: boolean;
	/** Something waiting for the same key again; see `stopKey`. */
	confirm: string | undefined;
	/** Whether the list of keys is showing. */
	help: boolean;
	/** The last few things the session under the cursor said and did. */
	tail: { nodeId: string; lines: string[] } | undefined;
	/** How many things were waiting at the last look, to tell when one more arrives; and the count the terminal title shows. */
	waiting: number;
	titled: number;
	/** A tree being started for this repository by a first message. */
	starting: boolean;
	/** Redraws the pane while a session is working, so its spinner turns. */
	ticker: ReturnType<typeof setInterval> | undefined;
	scanner: ReturnType<typeof setInterval> | undefined;
	scanning: boolean;
	paint: Paint;
	tui: Hooked | undefined;
	wrapped: boolean;
	/** What the strip above the editor currently shows, when it is showing. */
	strip: string | undefined;
	pi: ExtensionAPI | undefined;
	ctx: ExtensionContext | undefined;
}
const KEY = Symbol.for("pi-lattice.pane.4");
const globals = globalThis as { [KEY]?: Shared };
const shared: Shared = (globals[KEY] ??= {
	links: new Map(), home: undefined, asleep: [], current: undefined, currentDir: undefined, previous: undefined, assignment: undefined, cursor: undefined, focused: false, form: undefined, screen: undefined, screenLeaves: false,
	confirm: undefined, help: false, tail: undefined, waiting: 0, titled: 0, starting: false,
	ticker: undefined, scanner: undefined, scanning: false, paint: PLAIN, tui: undefined, wrapped: false, strip: undefined, pi: undefined, ctx: undefined,
});

/** The link to the repository this terminal is in, if it has a tree with a running host. */
const homeLink = (): Link | undefined => (shared.home ? shared.links.get(shared.home) : undefined);
/** A teammate's tree in a repository this machine has no tree for, by one of its sessions; and the link that heard of it. */
const elsewhereOf = (nodeId: string | undefined): { link: Link; tree: SharingTree } | undefined => {
	for (const link of shared.links.values()) {
		const tree = link.state?.sharing?.elsewhere.find((candidate) => candidate.nodes.some((node) => node.id === nodeId));
		if (tree) return { link, tree };
	}
	return undefined;
};
/** The link whose tree a node belongs to; for a session in a repository that is not here, the link that can read it. */
const linkOf = (nodeId: string | undefined): Link | undefined =>
	nodeId ? ([...shared.links.values()].find((link) => link.state?.nodes.some((node) => node.id === nodeId)) ?? elsewhereOf(nodeId)?.link) : undefined;
/** The link that owns the node open here. Falls back to the directory recorded when it was opened, for a tree not yet fetched. */
const currentLink = (): Link | undefined => linkOf(shared.current) ?? (shared.currentDir ? shared.links.get(shared.currentDir) : undefined);

function view(): PaneView {
	const links = [...shared.links.values()].filter((link): link is Link & { state: UiState } => link.state !== undefined);
	const form = shared.form;
	// While the form is open, the session it will make is drawn in the tree where it will go.
	const withGhost = (state: UiState): UiState => {
		const parent = form ? state.nodes.find((node) => node.id === form.parentId) : undefined;
		if (!form || !parent) return state;
		const ghost: NodeMeta = { ...parent, id: GHOST, parentId: parent.id, name: form.name.trim() || "new session", kind: "new", status: "dormant", brief: form.brief, fragments: form.picked, createdAt: "9999", updatedAt: "" };
		return { ...state, nodes: [...state.nodes, ghost] };
	};
	const repos = links
		.map((link) => ({ key: link.stateDir, name: repoLabel(link.state, link.stateDir), state: withGhost(link.state), here: link.stateDir === shared.home, inbox: inboxItems(link.state, link.details) }))
		// This terminal's repository first, then the others by name.
		.sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
	const base: PaneView = {
		// Then the repositories teammates are working in that are not on this machine.
		repos: [...repos, ...remoteRepos(repos, shared.asleep.flatMap((tree) => (tree.scope !== undefined ? [tree.scope] : [])))],
		network: networkLine(repos),
		asleep: shared.asleep.map((tree) => ({ key: tree.stateDir, name: basename(tree.root) })),
		previous: shared.previous !== undefined && shared.previous !== shared.current,
		current: shared.current,
		cursor: shared.cursor,
		focused: shared.focused,
		hint: homeLink() || autoStarts() ? "No sessions yet. Your next\nmessage starts one here." : "No sessions in this\nproject yet.\n\n/lattice starts a tree\nfrom this session.",
		frame: Math.floor(Date.now() / SPINNER_MS),
		height: shared.tui?.terminal.rows,
		inspector: inspecting(),
		note: shared.screen ? "settings" : shared.form ? `new session under ${shared.form.parentName}` : shared.help ? "? or esc closes the keys" : undefined,
		now: Date.now(),
		confirm: shared.confirm,
		help: shared.help,
		tail: shared.tail,
	};
	return { ...base, keys: cursorKeys(base) };
}

/** The id of the row that stands for a session the form has not created yet. */
const GHOST = "lattice-new-session";

/** The state directory of this terminal's repository, when it has a tree to keep settings and templates in. */
function treeDir(): string | undefined {
	return shared.home && hasTree(shared.home) ? shared.home : undefined;
}

/** The settings in effect in this terminal: the repository's file, when it has a tree, over the person's own. */
function settings(): SettingsRead {
	return readSettings(treeDir());
}

/** Whether a first message here starts a tree by itself: in a git repository, unless switched off. */
function autoStarts(): boolean {
	const { settings: current } = settings();
	if (!toggleSetting(current, "pane.autoJoin") || !toggleSetting(current, "pane.autoStart")) return false;
	try {
		return shared.ctx !== undefined && inRepository(shared.ctx.cwd);
	} catch {
		return false;
	}
}

/** What the settings screen shows: the settings in effect, the files behind them, and the models there are to choose from. */
function settingsData(): SettingsData {
	const read = settings();
	let models: string[] = [];
	try {
		models = (shared.ctx?.modelRegistry.getAvailable() ?? []).map((model) => `${model.provider}/${model.id}`).sort();
	} catch {
		// Between sessions there is no registry to ask; the model can still be typed.
	}
	// The role fragments and templates are files; each gets a row that opens it for editing.
	const WHOSE: Record<string, string> = { builtin: "built in", user: "yours", project: "this project's", repo: "this repository's" };
	const links: SettingsLink[] = [];
	const roles: { names: string[]; fragments?: Array<{ name: string; summary: string; source: string; path: string }> } = { names: [] };
	if (shared.pi) emitEvent(shared.pi.events, "lattice:roles:available", roles);
	for (const fragment of [...(roles.fragments ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
		links.push({
			section: "Role fragments", label: fragment.name, value: WHOSE[fragment.source] ?? fragment.source, command: `/role edit ${fragment.name}`,
			help: `${fragment.summary || "A role fragment."} ${fragment.path}. Enter opens it in Pi's editor; saving writes your own copy, used in every repository.`,
		});
	}
	for (const name of TEMPLATE_NAMES) {
		const template = readTemplate(name, treeDir());
		links.push({
			section: "Templates", label: name, value: WHOSE[template.source] ?? template.source, command: `/lattice template ${name}`,
			help: `${TEMPLATES[name].summary}${template.path ? ` ${template.path}.` : ""} Enter opens it in Pi's editor; saving writes your own copy, used in every repository.`,
		});
	}
	return { settings: read.settings, files: read.files, paths: read.paths, problems: read.problems, models, links };
}

/** Open the settings screen where the chat is, giving the pane the keyboard. */
function openSettings(): void {
	shared.screenLeaves = !shared.focused;
	shared.focused = true;
	shared.form = undefined;
	shared.help = false;
	shared.confirm = undefined;
	shared.cursor ??= restingCursor();
	shared.screen = newSettingsScreen(settingsData());
}

/** Tell each host whether this terminal is working in its repository or only watching it. */
function syncPresence(): void {
	for (const link of shared.links.values()) void link.client.ui("presence", { here: link.stateDir === shared.home }).catch(() => {});
}

/** Ring the terminal and mark its title when one more thing starts waiting, so it is noticed from another window. */
function attention(): void {
	const count = paneInbox(view()).length;
	try {
		const ctx = shared.ctx;
		if (ctx?.mode === "tui") {
			if (count > shared.waiting && toggleSetting(settings().settings, "pane.bell")) shared.tui?.terminal.write("\x07");
			if (count !== shared.titled) {
				const usual = [shared.pi?.getSessionName(), basename(ctx.cwd)].filter(Boolean).join(" - ");
				ctx.ui.setTitle(count > 0 ? `● ${count} waiting - ${usual}` : `pi - ${usual}`);
				shared.titled = count;
			}
		}
	} catch {
		// Between sessions there is nothing to mark; the next change does it.
	}
	shared.waiting = count;
}

/** Fetch what the session under the cursor has been doing, for the inspector. */
function fetchTail(): void {
	if (!inspecting()) {
		shared.tail = undefined;
		return;
	}
	const current = view();
	const nodeId = cursorNode(current) ?? cursorItem(current)?.item.nodeId;
	const link = linkOf(nodeId);
	if (!nodeId || !link) return;
	link.client
		.ui("tail", { nodeId })
		.then(({ lines }) => {
			shared.tail = { nodeId, lines };
			shared.tui?.requestRender();
		})
		.catch(() => {});
}

/** Whether the inspector is showing: the pane has the keyboard and sits beside Pi. */
function inspecting(): boolean {
	return shared.focused && shared.wrapped;
}

/** Whether the terminal is wide enough to keep the pane beside Pi all the time. */
function roomy(): boolean {
	return shared.wrapped && (shared.tui?.terminal.columns ?? 0) >= MIN_TERMINAL_WIDTH;
}

/** A repository's name: what its sessions report, else the folder its tree is kept in. */
function repoLabel(state: UiState, stateDir: string): string {
	return state.nodes.find((node) => node.parentId === null && node.repo)?.repo ?? state.nodes.find((node) => node.repo)?.repo ?? basename(dirname(stateDir));
}

/** Where the cursor starts: on what is waiting, if anything is; otherwise on the session open here. */
function restingCursor(): string | undefined {
	const order = paneOrder(view());
	const first = order[0]?.startsWith("i:") ? order[0] : undefined;
	return first ?? (shared.current ? nodeKey(shared.current) : order[0]);
}

/** Keep the spinner turning while any session is working, and stop when none is. */
function tick(): void {
	const working = [...shared.links.values()].some((link) => link.state?.nodes.some((node) => node.status === "running" || node.status === "starting"));
	if (working && !shared.ticker && shared.wrapped) {
		// The strip is a widget with fixed text, so it has to be set again to turn; the pane only needs drawing again.
		shared.ticker = setInterval(() => (shared.strip !== undefined ? redraw() : shared.tui?.requestRender()), SPINNER_MS);
		shared.ticker.unref?.();
	} else if (!working && shared.ticker) {
		clearInterval(shared.ticker);
		shared.ticker = undefined;
	}
}

function redraw(): void {
	tick();
	shared.tui?.requestRender();
	// Between one session ending and the next starting there is no usable context; a redraw then simply waits.
	try {
		const ctx = shared.ctx;
		if (ctx?.mode !== "tui") return;
		// Where the pane cannot sit beside Pi (a narrow terminal, or a Pi it cannot be installed in),
		// two rows above the editor carry the same information.
		const lines = roomy() || shared.focused ? [] : renderStrip(view(), (shared.tui?.terminal.columns ?? 80) - 2, shared.paint);
		const strip = lines.length > 0 ? lines.join("\n") : undefined;
		if (strip !== shared.strip) {
			ctx.ui.setWidget("lattice", strip === undefined ? undefined : lines);
			shared.strip = strip;
		}
	} catch {
		shared.ctx = undefined;
	}
}

/** Say something to the person, if a session is there to say it in. */
function tell(message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (shared.ctx?.hasUI) shared.ctx.ui.notify(message, level);
	} catch {
		shared.ctx = undefined; // the session that context belonged to has ended
	}
}

/** The node id recorded in a session, if it is a lattice node. */
function recordedNode(ctx: ExtensionContext): string | undefined {
	let found: string | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === NODE_ENTRY) {
			const id = (entry.data as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof id === "string") found = id;
		}
	}
	return found;
}

/** Fetch the questions and messages that the state only counts. Whatever cannot be fetched stays a count. */
async function fetchDetails(client: HostClient, state: UiState): Promise<InboxDetails> {
	const asking = state.nodes.filter((node) => (state.attention[node.id]?.dialogs ?? 0) > 0);
	const pending = Object.values(state.attention).some((entry) => entry.pending > 0);
	const [dialogs, mail] = await Promise.all([
		Promise.all(asking.map(async (node) => [node.id, await client.ui("dialogs", { nodeId: node.id }).then((result) => result.dialogs).catch(() => [])] as const)),
		pending ? client.ui("pendingMail", {}).then((result) => result.mail).catch(() => []) : Promise.resolve([]),
	]);
	return { dialogs: Object.fromEntries(dialogs), mail };
}

async function refreshLink(link: Link): Promise<void> {
	link.refreshing ??= link.client
		.ui("state", {})
		.then(async (state) => {
			link.details = await fetchDetails(link.client, state);
			link.state = state;
		})
		.catch(() => {})
		.finally(() => {
			link.refreshing = undefined;
			// What the cursor was on may be gone (an item just answered): move to the next thing waiting, else to the session open here.
			if (shared.cursor && !paneOrder(view()).includes(shared.cursor)) shared.cursor = shared.focused ? restingCursor() : undefined;
			attention();
			fetchTail();
			redraw();
		});
	await link.refreshing;
}

/** Fetch every tree again. */
async function refresh(): Promise<void> {
	await Promise.all([...shared.links.values()].map(refreshLink));
}

/** Start following a host. */
function addLink(client: HostClient, stateDir: string): Link {
	const link: Link = { stateDir, client, state: undefined, details: {}, refreshing: undefined };
	shared.links.set(stateDir, link);
	shared.asleep = shared.asleep.filter((tree) => tree.stateDir !== stateDir);
	void client.ui("presence", { here: stateDir === shared.home }).catch(() => {});
	client.onFrame((frame) => {
		if (frame.t !== "event") return;
		if (frame.kind === "changed") void refreshLink(link);
		else if (frame.kind === "log" && frame.message) tell(stateDir === shared.home || !link.state ? frame.message : `${repoLabel(link.state, stateDir)}: ${frame.message}`);
	});
	return link;
}

/**
 * Follow the hosts of this person's other repositories: link to each one that is running,
 * drop the ones that have stopped, and note the trees whose host is asleep.
 */
async function scan(): Promise<void> {
	if (shared.scanning) return;
	shared.scanning = true;
	try {
		for (const [stateDir, link] of shared.links) if (link.client.isClosed) shared.links.delete(stateDir);
		const trees = knownTrees();
		for (const tree of trees) {
			if (shared.links.has(tree.stateDir)) continue;
			const client = await connectHost(tree.stateDir);
			if (!client) continue;
			if (shared.links.has(tree.stateDir)) client.close(); // linked meanwhile, by a session start
			else void refreshLink(addLink(client, tree.stateDir));
		}
		const asleep = trees.filter((tree) => !shared.links.has(tree.stateDir) && tree.stateDir !== shared.home);
		const changed = asleep.length !== shared.asleep.length || asleep.some((tree, index) => tree.stateDir !== shared.asleep[index]?.stateDir);
		shared.asleep = asleep;
		if (changed) redraw();
		// A teammate's session under the cursor is sent as it goes only while someone keeps looking: keep looking.
		const watched = cursorNode(view());
		const link = linkOf(watched);
		if (watched && link && inspecting() && !link.state?.nodes.some((node) => node.id === watched && node.owner === link.state?.owner)) fetchTail();
	} catch {
		// Looking is best effort; the next pass tries again.
	} finally {
		shared.scanning = false;
	}
}

/** Put the pane to the left of everything Pi draws. Falls back to a compact widget when that is not possible. */
function installPane(tui: Hooked): void {
	shared.tui = tui;
	if (shared.wrapped || !tui.layoutRoot || !tui.setLayoutRoot) return;
	const pane: Component = {
		render: (width) => {
			// The last column is the divider between the pane and Pi; it lights up while the pane has the keyboard.
			const divider = shared.focused ? shared.paint.accent("│") : shared.paint.dim("│");
			return renderPane(view(), width, shared.paint).map((line) => {
				const text = truncateToWidth(line, width - 1);
				return `${text}${" ".repeat(Math.max(0, width - 1 - visibleWidth(text)))}${divider}`;
			});
		},
		invalidate() {},
	};
	// While the pane has the keyboard, what the cursor is on is shown in full where the chat was.
	const inspector: Component = {
		render: (width) =>
			(shared.screen
				? renderSettings(shared.screen, settingsData(), width, shared.paint, shared.tui?.terminal.rows)
				: shared.form ? renderForm(shared.form, width, shared.paint, shared.tui?.terminal.rows) : renderInspector(view(), width, shared.paint, shared.tui?.terminal.rows)).map((line) => truncateToWidth(line, width)),
		invalidate() {},
	};
	const wrap = (inner: Component): Component =>
		new HStack([
			// Always there, so opening pi shows the sessions without typing anything.
			// In a narrow terminal it appears only while it has the keyboard.
			{ component: pane, basis: numberSetting(settings().settings, "pane.width", 34), shrink: 0, visible: (viewport) => viewport.width >= MIN_TERMINAL_WIDTH || shared.focused },
			{ component: inspector, basis: 0, grow: 1, minSize: 20, visible: () => inspecting() },
			{ component: inner, basis: 0, grow: 1, minSize: 20, visible: () => !inspecting() },
		]);
	const set = tui.setLayoutRoot.bind(tui);
	tui.setLayoutRoot = (component) => set(component ? wrap(component) : undefined);
	tui.setLayoutRoot(tui.layoutRoot);
	shared.wrapped = true;
	// Keys go to the pane only while it is focused; otherwise Pi behaves exactly as usual.
	tui.addInputListener((data) => {
		if (!shared.focused) return undefined;
		onPaneKey(data);
		return { consume: true };
	});
}

/** Run a /lattice command from a key press. Keys have no command context; the input path provides one. */
function dispatch(command: string): void {
	const pi = shared.pi;
	const ctx = shared.ctx;
	if (!pi || !ctx) return;
	try {
		// While the agent is working the input path needs to be told how to take this; a command runs at once either way.
		pi.sendUserMessage(command, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "steer" });
	} catch {
		// The session ended between the key press and now; the next session's pane will be current.
	}
}

/** A key press as the form sees it. Anything that is not a key it acts on is text, pasted text included. */
function formKeyOf(data: string): FormKey | undefined {
	const named = (["tab", "up", "down", "left", "right", "home", "end", "enter", "space", "backspace", "delete", "escape"] as const).find((key) => matchesKey(data, key));
	if (named) return named;
	if (matchesKey(data, "shift+tab")) return "back-tab";
	if (matchesKey(data, "ctrl+s")) return "submit";
	// Pasted text arrives between markers; other escape sequences are keys the form has no use for.
	const text = data.replace(/\x1b\[20[01]~/g, "").replace(/\r\n?/g, "\n");
	if (text === "" || text.includes("\x1b") || /[\x00-\x09\x0b-\x1f\x7f]/.test(text)) return undefined;
	return { text };
}

/** Keys while the new-session form is open. */
function onFormKey(data: string): void {
	const form = shared.form;
	const key = formKeyOf(data);
	if (!form || !key) return;
	const result = formKey(form, key);
	if ("cancel" in result) shared.form = undefined;
	else if ("form" in result) shared.form = result.form;
	else {
		const client = linkOf(result.submit.parentId)?.client;
		if (!client) {
			shared.form = { ...form, error: "Its parent is no longer here." };
			return;
		}
		client
			.ui("spawn", result.submit)
			.then(async ({ node }) => {
				shared.form = undefined;
				await refresh();
				// Leave the cursor on what was just made.
				shared.cursor = nodeKey(node.id);
				tell(`Created "${node.name}". It is working in the background.`);
			})
			.catch((error: unknown) => {
				if (shared.form) shared.form = { ...shared.form, error: error instanceof Error ? error.message : String(error) };
			})
			.finally(redraw);
	}
}

/** Keys while the settings screen is open. A change is written at once; there is nothing to save. */
function onSettingsKey(data: string): void {
	const screen = shared.screen;
	const key = formKeyOf(data);
	if (!screen || !key) return;
	const result = settingsKey(screen, settingsData(), key);
	if ("close" in result) {
		shared.screen = undefined;
		if (shared.screenLeaves) {
			shared.focused = false;
			shared.cursor = undefined;
		}
	} else if ("command" in result) {
		shared.screen = undefined;
		shared.focused = false;
		shared.cursor = undefined;
		dispatch(result.command);
	} else {
		shared.screen = result.screen;
		if ("write" in result) {
			try {
				writeSetting(result.write.scope, shared.home, result.write.key, result.write.value);
			} catch (error) {
				shared.screen = { ...result.screen, error: error instanceof Error ? error.message : String(error) };
			}
		}
	}
}

function onPaneKey(data: string): void {
	if (shared.screen) {
		onSettingsKey(data);
		redraw();
		return;
	}
	if (shared.form) {
		onFormKey(data);
		redraw();
		return;
	}
	const key = matchesKey(data, "up") ? "up" : matchesKey(data, "down") ? "down" : matchesKey(data, "enter") ? "enter" : matchesKey(data, "escape") || matchesKey(data, "alt+l") ? "escape" : data;
	const actions = interpretKey(view(), key);
	// A second press only counts straight after the first: any other key withdraws it.
	if (!actions.some((action) => action.do === "confirm")) shared.confirm = undefined;
	for (const action of actions) perform(action);
	fetchTail();
	redraw();
}

/** Carry out what a key press meant. Answers go straight to the host; anything needing Pi's dialogs goes through a command. */
function perform(action: PaneAction): void {
	const settle = (request: Promise<unknown>): void => {
		request.catch((error: unknown) => tell(error instanceof Error ? error.message : String(error), "error")).finally(() => void refresh());
	};
	const nameOf = (id: string): string => [...shared.links.values()].flatMap((link) => link.state?.nodes ?? []).find((node) => node.id === id)?.name ?? id;
	if (action.do === "move") shared.cursor = action.cursor;
	else if (action.do === "leave") {
		shared.focused = false;
		shared.cursor = undefined;
		shared.help = false;
		shared.screen = undefined;
	} else if (action.do === "command") dispatch(action.text);
	else if (action.do === "help") shared.help = !shared.help;
	else if (action.do === "settings") {
		// The screen needs the room beside the pane; without it the settings are listed as text.
		if (inspecting()) openSettings();
		else dispatch("/lattice config");
	}
	else if (action.do === "confirm") shared.confirm = action.what;
	else if (action.do === "interrupt") {
		const name = nameOf(action.nodeId);
		// The session open here is stopped by Pi itself; the others by their host.
		if (action.nodeId === shared.current) {
			try {
				shared.ctx?.abort();
				tell(`Stopped "${name}".`);
			} catch {
				// The session ended meanwhile; nothing is left to stop.
			}
		} else {
			const client = shared.links.get(action.repo)?.client;
			if (client) settle(client.ui("interrupt", { nodeId: action.nodeId }).then(() => tell(`Stopped "${name}". It is idle; open it or send it a message to carry on.`)));
		}
	} else if (action.do === "archive") {
		const client = shared.links.get(action.repo)?.client;
		const name = nameOf(action.nodeId);
		if (client) settle(client.ui("archive", { nodeId: action.nodeId, archived: true }).then(({ count }) => tell(`Archived "${name}"${count > 1 ? ` and ${count - 1} under it` : ""}. /lattice restore brings it back.`)));
	}
	else if (action.do === "new") {
		const parent = action.nodeId ? [...shared.links.values()].flatMap((link) => (link.state?.nodes ?? []).map((node) => ({ node, owner: link.state?.owner }))).find((entry) => entry.node.id === action.nodeId) : undefined;
		if (!parent || parent.node.owner !== parent.owner) tell("Choose one of your own sessions to add a child under.", "warning");
		else if (inspecting()) {
			// Ask whoever knows which roles exist here; with no answer the form simply offers none.
			const request = { names: [] as string[] };
			if (shared.pi) emitEvent(shared.pi.events, "lattice:roles:available", request);
			shared.form = newChildForm(parent.node, request.names.sort());
		} else {
			shared.focused = false;
			shared.cursor = undefined;
			dispatch(`/lattice new ${parent.node.id}`);
		}
	} else if (action.do === "wake") {
		const tree = shared.asleep.find((candidate) => candidate.stateDir === action.repo);
		const bus = shared.pi?.events;
		if (!tree || !bus) return;
		settle(
			launchHost(bus, tree.stateDir, tree.root).then((client) => {
				if (shared.links.has(tree.stateDir)) client.close();
				else addLink(client, tree.stateDir);
			}),
		);
	} else {
		const client = shared.links.get(action.repo)?.client;
		if (!client) return;
		if (action.do === "answer") settle(client.ui("answerDialog", { nodeId: action.nodeId, dialogId: action.dialogId, answer: { confirmed: action.confirmed } }));
		else if (action.do === "decide") settle(client.ui("decideMail", { nodeId: action.nodeId, envelopeId: action.envelopeId, action: action.action }));
		else if (action.do === "sharing") settle(client.ui("sharing", { action: action.action, args: action.args }));
	}
}

export default function paneExtension(pi: ExtensionAPI): void {
	// Inside a session the host runs headless there is no person and no pane.
	if (process.env.LATTICE_HEADLESS) return;

	/** Every session the pane shows: each repository's tree, then what teammates have running in repositories that are not here. */
	const everyNode = (): NodeMeta[] => {
		const here = [...shared.links.values()].flatMap((link) => link.state?.nodes ?? []);
		const seen = new Set(here.map((node) => node.id));
		const elsewhere = [...shared.links.values()].flatMap((link) => link.state?.sharing?.elsewhere.flatMap((tree) => tree.nodes) ?? []).filter((node) => !seen.has(node.id) && seen.add(node.id));
		return [...here, ...elsewhere];
	};
	const name = (id: string): string => everyNode().find((node) => node.id === id)?.name ?? id;
	/** A session by id, or by name: this repository's first, then any other's. */
	const find = (text: string): NodeMeta | undefined =>
		everyNode().find((node) => node.id === text) ?? homeLink()?.state?.nodes.find((node) => node.name === text) ?? everyNode().find((node) => node.name === text);
	const mine = (node: NodeMeta | undefined): node is NodeMeta => node !== undefined && node.owner === linkOf(node.id)?.state?.owner;

	/** Tell the hosts which node this terminal has open, taking it over or giving back the previous one. */
	const attach = async (nodeId: string | undefined, leaveWorking = false): Promise<{ sessionFile: string; wasWorking: boolean } | undefined> => {
		if (shared.current && shared.current !== nodeId) {
			await currentLink()?.client.ui("detach", { nodeId: shared.current, resume: leaveWorking }).catch(() => {});
			shared.current = undefined;
			shared.currentDir = undefined;
			shared.assignment = undefined;
		}
		const link = linkOf(nodeId);
		if (!nodeId || !link) return undefined;
		const result = await link.client.ui("attach", { nodeId });
		shared.current = nodeId;
		shared.currentDir = link.stateDir;
		shared.assignment = result.assignment;
		return { sessionFile: result.sessionFile, wasWorking: result.wasWorking };
	};

	// The other extensions ask what the settings are; the files are ours to read.
	onEvent(pi.events, "lattice:settings:query", (request) => {
		if (shared.pi === pi) request.values = { ...settings().settings.values };
	});

	pi.on("session_start", async (_event, ctx) => {
		shared.pi = pi;
		shared.ctx = ctx;
		const stateDir = stateDirFor(ctx.cwd);
		// A session from another repository was opened here: this terminal is now in that repository.
		const moved = shared.home !== undefined && shared.home !== stateDir;
		shared.home = stateDir;
		syncPresence();
		try {
			const existing = shared.links.get(stateDir);
			if (!existing || existing.client.isClosed) {
				shared.links.delete(stateDir);
				const client = (await connectHost(stateDir)) ?? (hasTree(stateDir) ? await launchHost(pi.events, stateDir, ctx.cwd) : undefined);
				if (client) addLink(client, stateDir);
			}
			await scan();
			await refresh();
			const home = homeLink();
			if (home) {
				// If this session is a node of the tree, this terminal now has it open. A session is
				// matched by the node id recorded in it, or by its file for one that was just adopted.
				const file = ctx.sessionManager.getSessionFile();
				const recorded = recordedNode(ctx);
				const node = (recorded ? home.state?.nodes.find((candidate) => candidate.id === recorded) : undefined) ?? (file ? home.state?.nodes.find((candidate) => candidate.sessionFile === file) : undefined);
				const here = mine(node) ? node.id : undefined;
				if (here !== shared.current) await attach(here);
			} else if (shared.current) await attach(undefined);
			// Tell the messaging, roles and tree extensions which node this session is, if any.
			// They rebind whenever they hear this, so it does not matter which of us started first.
			emitEvent(pi.events, "lattice:host:assigned", { assignment: shared.current ? (shared.assignment ?? null) : null });
			if (moved) {
				// Said once Pi has finished drawing the session it switched to, or the notice is drawn over.
				const notice = `Now in ${home?.state ? repoLabel(home.state, stateDir) : basename(projectRoot(ctx.cwd))} · ${projectRoot(ctx.cwd)}`;
				setTimeout(() => tell(notice), 150);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`pi-lattice: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		if (!shared.scanner) {
			shared.scanner = setInterval(() => void scan(), SCAN_MS);
			shared.scanner.unref?.();
		}
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("lattice-pane-anchor", (tui, theme) => {
				shared.paint = {
					dim: (text) => theme.fg("dim", text),
					bold: (text) => theme.bold(text),
					accent: (text) => theme.fg("accent", text),
					ok: (text) => theme.fg("success", text),
					warn: (text) => theme.fg("warning", text),
					error: (text) => theme.fg("error", text),
					select: (text) => theme.bg("selectedBg", text),
				};
				installPane(tui as Hooked);
				queueMicrotask(redraw); // the side pane is in place: drop the compact list if it was shown meanwhile
				return { render: () => [], invalidate() {} };
			});
		}
		redraw();
	});

	// In a project that has a tree, a new session joins it with its first message, named after
	// that message, so every real session shows in the pane without anyone asking.
	pi.on("before_agent_start", async (event, ctx) => {
		const home = homeLink();
		if (shared.current || event.messageType !== "user" || !toggleSetting(settings().settings, "pane.autoJoin")) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const title = pi.getSessionName() ?? (event.prompt.replace(/\s+/g, " ").trim().slice(0, 40) || basename(ctx.cwd));
		if (!home) {
			// A repository with no tree yet gets one from the first message, with nothing to type.
			// The host starts in the background, so the message itself is not held up.
			if (!ctx.hasUI || shared.starting || !autoStarts() || process.env.LATTICE_STATE_DIR) return;
			shared.starting = true;
			const stateDir = stateDirFor(ctx.cwd);
			const sessionId = ctx.sessionManager.getSessionId();
			const cwd = ctx.cwd;
			void launchHost(pi.events, stateDir, cwd)
				.then(async (client) => {
					const link = shared.links.get(stateDir) ?? addLink(client, stateDir);
					if (shared.current || shared.home !== stateDir) return;
					const { node, assignment } = await link.client.ui("adopt", { sessionFile, sessionId, cwd, name: title });
					shared.current = node.id;
					shared.currentDir = stateDir;
					shared.assignment = assignment;
					emitEvent(pi.events, "lattice:host:assigned", { assignment });
					await refreshLink(link);
				})
				.catch(() => {
					// Starting a tree is a convenience; the session works without it, and /lattice says what is wrong.
				})
				.finally(() => {
					shared.starting = false;
				});
			return;
		}
		try {
			const { node, assignment } = await home.client.ui("adopt", { sessionFile, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: title });
			shared.current = node.id;
			shared.currentDir = home.stateDir;
			shared.assignment = assignment;
			emitEvent(pi.events, "lattice:host:assigned", { assignment });
			void refreshLink(home);
		} catch {
			// Joining is a convenience; the session works without it.
		}
	});

	pi.on("agent_start", async () => {
		if (shared.current) await currentLink()?.client.ui("status", { nodeId: shared.current, streaming: true }).catch(() => {});
	});
	pi.on("agent_settled", async () => {
		if (shared.current) await currentLink()?.client.ui("status", { nodeId: shared.current, streaming: false }).catch(() => {});
	});

	// The host sees what its background sessions use; the one open here has to be reported.
	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } };
		if (!shared.current || message.role !== "assistant" || !message.usage) return;
		const tokens = message.usage.totalTokens ?? (message.usage.input ?? 0) + (message.usage.output ?? 0);
		void currentLink()?.client.ui("usage", { nodeId: shared.current, tokens, cost: message.usage.cost?.total ?? 0 }).catch(() => {});
	});

	pi.on("session_shutdown", async (event) => {
		// This session's objects are about to go stale. The next session's start supplies fresh ones.
		if (shared.pi === pi) {
			shared.pi = undefined;
			shared.ctx = undefined;
		}
		if (event.reason !== "quit") return; // a session switch keeps the terminal's connections
		if (shared.current) await currentLink()?.client.ui("detach", { nodeId: shared.current }).catch(() => {});
		shared.current = undefined;
		shared.currentDir = undefined;
		if (shared.scanner) clearInterval(shared.scanner);
		shared.scanner = undefined;
		for (const link of shared.links.values()) link.client.close();
		shared.links.clear();
	});

	pi.registerShortcut("alt+l", {
		description: "Focus the lattice session pane",
		handler: async (ctx) => {
			if (shared.links.size === 0 && shared.asleep.length === 0) {
				ctx.ui.notify("No session tree here yet. Run /lattice to start one.", "info");
				return;
			}
			if (!shared.wrapped) {
				// Without the side pane there is nothing to give the keyboard to; list everything instead.
				dispatch("/lattice status");
				return;
			}
			shared.focused = !shared.focused;
			shared.form = undefined;
			shared.screen = undefined;
			shared.help = false;
			shared.confirm = undefined;
			shared.cursor = shared.focused ? restingCursor() : undefined;
			fetchTail();
			redraw();
		},
	});

	// --- flows, built from Pi's own dialogs --------------------------------------

	/** The host of the repository this terminal is in, or a word about how to get one. */
	const need = (ctx: ExtensionCommandContext): HostClient | undefined => {
		const client = homeLink()?.client;
		if (!client) ctx.ui.notify("No session tree here yet. Run /lattice to start one.", "warning");
		return client;
	};
	const fail = (ctx: ExtensionCommandContext, error: unknown): void => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");

	/** Start a tree with the current session as its root. */
	const begin = async (ctx: ExtensionCommandContext): Promise<void> => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("This session is not saved to a file (--no-session), so it cannot join a tree.", "warning");
			return;
		}
		const stateDir = stateDirFor(ctx.cwd);
		shared.home = stateDir;
		const home = shared.links.get(stateDir) ?? addLink(await launchHost(pi.events, stateDir, ctx.cwd), stateDir);
		await refresh();
		const existing = recordedNode(ctx);
		if (existing && mine(find(existing))) {
			await attach(existing);
		} else {
			const { node, assignment } = await home.client.ui("adopt", {
				sessionFile, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: pi.getSessionName() ?? basename(ctx.cwd),
			});
			shared.current = node.id;
			shared.currentDir = stateDir;
			shared.assignment = assignment;
		}
		// The messaging, roles and tree extensions take up the node's identity as soon as they hear of it.
		emitEvent(pi.events, "lattice:host:assigned", { assignment: shared.assignment ?? null });
		await refresh();
		ctx.ui.notify("This session is now part of a lattice tree. alt+l moves to the session pane; /lattice new creates a child.", "info");
	};

	const open = async (ctx: ExtensionCommandContext, text: string): Promise<void> => {
		if (shared.links.size === 0) {
			need(ctx);
			return;
		}
		await refresh();
		const node = find(text);
		const state = linkOf(node?.id)?.state;
		if (!node || !state) {
			ctx.ui.notify(`No session "${text}" in any tree here.`, "warning");
			return;
		}
		if (node.id === shared.current) return;
		if (!mine(node)) {
			await read(ctx, node);
			return;
		}
		const waiting = state.attention[node.id]?.dialogs ?? 0;
		if (waiting > 0 && !state.foreground.includes(node.id)) {
			const choice = await ctx.ui.select(`"${node.name}" is waiting on a question.`, ["Answer it here", "Open the session (the question is dropped)"]);
			if (choice === undefined) return;
			if (choice === "Answer it here") {
				await answer(ctx, node);
				return;
			}
		}
		const previous = shared.current;
		try {
			// A turn cannot move between processes. If the agent here is mid-turn, stop it on this
			// side; the host picks the session up in the background and tells it to carry on.
			const working = !ctx.isIdle();
			if (working) {
				ctx.abort();
				await ctx.waitForIdle();
			}
			const result = await attach(node.id, working);
			if (!result) return;
			const switched = await ctx.switchSession(result.sessionFile, {
				// The same in the other direction: a session that was working in the background carries on here.
				withSession: async (next) => {
					if (result.wasWorking) await next.sendUserMessage(renderTemplate(readTemplate("handover", shared.currentDir).text, {}));
				},
			});
			if (switched.cancelled) await attach(previous);
			else if (previous) shared.previous = previous;
		} catch (error) {
			await attach(previous).catch(() => {});
			fail(ctx, error);
		}
	};

	/** Show another person's session, read-only. */
	const read = async (ctx: ExtensionCommandContext, node: NodeMeta): Promise<void> => {
		const client = linkOf(node.id)?.client;
		if (!client) return;
		let messages: unknown[];
		try {
			messages = (await client.ui("messages", { nodeId: node.id })).messages;
		} catch (error) {
			ctx.ui.notify(`"${node.name}" belongs to ${node.owner}. ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		const text = transcriptText(messages);
		await ctx.ui.editor(`${node.name} (owned by ${node.owner}, read-only; changes here are not saved)`, text || "(no conversation yet)");
	};

	const answer = async (ctx: ExtensionCommandContext, node: NodeMeta): Promise<void> => {
		const client = linkOf(node.id)?.client;
		if (!client) return;
		const { dialogs } = await client.ui("dialogs", { nodeId: node.id });
		for (const dialog of dialogs) {
			const title = `${node.name} asks: ${dialog.title}${dialog.message ? `\n${dialog.message}` : ""}`;
			let reply: { value?: string; confirmed?: boolean; cancelled?: boolean };
			if (dialog.method === "confirm") reply = { confirmed: await ctx.ui.confirm(`${node.name} asks: ${dialog.title}`, dialog.message ?? "") };
			else if (dialog.method === "select") {
				const choice = await ctx.ui.select(title, dialog.options ?? []);
				reply = choice === undefined ? { cancelled: true } : { value: choice };
			} else {
				const value = await ctx.ui.input(title, dialog.placeholder ?? "");
				reply = value === undefined ? { cancelled: true } : { value };
			}
			await client.ui("answerDialog", { nodeId: node.id, dialogId: dialog.id, answer: reply });
		}
	};

	const create = async (ctx: ExtensionCommandContext, parentText: string): Promise<void> => {
		if (!need(ctx)) return;
		await refresh();
		const parent = find(parentText) ?? (shared.current ? find(shared.current) : undefined);
		// The child is created by the host of the repository its parent is in.
		const client = linkOf(parent?.id)?.client;
		if (!mine(parent) || !client) {
			ctx.ui.notify("Choose one of your own sessions to add a child under.", "warning");
			return;
		}
		const childName = (await ctx.ui.input(`New session under "${parent.name}"`, "name"))?.trim();
		if (!childName) return;
		const kind = (await ctx.ui.input("Kind (a free-form label: task, grilling, planning...)", "task"))?.trim() || "task";
		const roles = (await ctx.ui.input("Roles, in order, separated by spaces (optional)", "worker implementation"))?.trim() ?? "";
		const workspace = await ctx.ui.select("Where should it work?", ["shared: this directory", "worktree: its own git worktree and branch"]);
		if (workspace === undefined) return;
		const model = (await ctx.ui.input("Model (optional; empty uses the default)", "anthropic/claude-haiku-4-5"))?.trim() ?? "";
		const brief = (await ctx.ui.editor("Brief: what should it do? It sees only this text.", ""))?.trim();
		if (!brief) return;
		try {
			const { node } = await client.ui("spawn", {
				parentId: parent.id,
				spec: { name: childName, brief, kind, fragments: roles.split(/[\s,+]+/).filter(Boolean), workspace: workspace.startsWith("worktree") ? "worktree" : "shared", ...(model ? { model } : {}) },
			});
			ctx.ui.notify(`Created "${node.name}". It is working in the background; open it from the pane (alt+l).`, "info");
		} catch (error) {
			fail(ctx, error);
		}
	};

	const approvals = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!need(ctx)) return;
		for (;;) {
			// Messages waiting in every repository, each with the host that holds it.
			const mail = (await Promise.all([...shared.links.values()].map(async (link) => (await link.client.ui("pendingMail", {}).catch(() => ({ mail: [] }))).mail.map((item) => ({ ...item, client: link.client }))))).flat();
			if (mail.length === 0) {
				ctx.ui.notify("Nothing is waiting for approval.", "info");
				return;
			}
			await refresh();
			const labels = mail.map((item) => `${name(item.envelope.from)} (${item.envelope.fromOwner}) → ${name(item.nodeId)}: ${item.envelope.payload.text.replace(/\s+/g, " ").slice(0, 70)}`);
			const picked = await ctx.ui.select("Messages waiting for approval. Nothing here reaches an agent until you approve it.", labels);
			const item = picked === undefined ? undefined : mail[labels.indexOf(picked)];
			if (!item) return;
			const action = await ctx.ui.select(`${name(item.envelope.from)} (${item.envelope.fromOwner}) → ${name(item.nodeId)}\n\n${item.envelope.payload.text}`, ["Approve", "Reject", "Decide later"]);
			if (action !== "Approve" && action !== "Reject") return;
			await item.client.ui("decideMail", { nodeId: item.nodeId, envelopeId: item.envelope.id, action: action === "Approve" ? "approve" : "reject" }).catch((error: unknown) => fail(ctx, error));
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};

	/** Run a network or handoff action on a repository's host and say what it answers. */
	const sharing = async (ctx: ExtensionCommandContext, client: HostClient, action: string, args: string[]): Promise<boolean> => {
		let done = true;
		try {
			const { text } = await client.ui("sharing", { action, args });
			if (text) ctx.ui.notify(text, "info");
		} catch (error) {
			fail(ctx, error);
			done = false;
		}
		await refresh();
		return done;
	};

	/** What handing a session to someone does, said before the one step that cannot be taken back. */
	const WHAT_GOES = "It stops here, and its whole conversation, including any file contents and command output in it, goes directly to them, with its branch if it has one. After that you can read it but not run it.";
	const NO_NETWORK = "You are not in a network yet. /lattice network creates one, or joins a teammate's.";

	/** The network: create or join one; then who is in it, the join code, and anything being handed over. */
	const network = async (ctx: ExtensionCommandContext): Promise<void> => {
		const client = need(ctx);
		if (!client) return;
		await refresh();
		const run = (action: string, args: string[]): Promise<boolean> => sharing(ctx, client, action, args);
		const state = homeLink()?.state?.sharing;
		if (!state) {
			const create = "Create a network";
			const join = "Join with a teammate's code";
			const picked = await ctx.ui.select(
				"A network is you and your teammates. Everyone in it sees everyone's sessions in the repositories they share, can read them, and can hand them to each other. You set it up once; every repository uses it.",
				[create, join],
			);
			if (picked === create) {
				const name = await ctx.ui.input("A name for the network (letters, digits, dashes)", "team");
				if (name?.trim()) await run("create", [name.trim()]);
			} else if (picked === join) {
				const code = await ctx.ui.input("Paste the join code your teammate gave you", "name.secret@host");
				if (code?.trim()) await run("join", [code.trim()]);
			}
			return;
		}
		const options: Array<{ label: string; act: () => Promise<unknown> }> = [];
		for (const request of state.requests) {
			const node = `"${request.nodeName}"`;
			if (request.role === "owner") {
				options.push({ label: `Hand ${node} to ${request.from}, who asks for it`, act: () => approve(ctx, `${request.nodeId} ${request.from}`) });
				options.push({ label: `Keep ${node}`, act: () => run("decline", [request.nodeId, request.from]) });
			} else options.push({ label: `Stop asking ${request.to} for ${node}`, act: () => run("withdraw", [request.nodeId]) });
		}
		for (const handoff of state.handoffs) {
			const node = `"${handoff.nodeName}"`;
			if (handoff.role === "recipient" && handoff.state === "offered") {
				options.push({ label: `Accept ${node} from ${handoff.from}`, act: () => run("accept", [handoff.nodeId]) });
				options.push({ label: `Decline ${node}`, act: () => run("cancel", [handoff.nodeId]) });
			} else if (handoff.role === "owner" && handoff.state === "accepted") {
				options.push({ label: `Send ${node} to ${handoff.to} now`, act: () => release(ctx, handoff.nodeId) });
				options.push({ label: `Cancel handing ${node} to ${handoff.to}`, act: () => run("cancel", [handoff.nodeId]) });
			} else options.push({ label: `Take back the offer of ${node} to ${handoff.to}`, act: () => run("cancel", [handoff.nodeId]) });
		}
		for (const person of state.people) {
			if (person.trust !== "changed") continue;
			options.push({
				label: `Accept ${person.name}'s new key`,
				act: async () => {
					const sure = await ctx.ui.confirm(
						`Is this really ${person.name}?`,
						`Someone connected as ${person.name} with a key that is DIFFERENT from the one you know them by. That is expected if they have a new machine or reinstalled, and otherwise it is someone else using their name.\n\nNew key fingerprint: ${person.fingerprint}\n\nCompare it with ${person.name} over a channel you already trust.`,
					);
					if (sure) await run("trust", [person.name]);
				},
			});
		}
		const others = state.people.filter((person) => !person.self);
		options.push({ label: "Show the join code", act: () => run("code", []) });
		options.push({
			label: `Who is in ${state.network}`,
			act: async () => ctx.ui.notify(
				[...state.people.map((person) => `${person.name}${person.self ? " (you)" : person.trust === "changed" ? "  key changed" : person.online ? "  here" : "  not in this repository right now"}`), ...(others.length === 0 ? ["Nobody else yet. Give a teammate the join code."] : [])].join("\n"),
				"info",
			),
		});
		options.push({ label: "Look for teammates again", act: () => run("refresh", []) });
		options.push({
			label: `Leave ${state.network}`,
			act: async () => {
				if (await ctx.ui.confirm(`Leave ${state.network}?`, "Your sessions are no longer shown to your teammates, and theirs stay here as last seen. This applies to every repository. You can join again with the code.")) await run("leave", []);
			},
		});
		const here = others.filter((person) => person.online).length;
		const picked = await ctx.ui.select(`${state.network} · ${others.length === 0 ? "only you so far" : `${others.length + 1} people, ${here} here with you`}`, options.map((option) => option.label));
		await options.find((option) => option.label === picked)?.act();
	};

	/** Offer one of this person's sessions to a teammate. It is theirs as soon as they accept. */
	const offer = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		await refresh();
		const [first = "", to = ""] = arg.split(/\s+/).filter(Boolean);
		const node = named(ctx, first);
		const link = node ? linkOf(node.id) : undefined;
		if (!node || !link) return;
		if (node.owner !== link.state?.owner) return ctx.ui.notify(`"${node.name}" belongs to ${node.owner}. To get it, ask for it: /lattice take ${node.name}.`, "warning");
		const state = link.state?.sharing;
		if (!state) return ctx.ui.notify(NO_NETWORK, "info");
		const others = state.people.filter((person) => !person.self && person.trust === "trusted");
		if (others.length === 0) return ctx.ui.notify(`Nobody else is in ${state.network} yet. /lattice network shows the code to give a teammate.`, "info");
		const labels = others.map((person) => `${person.name}${person.online ? "" : " (away: they see it when they are back)"}`);
		const picked = to || (await ctx.ui.select(`Offer "${node.name}" to whom? It is theirs as soon as they accept; you are not asked again.\n\n${WHAT_GOES}`, labels))?.split(" ")[0];
		if (!picked) return;
		if ((await sharing(ctx, link.client, "offer", [node.id, picked])) && node.id === shared.current) ctx.ui.notify(`"${node.name}" is open here. Once ${picked} accepts, it is sent when you leave it.`, "info");
	};

	/** Ask a teammate for one of their sessions. */
	const take = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		await refresh();
		const node = named(ctx, arg);
		const link = node ? linkOf(node.id) : undefined;
		if (!node || !link) return;
		if (node.owner === link.state?.owner) return ctx.ui.notify(`"${node.name}" is already yours.`, "info");
		if (!link.state?.sharing) return ctx.ui.notify(NO_NETWORK, "info");
		const elsewhere = link.state.nodes.some((each) => each.id === node.id) ? undefined : elsewhereOf(node.id);
		if (elsewhere) return takeElsewhere(ctx, node, elsewhere.tree);
		await sharing(ctx, link.client, "ask", [node.id]);
	};

	const git = (args: string[]): Promise<void> =>
		new Promise((done, failed) => execFile("git", args, { encoding: "utf8" }, (error, _out, stderr) => (error ? failed(new Error(stderr.trim().split("\n").pop() || error.message)) : done())));

	/**
	 * Ask for a session in a repository this machine has no tree for. The repository has to be
	 * here for the session to work in, so it is cloned first, from where its owner has it, into
	 * a folder the person chooses once. Then its host is started and the session asked for.
	 */
	const takeElsewhere = async (ctx: ExtensionCommandContext, node: NodeMeta, tree: SharingTree): Promise<void> => {
		// It may be here already, with its host asleep.
		let root = shared.asleep.find((known) => known.scope === tree.scope)?.root;
		if (!root) {
			if (!tree.url) {
				ctx.ui.notify(`"${tree.repo}" has no remote on ${node.owner}'s machine, so it cannot be cloned from here. Clone it yourself, open pi in it, and ask for "${node.name}" there.`, "warning");
				return;
			}
			let into = textSetting(settings().settings, "network.cloneDir");
			if (!into) {
				const answer = await ctx.ui.input("You do not have this repository. Which folder should teammates' repositories be cloned into? (asked once; /lattice config changes it)", dirname(projectRoot(ctx.cwd)));
				if (!answer?.trim()) return;
				into = answer.trim();
				writeSetting("user", shared.home, "network.cloneDir", into);
			}
			const folder = resolve(into.replace(/^~(?=$|\/)/, homedir()));
			const dest = join(folder, tree.repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "repository");
			if (existsSync(dest)) {
				// Something is there. If it is this repository it shows up here once pi has been opened in it.
				ctx.ui.notify(`${dest} already exists. If it is ${tree.repo}, open pi there once and ask again; otherwise choose another folder with /lattice config user network.cloneDir.`, "warning");
				return;
			}
			// The address comes from a teammate's machine, so the person sees it before anything is fetched.
			const sure = await ctx.ui.confirm(`Clone ${tree.repo} to take "${node.name}"?`, `${node.owner} has it from\n  ${tree.url}\n\nIt will be cloned into\n  ${dest}\n\nCheck that this is the repository you expect.`);
			if (!sure) return;
			ctx.ui.notify(`Cloning ${tree.repo}…`, "info");
			try {
				await git(["clone", "--quiet", "--", tree.url, dest]);
			} catch (error) {
				ctx.ui.notify(`Could not clone ${tree.url}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			root = dest;
		}
		try {
			const stateDir = stateDirFor(root);
			const link = shared.links.get(stateDir) ?? addLink(await launchHost(pi.events, stateDir, root), stateDir);
			// Its host finds the owner's host for this repository; then the session is in its tree and can be asked for.
			for (const end = Date.now() + 30_000; Date.now() < end; ) {
				await refreshLink(link);
				if (link.state?.nodes.some((each) => each.id === node.id) && link.state.sharing?.people.some((person) => person.name === node.owner && person.here)) break;
				await new Promise((wait) => setTimeout(wait, 300));
			}
			if (!link.state?.nodes.some((each) => each.id === node.id)) {
				ctx.ui.notify(`${tree.repo} is at ${root}, but "${node.name}" has not shown up in it yet. Press t on it there once it does.`, "warning");
				return;
			}
			await sharing(ctx, link.client, "ask", [node.id]);
		} catch (error) {
			fail(ctx, error);
		}
	};

	/** Say yes to a teammate who asked for a session. This is the step that sends it. */
	const approve = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		await refresh();
		const [first = "", from = ""] = arg.split(/\s+/).filter(Boolean);
		const node = named(ctx, first);
		const link = node ? linkOf(node.id) : undefined;
		if (!node || !link) return;
		const asking = link.state?.sharing?.requests.filter((request) => request.role === "owner" && request.nodeId === node.id).map((request) => request.from) ?? [];
		const who = from || asking[0];
		if (!who || !asking.includes(who)) return ctx.ui.notify(`${who || "Nobody"} is ${who ? "not " : ""}asking for "${node.name}".`, "info");
		if (!(await ctx.ui.confirm(`Hand "${node.name}" to ${who}?`, WHAT_GOES))) return;
		if (await sharing(ctx, link.client, "approve", [node.id, who])) await release(ctx, node.id, true);
	};

	/** Send a session its new owner has accepted, leaving it first if it is the one open here. */
	const release = async (ctx: ExtensionCommandContext, nodeId: string, quiet = false): Promise<void> => {
		const link = linkOf(nodeId);
		if (!link) return;
		if (nodeId === shared.current) {
			await attach(undefined);
			emitEvent(pi.events, "lattice:host:assigned", { assignment: null });
		}
		await refresh();
		// The host sends it by itself once the other person has accepted; this only saves the wait.
		const ready = linkOf(nodeId)?.state?.sharing?.handoffs.some((handoff) => handoff.nodeId === nodeId && handoff.role === "owner" && handoff.state === "accepted");
		if (ready) await sharing(ctx, link.client, "confirm", [nodeId]);
		else if (!quiet) ctx.ui.notify("Nothing to send: nobody has accepted that session.", "info");
	};

	/** The session a command names, or a word about there being none. */
	const named = (ctx: ExtensionCommandContext, text: string): NodeMeta | undefined => {
		const node = text ? find(text) : shared.current ? find(shared.current) : undefined;
		if (!node) ctx.ui.notify(text ? `No session "${text}" in any tree here.` : "Say which session: its name, as the pane shows it.", "warning");
		return node;
	};

	const rename = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		await refresh();
		// Either "<session> <new name>", or just a session, whose new name is then asked for.
		const [first = "", ...rest] = arg.split(/\s+/).filter(Boolean);
		const byFirst = first ? find(first) : undefined;
		const node = byFirst ?? named(ctx, arg);
		const client = linkOf(node?.id)?.client;
		if (!node || !client) return;
		const next = (byFirst && rest.length > 0 ? rest.join(" ") : await ctx.ui.input(`Rename "${node.name}"`, node.name))?.trim();
		if (!next) return;
		const { node: renamed } = await client.ui("rename", { nodeId: node.id, name: next });
		ctx.ui.notify(`Renamed to "${renamed.name}".`, "info");
	};

	const archive = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		await refresh();
		const node = named(ctx, arg);
		const client = linkOf(node?.id)?.client;
		if (!node || !client) return;
		const { count } = await client.ui("archive", { nodeId: node.id, archived: true });
		ctx.ui.notify(`Archived "${node.name}"${count > 1 ? ` and ${count - 1} under it` : ""}. /lattice restore brings it back.`, "info");
	};

	const restore = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		const all = (await Promise.all([...shared.links.values()].map(async (link) => (await link.client.ui("archived", {}).catch(() => ({ nodes: [] as NodeMeta[] }))).nodes.map((node) => ({ node, link }))))).flat();
		// Restoring a session restores what is under it, so only the top of each archived branch is offered.
		const tops = all.filter(({ node }) => !all.some((other) => other.node.id === node.parentId));
		if (tops.length === 0) {
			ctx.ui.notify("Nothing is archived.", "info");
			return;
		}
		let pick = arg ? tops.find(({ node }) => node.id === arg || node.name === arg) : undefined;
		if (arg && !pick) {
			ctx.ui.notify(`No archived session "${arg}". Archived: ${tops.map(({ node }) => node.name).join(", ")}.`, "warning");
			return;
		}
		if (!pick) {
			const labels = tops.map(({ node, link }, index) => `${index + 1}. ${node.name}  ·  ${node.kind}${link.state ? `  ·  ${repoLabel(link.state, link.stateDir)}` : ""}`);
			const choice = await ctx.ui.select("Restore which session? Everything archived under it comes back too.", labels);
			pick = choice === undefined ? undefined : tops[labels.indexOf(choice)];
		}
		if (!pick) return;
		const { count } = await pick.link.client.ui("archive", { nodeId: pick.node.id, archived: false });
		ctx.ui.notify(`Restored "${pick.node.name}"${count > 1 ? ` and ${count - 1} under it` : ""}.`, "info");
	};

	const interrupt = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		await refresh();
		const node = named(ctx, arg);
		if (!node) return;
		if (node.id === shared.current) ctx.abort();
		else await linkOf(node.id)?.client.ui("interrupt", { nodeId: node.id });
		ctx.ui.notify(`Stopped "${node.name}".`, "info");
	};

	/**
	 * Show the settings, or change one. `/lattice config <setting> <value>` writes this repository's
	 * file; `/lattice config user <setting> <value>` writes the person's own, which every repository
	 * uses; `-` as the value clears it.
	 */
	const configure = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		const words = arg.split(/\s+/).filter(Boolean);
		const scope: SettingScope = words[0] === "user" ? "user" : "repo";
		if (words[0] === "user" || words[0] === "repo") words.shift();
		const [key = "", ...rest] = words;
		const value = rest.join(" ");
		const current = settings();
		const from = (name: string): string => ({ default: "default", user: "yours", repo: "this repository", env: "environment" })[current.settings.sources[name] ?? "default"];
		if (!key && shared.wrapped && ctx.mode === "tui") {
			// Beside the pane there is room for the whole screen, edited in place.
			openSettings();
			redraw();
			return;
		}
		if (!key) {
			const width = Math.max(...SETTINGS.map((setting) => setting.key.length));
			const lines: string[] = [];
			let section = "";
			for (const setting of SETTINGS) {
				if (setting.section !== section) lines.push("", `${setting.section}`);
				section = setting.section;
				lines.push(`  ${setting.key.padEnd(width)}  ${formatSetting(current.settings.values[setting.key])}${current.settings.sources[setting.key] === "default" ? "" : `  (${from(setting.key)})`}`);
			}
			const names = Object.keys(current.settings.env);
			ctx.ui.notify(
				[
					"Settings. Each comes from the environment, else this repository's file, else yours, else the default.",
					`  yours            ${current.paths.user}`,
					`  this repository  ${current.paths.repo ?? "(no session tree here yet)"}`,
					...lines,
					...(names.length > 0 ? ["", `  env for background sessions: ${names.join(", ")}`] : []),
					...current.problems.map((problem) => `  ! ${problem}`),
					"",
					"/lattice config <setting> <value> sets it for this repository; /lattice config user <setting> <value> for all of yours; - as the value clears it.",
				].join("\n"),
				current.problems.length > 0 ? "warning" : "info",
			);
			return;
		}
		const setting = settingOf(key);
		if (!setting) {
			const problem = parseSettingInput(key, value);
			ctx.ui.notify("problem" in problem ? problem.problem : `Unknown setting "${key}".`, "warning");
			return;
		}
		if (!value) {
			ctx.ui.notify(`${setting.key} is ${formatSetting(current.settings.values[setting.key])} (${from(setting.key)}). It takes ${settingAccepts(setting)}.\n${setting.help}`, "info");
			return;
		}
		if (scope === "repo" && !current.paths.repo) {
			ctx.ui.notify(`There is no session tree here yet to keep a repository setting in. /lattice config user ${setting.key} ${value} sets it for all your repositories.`, "warning");
			return;
		}
		const clear = value === "-";
		const parsed = clear ? { value: undefined } : parseSettingInput(setting.key, value);
		if ("problem" in parsed) {
			ctx.ui.notify(parsed.problem, "warning");
			return;
		}
		const path = writeSetting(scope, shared.home, setting.key, parsed.value);
		const now = settings();
		const shadowed = now.settings.sources[setting.key] === "env" ? ` ${setting.env} is set in the environment and wins.` : scope === "user" && now.settings.sources[setting.key] === "repo" ? " This repository sets its own, which wins here." : "";
		ctx.ui.notify(`${setting.key} ${clear ? "cleared" : `set to ${formatSetting(parsed.value)}`} in ${path}.${shadowed} ${setting.applies}`, "info");
		redraw();
	};

	/**
	 * Show everything this session is told that the person did not type: its roles, in full and
	 * in order, and the texts pi-lattice writes, each with the file it comes from.
	 */
	const prompt = async (ctx: ExtensionCommandContext): Promise<void> => {
		const request: { parts: Array<{ title: string; source: string; where: string; text: string }> } = { parts: [] };
		emitEvent(pi.events, "lattice:prompt:describe", request);
		const WHOSE = { builtin: "built in", user: "yours", repo: "this repository's" } as const;
		const out: string[] = [
			"What this session is told beyond what you type. Each part says where it comes from; change it with /role edit <name> or /lattice template <name>.",
			"",
			request.parts.length > 0 ? `ROLES, as sections of the system prompt (${request.parts.filter((part) => part.title.startsWith("Role: ")).length} applied, in this order)` : "ROLES: none applied to this session. /role add <name> applies one.",
		];
		for (const part of request.parts) out.push("", `── ${part.title} · ${part.source}`, `   ${part.where}`, "", part.text);
		out.push("", "", "TEXTS PI-LATTICE WRITES into a session as it runs");
		for (const name of TEMPLATE_NAMES) {
			const template = readTemplate(name, treeDir());
			out.push("", `── ${name} · ${WHOSE[template.source]}${template.path ? ` · ${template.path}` : ""}`, `   ${TEMPLATES[name].summary}`, "", template.text.trim());
		}
		out.push("", "", "NOT EDITABLE: a message from another agent arrives wrapped in <lattice-message>, followed by a line saying it is from a peer and not from you. That wrapper is what keeps one agent from giving another orders in your name, so it is fixed.");
		const text = out.join("\n");
		if (ctx.mode === "tui") await ctx.ui.editor("What this session is told (read-only; changes here are not saved)", text);
		else ctx.ui.notify(text, "info");
	};

	/** List the templates, or edit one. Saving writes the person's own copy; saving it empty removes that copy. */
	const template = async (ctx: ExtensionCommandContext, arg: string): Promise<void> => {
		const [name = "", scopeWord] = arg.split(/\s+/).filter(Boolean);
		const WHOSE = { builtin: "built in", user: "yours", repo: "this repository's" } as const;
		if (!name) {
			const width = Math.max(...TEMPLATE_NAMES.map((each) => each.length));
			ctx.ui.notify(
				["The texts pi-lattice writes into a session. /lattice template <name> edits one.", ...TEMPLATE_NAMES.map((each) => `  ${each.padEnd(width)}  ${WHOSE[readTemplate(each, treeDir()).source].padEnd(17)}  ${TEMPLATES[each].summary}`)].join("\n"),
				"info",
			);
			return;
		}
		if (!isTemplateName(name) || (scopeWord !== undefined && scopeWord !== "user" && scopeWord !== "repo")) {
			ctx.ui.notify(`Usage: /lattice template [${TEMPLATE_NAMES.join("|")}] [user|repo]`, "warning");
			return;
		}
		const scope: SettingScope = scopeWord ?? "user";
		if (scope === "repo" && !treeDir()) {
			ctx.ui.notify("There is no session tree here yet to keep a repository's template in.", "warning");
			return;
		}
		const path = templatePath(name, scope, treeDir());
		const current = existsSync(path) ? readFileSync(path, "utf8") : readTemplate(name, treeDir()).text;
		const names = TEMPLATES[name].vars.map((each) => `{{${each}}}`).join(" ");
		const text = await ctx.ui.editor(`Template "${name}"${names ? ` · may mention ${names}` : ""} · saving writes ${scope === "user" ? "your own copy" : "this repository's copy"}: ${path} · save it empty to remove that copy`, current);
		if (text === undefined) return;
		if (text.trim() === "") {
			writeTemplate(name, scope, treeDir(), undefined);
			ctx.ui.notify(`Removed ${path}. "${name}" is the ${WHOSE[readTemplate(name, treeDir()).source]} text again.`, "info");
			return;
		}
		writeTemplate(name, scope, treeDir(), text);
		const used = readTemplate(name, treeDir());
		ctx.ui.notify(`Saved ${path}.${used.path !== path ? ` Another copy wins here: ${used.path}.` : ""} It is used from the next time pi-lattice writes it.`, "info");
	};

	/** Stop the host of this repository and start it again, keeping this terminal's session where it is. */
	const restart = async (ctx: ExtensionCommandContext): Promise<void> => {
		const stateDir = shared.home;
		const client = need(ctx);
		if (!client || !stateDir) return;
		const open = shared.current;
		await attach(undefined);
		await client.ui("shutdown", {}).catch(() => {});
		client.close();
		shared.links.delete(stateDir);
		const end = Date.now() + 20_000;
		while (existsSync(join(stateDir, "host.json")) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
		const link = addLink(await launchHost(pi.events, stateDir, ctx.cwd), stateDir);
		await refreshLink(link);
		if (open && link.state?.nodes.some((node) => node.id === open)) await attach(open);
		emitEvent(pi.events, "lattice:host:assigned", { assignment: shared.current ? (shared.assignment ?? null) : null });
		await refresh();
		ctx.ui.notify("The host was restarted. Background sessions start again as soon as they have work, with the current settings.", "info");
	};

	/** Check everything the pane depends on and say what to do about what is wrong. */
	const doctor = async (ctx: ExtensionCommandContext): Promise<void> => {
		const lines: string[] = [];
		let failed = false;
		const check = (ok: boolean | "warn", what: string, fix?: string): void => {
			if (ok === false) failed = true;
			lines.push(`${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${what}${ok !== true && fix ? `\n    ${fix}` : ""}`);
		};
		const stateDir = stateDirFor(ctx.cwd);
		const model = ctx.model;
		check(model !== undefined, model ? `Model: ${model.provider}/${model.id}` : "No model is selected", "Run /login, then pick one with /model.");
		if (model) check(ctx.modelRegistry.hasConfiguredAuth(model), `Credentials for ${model.provider}`, "Run /login, or set the provider's API key.");
		const repository = inRepository(ctx.cwd);
		check(repository ? true : "warn", repository ? `Repository: ${projectRoot(ctx.cwd)}` : `${ctx.cwd} is not in a git repository`, "Sessions work here, but a tree is not started by itself (run /lattice) and children cannot have their own worktree.");
		check(shared.wrapped ? true : "warn", shared.wrapped ? "The side pane is installed" : "The side pane could not be installed in this Pi", "Two rows above the editor and /lattice status are used instead. pi-lattice was built against Pi 1.5.");
		const columns = shared.tui?.terminal.columns ?? 0;
		if (columns > 0) check(columns >= MIN_TERMINAL_WIDTH ? true : "warn", `Terminal: ${columns} columns`, `Below ${MIN_TERMINAL_WIDTH} columns the pane becomes two rows above the editor; alt+l still opens it.`);
		const tree = hasTree(stateDir);
		check(tree ? true : "warn", tree ? `Tree: ${stateDir}` : "No session tree in this repository yet", repository ? "It starts with your first message." : "Run /lattice to start one.");
		const link = homeLink();
		if (tree) check(link !== undefined && !link.client.isClosed, link?.state ? `Host running as ${link.state.owner}, ${link.state.nodes.length} session${link.state.nodes.length === 1 ? "" : "s"}` : "The host is not running", `Run /lattice to start it. Its log is ${join(stateDir, "daemon.log")}.`);
		if (tree) check(shared.current ? true : "warn", shared.current ? `This session is "${name(shared.current)}" in the tree` : "This session is not in the tree yet", "It joins with its first message, or with /lattice.");
		const read = settings();
		const set = SETTINGS.filter((setting) => read.settings.sources[setting.key] !== "default").map((setting) => `${setting.key} ${formatSetting(read.settings.values[setting.key])}`);
		check(read.problems.length === 0, `Settings: ${set.length > 0 ? set.join(", ") : "defaults"}`, read.problems.join(" "));
		const roles = { names: [] as string[] };
		emitEvent(pi.events, "lattice:roles:available", roles);
		check(roles.names.length > 0 ? true : "warn", `Roles: ${roles.names.length} available`, "The roles extension is not loaded, so sessions cannot be given roles.");
		const others = [...shared.links.keys()].filter((dir) => dir !== shared.home).length;
		check(true, `Other repositories: ${others} running, ${shared.asleep.length} asleep`);
		try {
			const recent = readFileSync(join(stateDir, "daemon.log"), "utf8").trim().split("\n").slice(-40).filter((line) => / (error|warn) /.test(line));
			const last = recent[recent.length - 1];
			if (last) check("warn", "The host logged a problem recently", last.slice(0, 300));
		} catch {
			// No log yet.
		}
		ctx.ui.notify(lines.join("\n"), failed ? "warning" : "info");
	};

	/** Show the tree as text, for a terminal where the pane cannot be shown. */
	const status = async (ctx: ExtensionCommandContext): Promise<void> => {
		await refresh();
		const state = homeLink()?.state;
		ctx.ui.notify(
			state
				? [`Tree of ${state.nodes.length} session${state.nodes.length === 1 ? "" : "s"}, as ${state.owner}. Open here: ${shared.current ? name(shared.current) : "none"}.`, ...renderCompact(view(), 30), "alt+l focuses the pane · /lattice new · /lattice approvals · /lattice network"].join("\n")
				: "No session tree here yet. Run /lattice to start one.",
			"info",
		);
	};

	/** Stop this repository's host. Its sessions are kept and come back when it next starts. */
	const stop = async (ctx: ExtensionCommandContext): Promise<void> => {
		const client = need(ctx);
		if (!client) return;
		await attach(undefined);
		emitEvent(pi.events, "lattice:host:assigned", { assignment: null });
		await client.ui("shutdown", {}).catch(() => {});
		client.close();
		if (shared.home) shared.links.delete(shared.home);
		redraw();
		ctx.ui.notify("The lattice host is stopping. Sessions are saved and come back with /lattice.", "info");
	};

	/**
	 * Everything `/lattice` does, in the order `/lattice help` lists it. The completions, the help
	 * and what runs all come from this one table, so a command cannot be in one and not another.
	 */
	const COMMANDS: ReadonlyArray<{ name: string; usage?: string; does: string; run(ctx: ExtensionCommandContext, arg: string): Promise<void> | void }> = [
		{ name: "open", usage: "open <session>", does: "open a session here, from any repository", run: (ctx, arg) => open(ctx, arg) },
		{
			name: "back", does: "return to the session you were in before",
			run: (ctx) => (shared.previous ? open(ctx, shared.previous) : ctx.ui.notify("There is no earlier session to go back to.", "info")),
		},
		{ name: "new", usage: "new [session]", does: "create a child session", run: (ctx, arg) => create(ctx, arg) },
		{ name: "rename", usage: "rename <session> [name]", does: "rename a session", run: (ctx, arg) => rename(ctx, arg) },
		{ name: "interrupt", usage: "interrupt <session>", does: "stop what a session's agent is doing", run: (ctx, arg) => interrupt(ctx, arg) },
		{
			name: "sleep", usage: "sleep <session>", does: "stop a background session's process until it has work",
			run: async (ctx, arg) => {
				await refresh();
				const node = named(ctx, arg);
				if (!node) return;
				await linkOf(node.id)?.client.ui("sleep", { nodeId: node.id });
				ctx.ui.notify(`"${node.name}" is asleep. It wakes when it has work, or when you open it.`, "info");
			},
		},
		{ name: "archive", usage: "archive <session>", does: "hide a session and everything under it", run: (ctx, arg) => archive(ctx, arg) },
		{ name: "restore", usage: "restore [session]", does: "bring archived sessions back", run: (ctx, arg) => restore(ctx, arg) },
		{
			name: "answer", usage: "answer <session>", does: "answer the questions a session is waiting on",
			run: async (ctx, arg) => {
				await refresh();
				const node = named(ctx, arg);
				if (!node) return;
				const waiting = linkOf(node.id)?.state?.attention[node.id]?.dialogs ?? 0;
				if (waiting === 0) ctx.ui.notify(`"${node.name}" is not waiting on a question.`, "info");
				else await answer(ctx, node);
			},
		},
		{ name: "approvals", does: "review messages waiting for approval", run: (ctx) => approvals(ctx) },
		{ name: "network", does: "create or join a network of teammates; who is in it, the join code, what is being handed over", run: (ctx) => network(ctx) },
		{ name: "offer", usage: "offer <session> [person]", does: "offer one of your sessions to a teammate", run: (ctx, arg) => offer(ctx, arg) },
		{ name: "take", usage: "take <session>", does: "ask a teammate for one of their sessions", run: (ctx, arg) => take(ctx, arg) },
		{ name: "approve", usage: "approve <session> [person]", does: "hand a session to the teammate who asked for it", run: (ctx, arg) => approve(ctx, arg) },
		{ name: "release", usage: "release <session>", does: "send a session its new owner accepted, without waiting", run: async (ctx, arg) => void (await refresh(), named(ctx, arg) && (await release(ctx, (named(ctx, arg) as NodeMeta).id))) },
		{ name: "status", does: "list the tree", run: (ctx) => status(ctx) },
		{ name: "config", usage: "config [user] [setting] [value]", does: "open the settings, or show or change one, for this repository or for all of yours", run: (ctx, arg) => configure(ctx, arg) },
		{ name: "prompt", does: "show what this session is told beyond what you type, and where each part comes from", run: (ctx) => prompt(ctx) },
		{ name: "template", usage: "template [name] [user|repo]", does: "list or edit the texts pi-lattice writes: the brief, the handover note, the reminders", run: (ctx, arg) => template(ctx, arg) },
		{ name: "doctor", does: "check that everything the pane needs is working", run: (ctx) => doctor(ctx) },
		{ name: "restart", does: "restart this repository's background host", run: (ctx) => restart(ctx) },
		{ name: "stop", does: "stop this repository's background host", run: (ctx) => stop(ctx) },
		// The other lattice commands answer here too, so there is one name to remember.
		...(["inbox", "role", "peers", "node", "children"] as const).map((other) => ({
			name: other, usage: `${other} …`, does: `the same as /${other}`,
			run: (_ctx: ExtensionCommandContext, arg: string) => dispatch(`/${other} ${arg}`.trim()),
		})),
	];
	const help = (ctx: ExtensionCommandContext, level: "info" | "warning"): void => {
		const width = Math.max(...COMMANDS.map((command) => (command.usage ?? command.name).length));
		ctx.ui.notify(["/lattice, then:", ...COMMANDS.map((command) => `  ${(command.usage ?? command.name).padEnd(width)}  ${command.does}`), "With the pane focused (alt+l), ? lists its keys."].join("\n"), level);
	};

	pi.registerCommand("lattice", {
		description: "Session tree. /lattice help lists everything it does",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			if (words.length <= 1) {
				const matches = [...COMMANDS, { name: "help", does: "list every command" }].filter((command) => command.name.startsWith(words[0] ?? ""));
				return matches.length > 0 ? matches.map((command) => ({ value: command.name, label: command.name, description: command.does })) : null;
			}
			const matches = everyNode().filter((node) => node.name.startsWith(words[1] ?? ""));
			return matches.length > 0 ? matches.map((node) => ({ value: `${words[0]} ${node.id}`, label: node.name, description: `${node.owner} · ${node.kind}` })) : null;
		},
		handler: async (args, ctx) => {
			shared.pi = pi;
			shared.ctx = ctx;
			const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			try {
				// A first message may be starting a tree right now; let it finish so the session is not adopted twice.
				for (const end = Date.now() + 25_000; shared.starting && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 50));
				const command = COMMANDS.find((candidate) => candidate.name === sub);
				// With no argument: bring this session into the tree if it is not in it yet; otherwise show the tree.
				if (sub === "") await (shared.current ? status(ctx) : begin(ctx));
				else if (command) await command.run(ctx, arg);
				else help(ctx, sub === "help" ? "info" : "warning");
			} catch (error) {
				fail(ctx, error);
			}
			redraw();
		},
	});
}

/** A conversation as plain text, for reading another person's session. */
function transcriptText(messages: unknown[]): string {
	const out: string[] = [];
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown; toolName?: string };
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => part.text ?? "").join("")
				: "";
		if (message.role === "user" || message.role === "custom") out.push(`> ${text}`);
		else if (message.role === "assistant" && text.trim() !== "") out.push(text);
		else if (message.role === "toolResult") out.push(`[${message.toolName ?? "tool"}] ${text.split("\n")[0] ?? ""}`);
	}
	return out.join("\n\n");
}

