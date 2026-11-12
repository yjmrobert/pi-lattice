import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
	it("defaults to the current directory with no roles", () => {
		expect(parseArgs([], "/proj")).toMatchObject({ command: "plain", cwd: "/proj", fragments: [], help: false, piArgs: [] });
	});

	it("reads options and passes everything after -- to Pi", () => {
		expect(parseArgs(["--cwd", "/x", "--name", "checkout", "--role", "coordinator,planning", "--role", "feature", "--plain", "--", "--model", "sonnet"], "/proj")).toMatchObject({
			cwd: "/x", name: "checkout", fragments: ["coordinator", "planning", "feature"], command: "plain", piArgs: ["--model", "sonnet"],
		});
	});

	it("reads sharing options", () => {
		expect(parseArgs(["--join", "team.secret@10.0.0.9", "--advertise", "10.0.0.5", "--as", "yan"], "/proj")).toMatchObject({
			join: "team.secret@10.0.0.9", advertise: "10.0.0.5", as: "yan",
		});
	});

	it("reads joining and creating a network as commands of their own", () => {
		expect(parseArgs(["join", "team.secret@10.0.0.9", "--as", "robin"], "/proj")).toMatchObject({ command: "join", subject: "team.secret@10.0.0.9", as: "robin" });
		expect(parseArgs(["create"], "/proj")).toMatchObject({ command: "create", subject: undefined });
		expect(parseArgs(["create", "crew"], "/proj")).toMatchObject({ command: "create", subject: "crew" });
		expect(() => parseArgs(["join"], "/proj")).toThrow(/needs the code/);
	});

	it("recognises the daemon command and its idle timeout", () => {
		expect(parseArgs(["daemon", "--state", "/s", "--idle-exit", "30"], "/proj")).toMatchObject({ command: "daemon", stateDir: "/s", idleExit: 30 });
		expect(() => parseArgs(["daemon", "--idle-exit", "soon"], "/proj")).toThrow(/number of seconds/);
	});

	it("rejects unknown options and missing values", () => {
		expect(() => parseArgs(["--nope"], "/proj")).toThrow(/Unknown option/);
		expect(() => parseArgs(["--name"], "/proj")).toThrow(/needs a value/);
		expect(() => parseArgs(["--name", "--plain"], "/proj")).toThrow(/needs a value/);
	});
});
