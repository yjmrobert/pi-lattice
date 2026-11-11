import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession, GitSharedStore, Identity, TrustStore } from "../../packages/collab/src/index.ts";
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
let shared: Sandbox;
beforeEach(() => {
	shared = createSandbox();
	seats = [];
});
afterEach(async () => {
	for (const seat of seats) {
		seat.app.stop();
		await seat.collab.stop().catch(() => {});
		await seat.host.stop().catch(() => {});
		seat.sandbox.cleanup();
	}
	shared.cleanup();
});

const sit = async (name: string, remote: string, withRoot: boolean): Promise<Seat> => {
	const sandbox = createSandbox();
	const host = await LatticeHost.start(hostOptionsFor(sandbox, { owner: name }));
	const root = withRoot ? await host.createRoot({ name: "checkout", cwd: sandbox.work }) : undefined;
	const collab = new CollabSession({
		host, identity: Identity.loadOrCreate(join(sandbox.root, "keys"), name), trust: new TrustStore(join(sandbox.root, "trusted.json")),
		store: new GitSharedStore({ remote, dir: join(sandbox.root, "shared"), author: name }), dir: join(sandbox.root, "collab"), projectDir: sandbox.work, pollMs: 0,
	});
	await collab.start();
	const terminal = new FakeTerminal();
	const app = new TreeApp({ host, rootId: root?.id, collab, terminal: terminal as never });
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
	it("walks both people through trust and a two-phase handoff", async () => {
		const remote = join(shared.root, "shared.git");
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
		const yan = await sit("yan", remote, true);
		const sam = await sit("sam", remote, false);
		const rootId = yan.host.nodes()[0]?.id ?? "";

		// Sam joined with nothing, and sees nothing of yan's until trusting yan's key.
		await sam.screen("No sessions yet");
		const notice = await sam.screen("yan joined; their sessions stay hidden until you trust their key");
		expect(notice).not.toContain("checkout feature");

		sam.terminal.type(KEY.ctrlO);
		await sam.screen("Trust yan");
		sam.terminal.type(KEY.enter); // "Trust yan" is the first entry
		const prompt = await sam.screen("Key fingerprint:");
		expect(prompt).toContain(yan.collab.people().find((p) => p.self)?.fingerprint ?? "missing");
		expect(prompt).toContain("Compare it with yan over a channel you already trust");
		sam.terminal.type(KEY.down);
		sam.terminal.type(KEY.enter); // "The fingerprint matches"
		const tree = await sam.screen("checkout feature @yan");
		expect(tree).toContain("owned by yan and runs on their machine");

		// Yan trusts sam and offers the node.
		await yan.collab.sync();
		await yan.screen("sam joined");
		await yan.collab.trustPerson("sam");
		yan.terminal.type(KEY.ctrlO);
		await yan.screen('Offer "checkout" to someone');
		yan.terminal.type(KEY.enter);
		await yan.screen("Offer to whom?");
		yan.terminal.type(KEY.enter); // sam
		await eventually(() => yan.collab.handoffs().length === 1, "yan's offer to be recorded");

		// Sam is told, and accepts.
		await sam.collab.sync();
		await sam.screen('yan offers you "checkout" (ctrl+o)');
		sam.terminal.type(KEY.ctrlO);
		await sam.screen('Accept "checkout" from yan');
		sam.terminal.type(KEY.enter);
		await eventually(() => sam.collab.handoffs()[0]?.state === "accepted", "sam's acceptance to be recorded");
		expect(yan.host.node(rootId)?.owner).toBe("yan"); // nothing has moved yet

		// Yan is told, sees what releasing means, and confirms.
		await yan.collab.sync();
		await yan.screen('sam accepted "checkout"; confirm the release (ctrl+o)');
		yan.terminal.type(KEY.ctrlO);
		await yan.screen('Confirm release of "checkout" to sam');
		yan.terminal.type(KEY.enter);
		const warning = await yan.screen("sends its whole conversation");
		expect(warning).toContain("After this you can no longer run it");
		yan.terminal.type(KEY.down);
		yan.terminal.type(KEY.enter); // "Release it"
		await eventually(() => yan.host.node(rootId)?.owner === "sam", "yan to release the node");
		await yan.screen("checkout feature @sam");
		await yan.screen("owned by sam and runs on their machine");

		// Sam now owns it and can talk to it.
		await sam.collab.sync();
		await eventually(() => sam.host.node(rootId)?.owner === "sam", "sam to take the node over");
		sam.terminal.type(KEY.ctrlT);
		sam.terminal.type(KEY.enter);
		sam.terminal.type("mine now");
		sam.terminal.type(KEY.enter);
		await sam.screen("echo[user] roles=[] mine now");
	}, 120_000);
});
