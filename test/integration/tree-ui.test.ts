import { childrenOf } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LatticeHost, TreeApp } from "../../packages/host/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

/** A terminal that renders nowhere and lets the test type. */
class FakeTerminal {
	columns = 120;
	rows = 40;
	kittyProtocolActive = false;
	private onInput: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	type(data: string): void {
		this.onInput?.(data);
	}
}

const KEY = { enter: "\r", esc: "\x1b", down: "\x1b[B", up: "\x1b[A", ctrlT: "\x14", ctrlN: "\x0e", ctrlA: "\x01", ctrlC: "\x03" };

let sandbox: Sandbox;
let host: LatticeHost;
let app: TreeApp;
let terminal: FakeTerminal;

beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(async () => {
	app?.stop();
	await host?.stop();
	sandbox.cleanup();
});

const open = async (overrides: Record<string, unknown> = {}, root: { fragments?: string[] } = {}) => {
	host = await LatticeHost.start(hostOptionsFor(sandbox, overrides));
	const node = await host.createRoot({ name: "checkout", cwd: sandbox.work, ...root });
	terminal = new FakeTerminal();
	app = new TreeApp({ host, rootId: node.id, terminal: terminal as never, fragments: () => [{ value: "worker", label: "worker" }, { value: "planning", label: "planning" }] });
	app.start();
	return node;
};
const screen = (needle: string, timeoutMs = 15_000) => eventually(() => (app.text().includes(needle) ? app.text() : undefined), `screen to show "${needle}"`, timeoutMs);
const typeLine = (text: string) => {
	terminal.type(text);
	terminal.type(KEY.enter);
};
const sendTool = (to: string, text: string) => `!tool send_message ${JSON.stringify({ to, text })}`;

