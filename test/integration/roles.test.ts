import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
		const dir = join(sandbox.agentDir, "lattice", "roles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "fast.md"), "---\nname: fast\nsummary: Go quickly\nconflicts: [careful]\n---\nGo quickly.");
		writeFileSync(join(dir, "careful.md"), "---\nname: careful\nsummary: Go carefully\n---\nGo carefully.");
		const child = await start();
		await child.command("/role set fast careful");
		await child.waitFor(() => child.notifications().find((text) => text.includes("competing guidance")), "advisory note");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-fast,lattice-role-careful");
	});

	it("applies one fragment of a slot at a time: the next phase takes the place of the one before", async () => {
		const child = await start();
		await child.command("/role add coordinator grilling feature");
		await child.command("/role add planning");
		await child.waitFor(() => child.notifications().find((text) => text.includes('"planning" takes the place of "grilling": one phase at a time.')), "the note that one took the other's place");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-coordinator,lattice-role-feature,lattice-role-planning");
		// The same for what a session is: one stance at a time.
		await child.command("/role add worker");
		expect(await rolesSeen(child, "q2")).toBe("lattice-role-feature,lattice-role-planning,lattice-role-worker");
	});

	it("applies a role's parts with it, and only the parts whose conditions hold", async () => {
		const dir = join(sandbox.agentDir, "lattice", "roles");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "lead.md"), "---\nname: lead\nsummary: Lead the work\nincludes: [with-tool, without-tool, on-a-board]\n---\nLead.");
		// A tool this session has is a fact: the roles extension registers apply_role itself.
		writeFileSync(join(dir, "with-tool.md"), "---\nname: with-tool\nsummary: Needs a tool that is here\nwhen: [tool.apply_role]\n---\nUse it.");
		writeFileSync(join(dir, "without-tool.md"), "---\nname: without-tool\nsummary: Needs a tool that is not here\nwhen: [tool.no_such_tool]\n---\nNever seen.");
		// Only a host says there is a board, and this session has none.
		writeFileSync(join(dir, "on-a-board.md"), "---\nname: on-a-board\nsummary: Needs a server\nwhen: [board]\n---\nNever seen here.");
		const child = await start();
		await child.command("/role add lead");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-lead,lattice-role-with-tool");
		await child.command("/role show lead");
		await child.waitFor(() => child.notifications().find((text) => text.includes("made of: with-tool, without-tool, on-a-board, each applied with it")), "the parts to be shown");
		await child.command("/role show on-a-board");
		await child.waitFor(() => child.notifications().find((text) => text.includes("applies when board")), "the condition to be shown");
	});

	it("a model that changes phase with apply_role keeps the roles it was given", async () => {
		const child = await start({ env: { LATTICE_FRAGMENTS: "protocol,coordinator,lifecycle,grilling" } });
		// The way the lifecycle role says to move on: name the next phase and nothing else.
		await child.prompt('!tool apply_role {"fragments":["planning"]}');
		expect(await child.waitForAssistant("tool-result")).toContain("Roles: protocol + coordinator + lifecycle + planning.");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-protocol,lattice-role-coordinator,lattice-role-lifecycle,lattice-role-planning");
		// Even a model that asks to replace the list cannot take off what every session in a tree is told.
		await child.prompt('!tool apply_role {"fragments":["worker","implementation"],"mode":"set"}');
		expect(await rolesSeen(child, "q2")).toBe("lattice-role-protocol,lattice-role-worker,lattice-role-implementation");
	});

	it("a person's /role set keeps what is marked kept; /role remove and /role clear take it off", async () => {
		const child = await start({ env: { LATTICE_FRAGMENTS: "protocol,reporting,worker" } });
		await child.command("/role set coordinator");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-protocol,lattice-role-reporting,lattice-role-coordinator");
		await child.command("/role remove reporting");
		expect(await rolesSeen(child, "q2")).toBe("lattice-role-protocol,lattice-role-coordinator");
		await child.command("/role clear");
		expect(await rolesSeen(child, "q3")).toBe("");
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
	it("shows a role in full with where it comes from, and adds to it without copying it", async () => {
		const child = await start();
		const own = join(sandbox.agentDir, "lattice", "roles", "worker.md");
		const editor = async (after: number, command: string, answer: (prefill: string) => Record<string, unknown>) => {
			const flow = child.command(command);
			const dialog = await child.waitFor(() => child.events.filter((e) => e.type === "extension_ui_request" && e.method === "editor")[after], "the editor");
			child.answer(dialog.id, answer(String(dialog.prefill ?? "")));
			await flow;
			return dialog;
		};

		await child.command("/role show worker");
		const shown = await child.waitFor(() => child.notifications().find((text) => text.startsWith("worker · built in")), "the role shown");
		expect(shown).toContain("You have been given one bounded piece of work.");
		expect(shown).toContain("a stance: applying it takes the place of any other stance");

		// The editor opens on an empty addition, not on a copy of the built-in text.
		const first = await editor(0, "/role edit worker", (prefill) => ({ value: `${prefill}Run npm run check before you report.\n` }));
		expect(String(first.title)).toContain('Adding to role "worker"');
		expect(String(first.title)).toContain(own);
		expect(String(first.prefill)).toBe("---\nname: worker\nmode: append\n---\n");
		await child.waitFor(() => child.notifications().find((text) => text.startsWith(`Saved ${own}. It adds to the built in "worker", which stays as it is.`)), "the save");
		expect(readFileSync(own, "utf8")).toBe("---\nname: worker\nmode: append\n---\nRun npm run check before you report.\n");
		// The role is the built-in text with the addition after it, and still everything else the built-in says it is.
		await child.command("/role show worker");
		const added = await child.waitFor(() => child.notifications().find((text) => text.startsWith("worker · built in, with yours added")), "the addition to be in use");
		expect(added).toContain("You have been given one bounded piece of work.");
		expect(added).toContain("Run npm run check before you report.");
		expect(added).toContain("a stance: applying it takes the place of any other stance");
		await child.command("/role add worker");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-worker");

		// Opened again, it is the addition that is edited. Saved with nothing under the header, nothing is saved.
		const again = await editor(1, "/role edit worker", () => ({ value: "---\nname: worker\nmode: append\n---\n" }));
		expect(String(again.prefill)).toContain("Run npm run check before you report.");
		await child.waitFor(() => child.notifications().find((text) => text.includes('nothing to add to "worker"')), "the refusal of an empty addition");
		expect(readFileSync(own, "utf8")).toContain("Run npm run check before you report.");

		// Saving it empty removes it, and the built-in one is back by itself.
		await editor(2, "/role edit worker", () => ({ value: "" }));
		await child.waitFor(() => child.notifications().find((text) => text.includes('"worker" is the built in one again')), "the removal");
		expect(existsSync(own)).toBe(false);
	});

	it("makes a full copy of a role when asked, and says when the role it was copied from has changed", async () => {
		const child = await start();
		const own = join(sandbox.agentDir, "lattice", "roles", "worker.md");
		const editor = async (after: number, command: string, answer: (prefill: string) => Record<string, unknown>) => {
			const flow = child.command(command);
			const dialog = await child.waitFor(() => child.events.filter((e) => e.type === "extension_ui_request" && e.method === "editor")[after], "the editor");
			child.answer(dialog.id, answer(String(dialog.prefill ?? "")));
			await flow;
			return dialog;
		};

		// The editor opens on the built-in text, marked with what it was copied from; saving writes a copy, which then wins.
		const first = await editor(0, "/role edit worker replace", (prefill) => ({ value: prefill.replace("You have been given one bounded piece of work.", "You have been given exactly one job.") }));
		expect(String(first.title)).toContain("a full copy, used in place of the built in one");
		expect(String(first.title)).toContain(own);
		expect(String(first.prefill)).toMatch(/^---\nname: worker\nsummary: .+\nbase: "[0-9a-f]{12}"\nslot: stance\n---\n/);
		await child.waitFor(() => child.notifications().find((text) => text.startsWith(`Saved ${own}. It is used in place of the built in "worker".`)), "the save");
		expect(readFileSync(own, "utf8")).toContain("You have been given exactly one job.");
		await child.command("/role show worker");
		const mine = await child.waitFor(() => child.notifications().find((text) => text.startsWith("worker · yours ·") && text.includes("exactly one job")), "the person's copy to be the one in use");
		expect(mine).not.toContain("has changed since");

		// A copy that names another role is refused, so one file cannot quietly replace another role.
		await editor(1, "/role edit worker", (prefill) => ({ value: prefill.replace("name: worker", "name: boss") }));
		await child.waitFor(() => child.notifications().find((text) => text.includes('names the role "boss"')), "the refusal");
		expect(readFileSync(own, "utf8")).toContain("name: worker");

		// The built-in moves on, which here is the copy remembering an older one: the copy is said to be stale wherever it is shown.
		writeFileSync(own, readFileSync(own, "utf8").replace(/base: "[0-9a-f]{12}"/, 'base: "000000000000"'));
		await child.command("/role show worker");
		const stale = await child.waitFor(() => child.notifications().find((text) => text.startsWith("worker · yours, a copy of one that has changed since")), "the copy to be said to be stale");
		expect(stale).toContain("saving it empty goes back to the one beneath");
		await child.command("/role list");
		await child.waitFor(() => child.notifications().find((text) => text.includes("worker (yours, a copy of one that has changed since; stance)")), "the list to say so");

		// Saving it empty removes the copy, and the built-in one is back.
		await editor(2, "/role edit worker", () => ({ value: "" }));
		await child.waitFor(() => child.notifications().find((text) => text.includes('"worker" is the built in one again')), "the removal");
		expect(existsSync(own)).toBe(false);

		// A name nobody has yet starts a new role.
		await editor(3, "/role edit auditor", (prefill) => ({ value: prefill.replace("What a session with this role should do.", "Read the diff before the description.") }));
		await child.command("/role add auditor");
		expect(await rolesSeen(child, "q1")).toBe("lattice-role-auditor");
	});
});
