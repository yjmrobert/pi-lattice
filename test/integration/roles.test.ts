import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, extensionPaths, type PiChild, type Sandbox, startPi } from "../support/harness.ts";

let sandbox: Sandbox;
let children: PiChild[];

beforeEach(() => {
	sandbox = createSandbox();
	children = [];
});
afterEach(async () => {
	await Promise.all(children.map((child) => child.stop().catch(() => {})));
	sandbox.cleanup();
});

const start = async (options: { env?: Record<string, string>; args?: string[] } = {}) => {
	const child = await startPi(sandbox, { name: "roles", extensions: [extensionPaths.roles], ...options });
	children.push(child);
	return child;
};
/** Ask the scripted model which role sections it can see. */
const rolesSeen = async (child: PiChild, marker: string) => {
	await child.prompt(marker);
	const text = await child.waitForAssistant(marker);
	return /roles=\[([^\]]*)\]/.exec(text)?.[1] ?? "";
};

describe("roles", () => {
	it("starts with no roles and no role sections", async () => {
		const child = await start();
		expect(await rolesSeen(child, "q1")).toBe("");
	});

	it("composes coordinator + planning and changes them mid-session", async () => {
		const child = await start();
		await child.command("/role add coordinator planning");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-coordinator,lattice-role-planning");

		await child.command("/role remove planning");
		expect(await rolesSeen(child, "q2")).toBe("lattice-role-coordinator");

		await child.command("/role set worker");
		expect(await rolesSeen(child, "q3")).toBe("lattice-role-worker");

		await child.command("/role clear");
		expect(await rolesSeen(child, "q4")).toBe("");
	});

	it("shows advisory notes but applies the combination anyway", async () => {
		const child = await start();
		await child.command("/role set coordinator worker");
		await child.waitFor(() => child.notifications().find((text) => text.includes("competing guidance")), "advisory note");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-coordinator,lattice-role-worker");
	});

	it("refuses unknown fragments and lists what exists", async () => {
		const child = await start();
		await child.command("/role add wizard");
		const note = await child.waitFor(() => child.notifications().find((text) => text.includes("Unknown role fragment")), "unknown fragment warning");
		expect(note).toContain("coordinator");
		expect(await rolesSeen(child, "q1")).toBe("");
	});

	it("lets the model change roles with apply_role", async () => {
		const child = await start();
		await child.prompt('!tool apply_role {"fragments":["worker"]}');
		expect(await child.waitForAssistant("tool-result")).toContain("Roles: worker.");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-worker");
	});

	it("keeps roles across resume", async () => {
		const first = await start();
		await first.command("/role set coordinator planning");
		await first.prompt("persist");
		const state = await first.client.getState();
		await first.stop();

		const again = await start({ args: ["--session", state.sessionFile as string] });
		expect(await rolesSeen(again, "q1")).toBe("lattice-role-coordinator,lattice-role-planning");
	});

	it("keeps roles across /new", async () => {
		const child = await start();
		await child.command("/role set worker");
		await child.prompt("persist");
		await child.client.newSession();
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-worker");
	});

	it("seeds roles from LATTICE_FRAGMENTS when a session is spawned with them", async () => {
		const child = await start({ env: { LATTICE_FRAGMENTS: "worker,planning" } });
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-worker,lattice-role-planning");
	});

	it("picks up a fragment dropped into the user roles folder, with no code change", async () => {
		const dir = join(sandbox.agentDir, "lattice", "roles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "security-review.md"), "---\nname: security-review\nsummary: Look for vulnerabilities\n---\nReview for injection and authz flaws.");
		const child = await start();
		await child.command("/role add security-review");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-security-review");
	});

	it("reads project fragments only from a trusted project", async () => {
		const dir = join(sandbox.work, ".pi", "lattice", "roles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "house-style.md"), "Follow the house style.");

		const untrusted = await start({ args: ["--no-approve"] });
		await untrusted.command("/role add house-style");
		await untrusted.waitFor(() => untrusted.notifications().find((text) => text.includes("Unknown role fragment")), "unknown fragment warning");
		await untrusted.stop();

		const trusted = await start({ args: ["--approve"] });
		await trusted.command("/role add house-style");
		expect(await rolesSeen(trusted, "q1")).toBe("lattice-role-house-style");
	});
});