describe("tree UI", () => {
	it("shows the tree and the attached session, and sends what is typed to it", async () => {
		const root = await open({}, { fragments: ["coordinator"] });
		await screen("checkout feature");
		typeLine("hello from the human");
		const text = await screen("echo[user] roles=[lattice-role-coordinator] hello from the human");
		expect(text).toContain("pi-lattice");
		expect(text).toContain("1 session");
		expect(host.node(root.id)?.status).toBeDefined();
	});

	it("navigates to a child and types into it, without anything bubbling up", async () => {
		const root = await open();
		const kid = await host.spawnChild(root.id, { name: "grilling", kind: "grilling", brief: "wait for the human" });
		await screen("grilling grilling");

		terminal.type(KEY.ctrlT);
		terminal.type(KEY.down);
		terminal.type(KEY.enter);
		expect(app.current).toBe(kid.id);
		await screen("wait for the human"); // the child's own history, including its brief

		typeLine("only for the child");
		await screen("echo[user] roles=[] only for the child");
		const { messages } = await host.rpc<{ messages: Array<{ role: string; content: unknown }> }>(root.id, { type: "get_messages" });
		expect(JSON.stringify(messages)).not.toContain("only for the child");
	});

	it("spawns a child from the UI with a role picker", async () => {
		const root = await open();
		await screen("checkout feature");
		terminal.type(KEY.ctrlN);
		await screen("New child session");
		typeLine("payments");
		await screen("Kind");
		terminal.type(KEY.enter); // accept "task"
		await screen("Roles");
		terminal.type(KEY.down); // worker
		terminal.type(KEY.enter); // toggle
		await screen("[x] worker");
		terminal.type(KEY.up); // Done
		terminal.type(KEY.enter);
		await screen("Workspace");
		terminal.type(KEY.enter); // shared
		await screen("Brief");
		typeLine("take payments apart");

		const kid = await eventually(() => childrenOf(host.nodes(), root.id)[0], "child created from the UI");
		expect(kid).toMatchObject({ name: "payments", kind: "task", fragments: ["worker"], workspace: "shared", brief: "take payments apart" });
		await screen("payments task");
	});

	it("cancels the spawn form with escape and creates nothing", async () => {
		const root = await open();
		terminal.type(KEY.ctrlN);
		await screen("New child session");
		terminal.type(KEY.esc);
		await eventually(() => app.activeModal === undefined, "modal to close");
		expect(childrenOf(host.nodes(), root.id)).toHaveLength(0);
	});

	it("puts a blocking dialog in front of the human and answers it", async () => {
		const root = await open({ env: { ...hostOptionsFor(sandbox).env, LATTICE_APPROVAL: "always" } });
		await host.spawnChild(root.id, { name: "kid", brief: sendTool("parent", "may I?") });
		await screen("1 message waiting for approval");

		typeLine("/inbox"); // the extension opens a dialog inside the session
		const text = await screen("checkout asks:");
		expect(text).toContain("Approve");
		expect(host.node(root.id)?.status).toBe("blocked");
		terminal.type(KEY.enter); // Approve
		await screen("may I?");
		await eventually(() => host.pendingMail().length === 0, "approval to clear");
	});

	it("approves held mail from the approvals list", async () => {
		const root = await open({ env: { ...hostOptionsFor(sandbox).env, LATTICE_APPROVAL: "always" } });
		await host.spawnChild(root.id, { name: "kid", brief: sendTool("parent", "approve me from the list") });
		await screen("1 message waiting for approval");
		expect(app.text()).toContain("✉ 1");

		terminal.type(KEY.ctrlA);
		await screen("Messages waiting for approval");
		terminal.type(KEY.enter); // pick the message
		await screen("deliver it to the agent");
		terminal.type(KEY.enter); // Approve
		await eventually(() => host.pendingMail().length === 0, "approval to clear");
		await screen("approve me from the list");
		expect(host.node(root.id)).toBeDefined();
	});

	it("flags a session that is waiting on the human while another is attached", async () => {
		const root = await open({ env: { ...hostOptionsFor(sandbox).env, LATTICE_APPROVAL: "always" } });
		const kid = await host.spawnChild(root.id, { name: "kid", brief: "wait" });
		await eventually(() => host.node(kid.id)?.status === "idle", "kid idle");
		await host.prompt(root.id, sendTool(kid.id, "for the kid"));
		await eventually(() => host.pendingMail().length === 1, "pending mail for the kid");
		void host.prompt(kid.id, "/inbox").catch(() => {});
		const text = await screen("Waiting on you: kid");
		expect(text).toContain("? 1");
		expect(app.activeModal).toBeUndefined(); // not attached to the kid, so no modal is forced on the human

		terminal.type(KEY.ctrlT);
		terminal.type(KEY.down);
		terminal.type(KEY.enter);
		await screen("kid asks:");
	});

	it("shows a sleeping session as asleep and wakes it when the human writes to it", async () => {
		const root = await open();
		const kid = await host.spawnChild(root.id, { name: "sleeper", brief: "remember saffron" });
		await eventually(() => host.node(kid.id)?.status === "idle", "kid idle");
		await host.sleep(kid.id);
		await eventually(() => host.node(kid.id)?.status === "dormant", "kid dormant");

		terminal.type(KEY.ctrlT);
		terminal.type(KEY.down);
		terminal.type(KEY.enter);
		await screen("This session is asleep");
		expect(host.isRunning(kid.id)).toBe(false);

		typeLine("are you there?");
		const text = await screen("are you there?", 20_000);
		await screen("saffron");
		expect(text).toBeDefined();
		expect(host.isRunning(kid.id)).toBe(true);
	});

	it("quits on a second ctrl+c and leaves sessions resumable", async () => {
		const root = await open();
		await screen("checkout feature");
		terminal.type(KEY.ctrlC);
		await screen("Press ctrl+c again to quit");
		terminal.type(KEY.ctrlC);
		await app.done;
		expect(host.node(root.id)?.sessionFile).toBeTruthy();
	});
});
