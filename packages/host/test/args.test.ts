import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
	it("defaults to the current directory with no roles", () => {
		expect(parseArgs([], "/proj")).toMatchObject({ cwd: "/proj", fragments: [], plain: false, help: false, piArgs: [] });
	});

	it("reads options and passes everything after -- to Pi", () => {
		expect(parseArgs(["--cwd", "/x", "--name", "checkout", "--role", "coordinator,planning", "--role", "feature", "--plain", "--", "--model", "sonnet"], "/proj")).toMatchObject({
			cwd: "/x", name: "checkout", fragments: ["coordinator", "planning", "feature"], plain: true, piArgs: ["--model", "sonnet"],
		});
	});

	it("rejects unknown options and missing values", () => {
		expect(() => parseArgs(["--nope"], "/proj")).toThrow(/Unknown option/);
		expect(() => parseArgs(["--name"], "/proj")).toThrow(/needs a value/);
		expect(() => parseArgs(["--name", "--plain"], "/proj")).toThrow(/needs a value/);
	});
});
