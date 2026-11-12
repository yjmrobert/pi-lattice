import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostClient, UiState } from "@pi-lattice/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, runDaemon } from "../../packages/app/src/index.ts";
import { joinAndSave } from "../../packages/app/src/work.ts";
import { connectHost } from "../../packages/pane/src/index.ts";
import { WorkServer } from "../../packages/server/src/index.ts";
import { createSandbox, directorScript, eventually, extensionPaths, hostOptionsFor, type PiChild, piCli, type RpcEvent, type Sandbox, startPi } from "../support/harness.ts";

/**
 * What a person does, through a real Pi and its prompts: join the team's server, see a teammate's
 * session in a repository they do not have, read it, and take it, which clones the
 * repository. The teammate is a background host with its own home on this computer.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fauxArgs = ["-e", extensionPaths.faux, "--provider", "lattice-faux", "--model", "scripted", "--no-skills", "--no-context-files"];

let sandboxes: Sandbox[] = [];
let pi: PiChild | undefined;
let teammate: Daemon | undefined;
let clients: HostClient[] = [];
let hostDirs: string[] = [];
let server: WorkServer | undefined;
/** Start a team's server and give the address people join it with. */
const serve = async (): Promise<string> => {
	server = new WorkServer({ file: ":memory:", host: "127.0.0.1" });
	return `http://127.0.0.1:${await server.start()}/#${server.tracker.code}`;
};
afterEach(async () => {
	await pi?.stop().catch(() => {});
	for (const client of clients) client.close();
	await teammate?.stop().catch(() => {});
	for (const dir of hostDirs) {
		try {
			const { pid } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as { pid: number };
			process.kill(pid, "SIGTERM");
			await eventually(() => !existsSync(join(dir, "host.json")), "a host to stop", 10_000);
		} catch {
			// Already stopped.
		}
	}
	for (const sandbox of sandboxes) sandbox.cleanup();
	sandboxes = [];
	clients = [];
	hostDirs = [];
	pi = undefined;
	teammate = undefined;
	await server?.stop();
	server = undefined;
});

