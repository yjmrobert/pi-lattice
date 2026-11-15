import { describe, expect, it } from "vitest";
import { firstKey, renderFirst, wrapMessage } from "../src/index.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping colour
const plain = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

describe("the first message, before there is a tree", () => {
	it("is typed and pasted, keeps its lines, and is sent with enter", () => {
		let draft = "";
		for (const key of [{ text: "Build tally" }, "newline", { text: "- a parser\n- a cli" }] as const) draft = firstKey(draft, key).draft;
		expect(draft).toBe("Build tally\n- a parser\n- a cli");
		expect(firstKey(draft, "backspace").draft).toBe("Build tally\n- a parser\n- a cl");
		expect(firstKey(`\n${draft}\n\n`, "enter")).toEqual({ draft: "", send: draft });
	});

	it("is not sent while empty, and escape clears it", () => {
		expect(firstKey("  \n ", "enter")).toEqual({ draft: "  \n " });
		expect(firstKey("half a thought", "escape")).toEqual({ draft: "" });
	});

	it("wraps at spaces, and keeps blank lines", () => {
		expect(wrapMessage("one two three four", 9)).toEqual(["one two", "three", "four"]);
		expect(wrapMessage("a\n\nb", 9)).toEqual(["a", "", "b"]);
		expect(wrapMessage("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
	});

	it("says that the first message starts the tree, in a box to write it in", () => {
		const screen = plain(renderFirst({ repo: "tally", draft: "", leave: [["alt+l", "chat"]] }, 100, 30));
		expect(screen).toHaveLength(30);
		expect(screen[0]).toMatch(/^ ◆ tally/);
		expect(screen.join("\n")).toContain("Your first message starts the tree.");
		expect(screen.some((row) => /╭─ to a new session in tally ─+╮/.test(row))).toBe(true);
		expect(screen.some((row) => row.includes("▏type or paste it here"))).toBe(true);
		expect(screen.at(-1)).toMatch(/⏎\s+start the tree.*shift\+⏎\s+new line.*esc\s+clear.*alt\+l\s+chat/);
	});

	it("shows the end of a long message, and how much there is", () => {
		const draft = Array.from({ length: 30 }, (_unused, index) => `line ${index + 1}`).join("\n");
		const screen = plain(renderFirst({ repo: "tally", draft }, 100, 30)).join("\n");
		expect(screen).toContain("line 30▏");
		expect(screen).not.toContain("line 1\n");
		expect(screen).toMatch(/30 lines, the last \d+ shown/);
	});

	it("says the tree is starting once it is sent, and offers no keys to write with", () => {
		const screen = plain(renderFirst({ repo: "tally", draft: "", sent: "Build tally", leave: [["alt+l", "chat"]] }, 100, 30));
		expect(screen.join("\n")).toContain("Starting the tree with your message…");
		expect(screen.join("\n")).toContain("Build tally");
		expect(screen.at(-1)).not.toContain("start the tree");
		expect(screen.at(-1)).toMatch(/alt\+l\s+chat/);
	});
});
