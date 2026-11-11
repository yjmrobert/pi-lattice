import { describe, expect, it } from "vitest";
import { configProblem, parseConfig, withSetting } from "../src/index.ts";

describe("tree settings", () => {
	it("reads what it knows and names what is wrong", () => {
		const { config, problems } = parseConfig(JSON.stringify({ model: "anthropic/claude-haiku-4-5", thinking: "loud", approval: "always", env: { A: "1", B: 2 }, other: true }));
		expect(config).toEqual({ model: "anthropic/claude-haiku-4-5", approval: "always", env: { A: "1" } });
		expect(problems).toEqual(["thinking is one of: off, minimal, low, medium, high, xhigh, max."]);
	});

	it("refuses text that is not an object", () => {
		expect(() => parseConfig("[]")).toThrow("JSON object");
		expect(() => parseConfig("{")).toThrow();
	});

	it("changes one setting and keeps the rest", () => {
		const text = withSetting('{"env":{"A":"1"},"model":"x"}', "thinking", "low");
		expect(JSON.parse(text)).toEqual({ env: { A: "1" }, model: "x", thinking: "low" });
		expect(JSON.parse(withSetting(text, "model", undefined))).toEqual({ env: { A: "1" }, thinking: "low" });
		expect(JSON.parse(withSetting(undefined, "approval", "never"))).toEqual({ approval: "never" });
	});

	it("checks a setting before it is written", () => {
		expect(configProblem("approval", "sometimes")).toContain("cross-owner, always, never");
		expect(configProblem("colour", "red")).toContain("Unknown setting");
		expect(configProblem("model", "sonnet")).toBeUndefined();
	});
});
