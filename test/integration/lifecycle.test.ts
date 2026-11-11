import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childrenOf, formatTree } from "@pi-lattice/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LatticeHost } from "../../packages/host/src/index.ts";
import { createSandbox, eventually, hostOptionsFor, type Sandbox } from "../support/harness.ts";

const lifecycleScript = join(dirname(fileURLToPath(import.meta.url)), "../support/lifecycle.mjs");

let sandbox: Sandbox;
let host: LatticeHost | undefined;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(async () => {
	await host?.stop();
	sandbox.cleanup();
});

describe("feature lifecycle", () => {
	it("runs a feature through grilling, planning, implementation and verification", async () => {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: sandbox.work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(sandbox.work, "README.md"), "project\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");

		const base = hostOptionsFor(sandbox);
		host = await LatticeHost.start({ ...base, env: { ...base.env, LATTICE_FAUX_SCRIPT: lifecycleScript } });
		const h = host;
		const root = await h.createRoot({ name: "checkout", kind: "feature", cwd: sandbox.work, fragments: ["coordinator", "lifecycle", "feature"] });

		await h.prompt(root.id, "Build one-click checkout.");

		// The coordinator's model ends by announcing completion, having seen every phase report.
		const final = await eventually(async () => {
			const { messages } = await h.rpc<{ messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }>(root.id, { type: "get_messages" });
			return messages.filter((m) => m.role === "assistant").flatMap((m) => m.content).map((p) => p.text ?? "").find((text) => text.startsWith("FEATURE COMPLETE"));
		}, "the coordinator to finish the lifecycle", 60_000);
		expect(final).toContain("verification done roles=protocol+reporting+worker+verification");

		// One child per phase, in order, each with the roles and scope the coordinator chose.
		const children = childrenOf(h.nodes(), root.id);
		expect(children.map((node) => [node.kind, node.fragments.join("+"), node.workspace])).toEqual([
			["grilling", "protocol+reporting+worker+grilling+story", "shared"],
			["planning", "protocol+reporting+worker+planning", "shared"],
			["implementation", "protocol+reporting+worker+implementation+task", "worktree"],
			["verification", "protocol+reporting+worker+verification", "shared"],
		]);

		// Every phase reported to the coordinator through the broker, as a result, with its roles applied.
		const reports = h
			.traffic({ node: root.id })
			.filter((record) => record.recipient === root.id)
			.map((record) => [record.envelope.intent, record.envelope.payload.text, record.mailState])
			.reverse();
		expect(reports).toEqual([
			["result", "grilling done roles=protocol+reporting+worker+grilling+story", "delivered"],
			["result", "planning done roles=protocol+reporting+worker+planning", "delivered"],
			["result", "implementation done roles=protocol+reporting+worker+implementation+task wrote feature.txt", "delivered"],
			["result", "verification done roles=protocol+reporting+worker+verification", "delivered"],
		]);

		// Each phase's output was carried into the next brief.
		expect(children[1]?.brief).toContain("grilling done");
		expect(children[3]?.brief).toContain("implementation done");

		// Implementation happened in its own worktree, not in the shared checkout.
		const implementation = children[2];
		expect(implementation?.branch).toMatch(/^lattice\/implementation-/);
		expect(readFileSync(join(implementation?.cwd ?? "", "feature.txt"), "utf8")).toBe("built by the implementation session\n");
		expect(existsSync(join(sandbox.work, "feature.txt"))).toBe(false);

		await eventually(() => h.nodes().every((node) => node.status === "idle"), "every session to settle");
		expect(formatTree(h.nodes()).split("\n")).toHaveLength(5);
	});
});