describe("teammates, through the pane", () => {
	it("joins the server with one command, reads a teammate's session in a repository that is not here, and takes it by cloning", async () => {
		const address = await serve();
		const scratch = createSandbox();
		const yanBox = createSandbox();
		const samBox = createSandbox();
		sandboxes = [scratch, yanBox, samBox];

		// Two repositories: yan works in shop; sam works in api, which yan does not have.
		const repository = (name: string, into: string, who: string): string => {
			const origin = join(scratch.root, `${name}.git`);
			git(scratch.root, "init", "-q", "--bare", "-b", "main", origin);
			git(into, "init", "-q", "-b", "main");
			git(into, "config", "user.email", `${who}@example.com`);
			git(into, "config", "user.name", who);
			writeFileSync(join(into, "README.md"), `${name}\n`);
			git(into, "add", ".");
			git(into, "commit", "-q", "-m", "init");
			git(into, "remote", "add", "origin", origin);
			git(into, "push", "-q", "origin", "main");
			return origin;
		};
		repository("shop", yanBox.work, "yan");
		const apiOrigin = repository("api", samBox.work, "sam");

		// Yan's own Pi, in shop. Nothing about sharing is set up.
		const shopState = join(yanBox.work, ".lattice");
		hostDirs.push(shopState);
		pi = await startPi(yanBox, {
			name: "terminal",
			extensions: [extensionPaths.launcher, extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
			env: {
				LATTICE_OWNER: "yan", LATTICE_ADVERTISE: "127.0.0.1",
				LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
				LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
				LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
				LATTICE_FAUX_SCRIPT: directorScript,
			},
		});
		const terminal = pi;
		const answered = new Set<string>();
		/** Wait for the next prompt of a kind whose title says something, and answer it. */
		const answer = async (method: string, saying: string, payload: Record<string, unknown>): Promise<RpcEvent> => {
			const dialog = await terminal.waitFor(
				() => terminal.events.find((event) => event.type === "extension_ui_request" && event.method === method && !answered.has(event.id) && String(event.title).includes(saying)),
				`a ${method} prompt saying "${saying}"`, 30_000,
			);
			answered.add(dialog.id);
			terminal.answer(dialog.id, payload);
			return dialog;
		};
		/** Start a command that will ask something. It finishes once its prompts are answered, which the test does next. */
		const start = (text: string): void => void terminal.command(text).catch(() => {});
		const told = (saying: string) => terminal.waitFor(() => terminal.notifications().find((text) => text.includes(saying)), `to be told "${saying}"`, 40_000);
		const stateOf = async (dir: string): Promise<UiState> => {
			const client = await eventually(() => connectHost(dir), `the host of ${dir}`, 20_000);
			clients.push(client);
			return client.ui("state", {});
		};

		await terminal.prompt("hello");
		await terminal.command("/lattice");
		await eventually(async () => existsSync(join(shopState, "host.json")) && (await stateOf(shopState)).nodes.length === 1, "yan's tree to start", 30_000);

		// One command joins the server. Yan already goes by a name, so nothing is asked.
		start(`/lattice server ${address}`);
		await told("Joined http://127.0.0.1");

		// Sam is on it too, working in api.
		await joinAndSave(samBox.home, address, "sam");
		const samState = join(samBox.work, ".lattice");
		teammate = await runDaemon({
			stateDir: samState, cwd: samBox.work, owner: "sam", idleExitMs: 0, tickMs: 100, home: samBox.home, advertise: "127.0.0.1",
			hostOptions: hostOptionsFor(samBox, { stateDir: samState, owner: "sam" }),
		});
		const sam = teammate.host;
		const auth = await sam.createRoot({ name: "auth-rework", cwd: samBox.work, fragments: [] });
		await sam.prompt(auth.id, "rotate the signing keys");
		await eventually(() => sam.node(auth.id)?.status === "idle", "sam's session to settle");

		// Yan's pane hears of it: a repository that is not on this machine, with sam's session in it.
		await eventually(async () => (await stateOf(shopState)).sharing?.elsewhere.some((tree) => tree.owner === "sam" && tree.nodes.some((node) => node.id === auth.id)), "sam's session to be known to yan's host", 30_000);
		expect((await stateOf(shopState)).sharing?.elsewhere[0]).toMatchObject({ owner: "sam", url: apiOrigin, online: true });
		await told("sam joined team");

		// Reading it fetches the conversation from sam's host for that repository.
		start(`/lattice open ${auth.id}`);
		const reading = await answer("editor", "auth-rework (owned by sam, read-only", { cancelled: true });
		expect(String(reading.prefill)).toContain("rotate the signing keys");

		// Taking it: asked once where clones go, shown the address, then it is cloned, its host started, and sam asked.
		const clones = join(yanBox.root, "clones");
		start(`/lattice take ${auth.id}`);
		await answer("input", "Which folder should teammates' repositories be cloned into", { value: clones });
		const confirm = await answer("confirm", 'to take "auth-rework"', { confirmed: true });
		expect(String(confirm.message)).toContain(apiOrigin);
		const cloned = join(clones, "work"); // what sam calls the repository
		hostDirs.push(join(cloned, ".lattice"));
		await told("Asked sam");
		expect(readFileSync(join(cloned, "README.md"), "utf8")).toBe("api\n");
		expect(JSON.parse(readFileSync(join(yanBox.home, "config.json"), "utf8"))).toMatchObject({ network: { cloneDir: clones } });

		// Sam says yes, and the session is yan's, in the clone.
		await eventually(() => sam.uiState().sharing?.requests.some((request) => request.from === "yan" && request.nodeId === auth.id), "yan's request to reach sam");
		await sam.runSharing("approve", [auth.id, "yan"]);
		await eventually(() => sam.node(auth.id)?.owner === "yan", "sam to let it go", 30_000);
		const mine = await eventually(async () => (await stateOf(join(cloned, ".lattice"))).nodes.find((node) => node.id === auth.id && node.owner === "yan"), "the session to be yan's, in the clone", 30_000);
		expect(mine.cwd.startsWith(cloned)).toBe(true);
		// It is no longer somewhere else: it is in a repository that is here.
		await eventually(async () => (await stateOf(shopState)).sharing?.elsewhere.every((tree) => !tree.nodes.some((node) => node.id === auth.id)), "it to stop being listed as elsewhere", 30_000);
	}, 180_000);

	it("joins with one pasted line before any session exists, asking only what to be called", async () => {
		const address = await serve();
		const scratch = createSandbox();
		const samBox = createSandbox();
		const robinBox = createSandbox();
		sandboxes = [scratch, samBox, robinBox];
		const origin = join(scratch.root, "shop.git");
		git(scratch.root, "init", "-q", "--bare", "-b", "main", origin);
		git(samBox.work, "init", "-q", "-b", "main");
		git(samBox.work, "config", "user.email", "sam@example.com");
		git(samBox.work, "config", "user.name", "sam");
		writeFileSync(join(samBox.work, "README.md"), "shop\n");
		git(samBox.work, "add", ".");
		git(samBox.work, "commit", "-q", "-m", "init");
		git(samBox.work, "remote", "add", "origin", origin);
		git(samBox.work, "push", "-q", "origin", "main");
		git(robinBox.work, "clone", "-q", origin, ".");

		// Sam is on the server and has a session, and sends the line that joins it.
		await joinAndSave(samBox.home, address, "sam");
		const samState = join(samBox.work, ".lattice");
		teammate = await runDaemon({
			stateDir: samState, cwd: samBox.work, owner: "sam", idleExitMs: 0, tickMs: 100, home: samBox.home, advertise: "127.0.0.1",
			hostOptions: hostOptionsFor(samBox, { stateDir: samState, owner: "sam" }),
		});
		const line = `/lattice server ${address}`;
		const checkout = await teammate.host.createRoot({ name: "checkout", cwd: samBox.work, fragments: [] });

		// A new teammate's Pi, in their clone: no name chosen, no message sent, no tree.
		const state = join(robinBox.work, ".lattice");
		hostDirs.push(state);
		pi = await startPi(robinBox, {
			name: "terminal",
			extensions: [extensionPaths.launcher, extensionPaths.pane, extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph],
			env: {
				LATTICE_OWNER: "", LATTICE_ADVERTISE: "127.0.0.1",
				LATTICE_PI_COMMAND: JSON.stringify([process.execPath, piCli]),
				LATTICE_PI_ARGS: JSON.stringify(fauxArgs),
				LATTICE_EXTENSION_PATHS: JSON.stringify([extensionPaths.a2a, extensionPaths.roles, extensionPaths.graph]),
				LATTICE_FAUX_SCRIPT: directorScript,
			},
		});
		const terminal = pi;
		const told = (saying: string) => terminal.waitFor(() => terminal.notifications().find((text) => text.includes(saying)), `to be told "${saying}"`, 40_000);

		void terminal.command(line).catch(() => {});
		const asked = await terminal.waitFor(
			() => terminal.events.find((event) => event.type === "extension_ui_request" && event.method === "input" && String(event.title).includes("The name your teammates will see you as")),
			"to be asked for a name", 30_000,
		);
		terminal.answer(asked.id, { value: "robin" });
		await told("Joined http://127.0.0.1");
		await told("Found sam");

		const client = await eventually(() => connectHost(state), "robin's host", 20_000);
		clients.push(client);
		const seen = await eventually(async () => {
			const now = await client.ui("state", {});
			return now.nodes.some((node) => node.id === checkout.id) ? now : undefined;
		}, "sam's session to be in robin's tree", 30_000);
		expect(seen).toMatchObject({ owner: "robin", named: true });
		expect(seen.nodes.find((node) => node.id === checkout.id)).toMatchObject({ owner: "sam", name: "checkout" });
		expect(readFileSync(join(robinBox.home, "name"), "utf8").trim()).toBe("robin");
	});
});
