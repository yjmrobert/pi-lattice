import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, formatSetting, limitsOf, parseSettingInput, parseSettings, resolveSettings, rolesFor, SETTINGS, withSetting } from "../src/index.ts";

describe("settings", () => {
	it("reads what it knows from a file and names what is wrong", () => {
		const file = parseSettings(JSON.stringify({ model: "anthropic/claude-haiku-4-5", thinking: "loud", approval: "always", limits: { maxDepth: 6, maxNodes: "many" }, pane: { bell: false }, env: { A: "1", B: 2 }, other: true }));
		expect(file.values).toEqual({ model: "anthropic/claude-haiku-4-5", approval: "always", "limits.maxDepth": 6, "pane.bell": false });
		expect(file.env).toEqual({ A: "1" });
		expect(file.problems).toEqual(["thinking takes off | minimal | low | medium | high | xhigh | max.", "limits.maxNodes takes a whole number from 1."]);
	});

	it("refuses text that is not an object", () => {
		expect(() => parseSettings("[]")).toThrow("JSON object");
		expect(() => parseSettings("{")).toThrow();
	});

	it("changes one setting and keeps the rest, nesting by the dots in its name", () => {
		const text = withSetting('{"env":{"A":"1"},"model":"x"}', "thinking", "low");
		expect(JSON.parse(text)).toEqual({ env: { A: "1" }, model: "x", thinking: "low" });
		expect(JSON.parse(withSetting(text, "model", undefined))).toEqual({ env: { A: "1" }, thinking: "low" });
		const nested = withSetting(withSetting(undefined, "limits.maxDepth", 6), "limits.maxNodes", 80);
		expect(JSON.parse(nested)).toEqual({ limits: { maxDepth: 6, maxNodes: 80 } });
		// Removing the last setting of a group removes the group.
		expect(JSON.parse(withSetting(withSetting(nested, "limits.maxDepth", undefined), "limits.maxNodes", undefined))).toEqual({});
		expect(JSON.parse(withSetting("{}", "pane.bell", undefined))).toEqual({});
	});

	it("reads what a person types, in the setting's own type", () => {
		expect(parseSettingInput("approval", "sometimes")).toEqual({ problem: "approval takes cross-owner | always | never." });
		expect(parseSettingInput("colour", "red")).toMatchObject({ problem: expect.stringContaining("Unknown setting") });
		expect(parseSettingInput("model", " sonnet ")).toEqual({ value: "sonnet" });
		expect(parseSettingInput("pane.bell", "off")).toEqual({ value: false });
		expect(parseSettingInput("limits.maxDepth", "6")).toEqual({ value: 6 });
		expect(parseSettingInput("limits.maxDepth", "0")).toMatchObject({ problem: expect.any(String) });
		expect(parseSettingInput("pane.width", "200")).toMatchObject({ problem: expect.stringContaining("to 60") });
		expect(parseSettingInput("roles.root", "coordinator, lifecycle")).toEqual({ value: ["coordinator", "lifecycle"] });
		expect(parseSettingInput("roles.root", "none")).toEqual({ value: [] });
	});

	it("takes each value from the environment, then the repository, then the person, then the default, and says which", () => {
		const user = parseSettings(JSON.stringify({ model: "mine", thinking: "low", limits: { maxDepth: 5 }, env: { A: "user", B: "user" } }));
		const repo = parseSettings(JSON.stringify({ model: "ours", env: { B: "repo" } }));
		const settings = resolveSettings({ user, repo, env: { LATTICE_MAX_DEPTH: "9", LATTICE_BELL: "0", LATTICE_APPROVAL: "nonsense" } });
		expect(settings.values.model).toBe("ours");
		expect(settings.sources.model).toBe("repo");
		expect(settings.values.thinking).toBe("low");
		expect(settings.sources.thinking).toBe("user");
		expect(settings.values["limits.maxDepth"]).toBe(9);
		expect(settings.sources["limits.maxDepth"]).toBe("env");
		expect(settings.values["pane.bell"]).toBe(false);
		// A value the environment gets wrong is passed over, not obeyed.
		expect(settings.values.approval).toBe("cross-owner");
		expect(settings.sources.approval).toBe("default");
		expect(settings.env).toEqual({ A: "user", B: "repo" });
		expect(limitsOf(settings)).toEqual({ ...DEFAULT_LIMITS, maxDepth: 9 });
	});

	it("has a default or nothing for every setting, and shows any value in words", () => {
		const settings = resolveSettings();
		for (const setting of SETTINGS) expect(settings.values[setting.key]).toEqual(setting.default);
		expect(limitsOf(settings)).toEqual(DEFAULT_LIMITS);
		expect([formatSetting(undefined), formatSetting(true), formatSetting([]), formatSetting(["a", "b"]), formatSetting(4)]).toEqual(["not set", "on", "none", "a b", "4"]);
	});

	it("gives a new session the roles for its place", () => {
		const settings = resolveSettings();
		expect(rolesFor(settings, "root")).toEqual(["protocol"]);
		expect(rolesFor(settings, "child")).toEqual(["protocol", "reporting", "worker"]);
		expect(rolesFor(settings, "child", ["implementation", "reporting"])).toEqual(["protocol", "reporting", "implementation"]);
		const bare = resolveSettings({ repo: parseSettings(JSON.stringify({ roles: { tree: [], children: [], child: [], root: ["coordinator"] } })) });
		expect(rolesFor(bare, "child")).toEqual([]);
		expect(rolesFor(bare, "root")).toEqual(["coordinator"]);
	});
});
