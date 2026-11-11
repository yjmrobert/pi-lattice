import { describe, expect, it } from "vitest";
import { parseSettings, resolveSettings } from "@pi-lattice/protocol";
import { sessionLaunch, tailOf, toolLine } from "../src/index.ts";

describe("starting a session", () => {
	it("uses the settings in effect, and the session's own model over them", () => {
		const settings = (file: object = {}, env: Record<string, string> = {}) => resolveSettings({ repo: parseSettings(JSON.stringify(file)), env });
		expect(sessionLaunch({}, settings())).toEqual({ args: [], env: {} });
		expect(sessionLaunch({}, settings({ model: "haiku", thinking: "low", approval: "always", limits: { maxHops: 3, maxDepth: 2 }, env: { KEY: "k" } }))).toEqual({
			args: ["--model", "haiku", "--thinking", "low"],
			// Only what the session enforces itself is passed on; the tree limits stay with the host.
			env: { KEY: "k", LATTICE_APPROVAL: "always", LATTICE_MAX_HOPS: "3" },
		});
		expect(sessionLaunch({ model: "opus" }, settings({ model: "haiku" })).args).toEqual(["--model", "opus"]);
	});
});

describe("what a session has been doing", () => {
	it("puts a tool call on one line with the argument that says most", () => {
		expect(toolLine("bash", { command: "npm test\n--watch", timeout: 5 })).toBe("→ bash: npm test --watch");
		expect(toolLine("read", { path: "src/a.ts" })).toBe("→ read: src/a.ts");
		expect(toolLine("list_sessions", {})).toBe("→ list_sessions");
	});

	it("keeps the end of a conversation, one line per thing said or done", () => {
		const lines = tailOf(
			[
				{ role: "user", content: "fix the\nbug" },
				{ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
				{ role: "toolResult", content: [{ type: "text", text: "..." }] },
				{ role: "assistant", content: [{ type: "text", text: "Done." }] },
			],
			3,
		);
		expect(lines).toEqual(["Looking.", "→ read: a.ts", "Done."]);
	});
});
