import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession, Identity, PeerBook, TcpTransport } from "../../packages/collab/src/index.ts";
import { LatticeHost, TreeApp } from "../../packages/host/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

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
const KEY = { enter: "\r", down: "\x1b[B", ctrlO: "\x0f", ctrlT: "\x14" };

interface Seat {
	sandbox: Sandbox;
	host: LatticeHost;
	collab: CollabSession;
	app: TreeApp;
	terminal: FakeTerminal;
	screen(needle: string): Promise<string>;
}
let seats: Seat[] = [];
beforeEach(() => {
	seats = [];
});
afterEach(async () => {
	for (const seat of seats) {
		seat.app.stop();
		await seat.collab.stop().catch(() => {});
		await seat.host.stop().catch(() => {});
		seat.sandbox.cleanup();
	}
});

const sit = async (name: string, withRoot: boolean): Promise<Seat> => {
	const sandbox = createSandbox();
	const host = await LatticeHost.start(hostOptionsFor(sandbox, { owner: name }));
	const root = withRoot ? await host.createRoot({ name: "checkout", cwd: sandbox.work }) : undefined;
	const collab = new CollabSession({
		host, identity: Identity.loadOrCreate(join(sandbox.root, "keys"), name), peers: new PeerBook(join(sandbox.root, "peers.json")),
		transport: new TcpTransport({ host: "127.0.0.1", port: 0 }), dir: join(sandbox.root, "collab"), projectDir: sandbox.work, advertise: "127.0.0.1", redialMs: 200,
	});
	await collab.start();
	const terminal = new FakeTerminal();
	const app = new TreeApp({ host, rootId: root?.id, collab, terminal: terminal as never, clipboard: async () => false });
	app.start();
	const seat: Seat = {
		sandbox, host, collab, app, terminal,
		screen: (needle) =>
			eventually(() => (app.text().includes(needle) ? app.text() : undefined), `${name}'s screen to show "${needle}"`).catch((error: Error) => {
				throw new Error(`${error.message}\n--- screen ---\n${app.text()}`);
			}),
	};
	seats.push(seat);
	return seat;
};

describe("sharing in the tree interface", () => {
	it("walks both people through pairing and a two-phase handoff", async () => {
		const yan = await sit("yan", true);
		const sam = await sit("sam", false);
		const rootId = yan.host.nodes()[0]?.id ?? "";

		// Sam starts with nothing, and pairs using the invite yan read out.
		await sam.screen("No sessions yet");
		yan.terminal.type(KEY.ctrlO);
		await yan.screen("Show my invite");
		yan.terminal.type(KEY.down); // past "Offer ..."
		yan.terminal.type(KEY.enter);
		const shown = await yan.screen("Send this to the person you want to work with");
		const invite = (shown.split("\n").find((line) => line.includes("yan@")) ?? "").replace(/[│\s]/g, "");
		expect(invite).toBe(yan.collab.invite());
		yan.terminal.type(KEY.enter);

		sam.terminal.type(KEY.ctrlO);
		await sam.screen("Pair using someone's invite");
		sam.terminal.type(KEY.down); // "Show my invite" is first; the next is "Pair using someone's invite"
		sam.terminal.type(KEY.enter);
		await sam.screen("Paste the invite");
		sam.terminal.type(invite);
		sam.terminal.type(KEY.enter);

		// Yan is told sam knocked, checks the fingerprint, and pairs.
		await yan.screen("sam wants to connect; pair with them to allow it (ctrl+o)");
		expect(sam.app.text()).not.toContain("checkout feature");
		yan.terminal.type(KEY.ctrlO);
		await yan.screen("Pair with sam");
		yan.terminal.type(KEY.enter); // first entry
		const prompt = await yan.screen("Key fingerprint:");
		expect(prompt).toContain(sam.collab.people().find((p) => p.self)?.fingerprint ?? "missing");
		yan.terminal.type(KEY.down);
		yan.terminal.type(KEY.enter); // "The fingerprint matches; pair"

		// Sam's host reconnects on its own and yan's session appears, readable but not runnable.
		const tree = await sam.screen("checkout feature @yan");
		expect(tree).toBeDefined();
		await sam.screen("Read-only: this session is owned by yan");

		// Yan offers the node.
		yan.terminal.type(KEY.ctrlO);
		await yan.screen('Offer "checkout" to someone');
		yan.terminal.type(KEY.enter);
		await yan.screen("Offer to whom?");
		yan.terminal.type(KEY.enter); // sam
		await eventually(() => yan.collab.handoffs().length === 1, "yan's offer to be recorded");

		// Sam is told, and accepts.
		await sam.screen('yan offers you "checkout" (ctrl+o)');
		sam.terminal.type(KEY.ctrlO);
		await sam.screen('Accept "checkout" from yan');
		sam.terminal.type(KEY.enter);
		await eventually(() => sam.collab.handoffs()[0]?.state === "accepted", "sam's acceptance to be recorded");
		expect(yan.host.node(rootId)?.owner).toBe("yan"); // nothing has moved yet

		// Yan is told, sees what releasing means, and confirms.
		await yan.screen('sam accepted "checkout"; confirm the release (ctrl+o)');
		yan.terminal.type(KEY.ctrlO);
		await yan.screen('Confirm release of "checkout" to sam');
		yan.terminal.type(KEY.enter);
		const warning = await yan.screen("sends its whole conversation");
		expect(warning).toContain("directly to the new owner");
		expect(warning).toContain("After this you can no longer run it");
		yan.terminal.type(KEY.down);
		yan.terminal.type(KEY.enter); // "Release it"
		await eventually(() => yan.host.node(rootId)?.owner === "sam", "yan to release the node");
		await yan.screen("checkout feature @sam");

		// Sam now owns it and can talk to it.
		await eventually(() => sam.host.node(rootId)?.owner === "sam", "sam to take the node over");
		sam.terminal.type(KEY.ctrlT);
		sam.terminal.type(KEY.enter);
		sam.terminal.type("mine now");
		sam.terminal.type(KEY.enter);
		await sam.screen("echo[user] roles=[] mine now");

		// When sam goes offline, yan's tree greys the node out.
		await sam.collab.stop();
		await yan.screen("checkout feature @sam offline");
	}, 120_000);
});
