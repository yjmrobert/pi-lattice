import { parseSettings, resolveSettings } from "@pi-lattice/protocol";
import { describe, expect, it } from "vitest";
import type { FormKey } from "../src/form.ts";
import { newSettingsScreen, renderSettings, type SettingsData, type SettingsResult, type SettingsScreen, settingsKey, settingsRows } from "../src/settings.ts";

const data = (user: object = {}, repo: object | null = {}, env: Record<string, string> = {}): SettingsData => {
	const files = { user: parseSettings(JSON.stringify(user)), repo: repo ? parseSettings(JSON.stringify(repo)) : undefined };
	return {
		settings: resolveSettings({ ...files, env }),
		files,
		paths: { user: "/home/me/.pi/agent/lattice/config.json", repo: repo ? "/work/shop/.lattice/config.json" : undefined },
		problems: [],
		models: ["anthropic/big", "anthropic/small"],
		links: [{ section: "Role fragments", label: "worker", value: "built in", help: "Do one bounded piece of work.", command: "/role edit worker" }],
	};
};
/** The row a setting is on. */
const rowOf = (d: SettingsData, key: string): number => settingsRows(d).findIndex((row) => "setting" in row && row.setting.key === key);
const on = (d: SettingsData, key: string, scope: SettingsScreen["scope"] = "repo"): SettingsScreen => ({ scope, at: rowOf(d, key) });
const press = (screen: SettingsScreen, d: SettingsData, ...keys: FormKey[]): SettingsResult => {
	let result: SettingsResult = { screen };
	for (const key of keys) {
		if (!("screen" in result)) throw new Error("the screen was left");
		result = settingsKey(result.screen, d, key);
	}
	return result;
};
const type = (text: string): FormKey[] => [...text].map((char) => (char === " " ? "space" : { text: char }));

describe("the settings screen", () => {
	it("shows every setting with its value and where it comes from, and explains the one under the cursor", () => {
		const d = data({ model: "anthropic/small", limits: { maxDepth: 6 } }, { approval: "always" }, { LATTICE_BELL: "0" });
		const lines = renderSettings(on(d, "approval"), d, 84);
		const text = lines.join("\n");
		expect(lines[0]).toContain("Settings");
		expect(lines[1]).toContain("/work/shop/.lattice/config.json");
		expect(lines.find((line) => line.includes("Model"))).toMatch(/Model\s+anthropic\/small\s+yours/);
		expect(lines.find((line) => line.includes("▸"))).toMatch(/▸ Approval\s+always\s+this repository/);
		expect(lines.find((line) => line.includes("Depth"))).toMatch(/Depth\s+6\s+yours/);
		expect(lines.find((line) => line.includes("Bell"))).toMatch(/Bell\s+○ off\s+environment/);
		expect(lines.find((line) => line.includes("Thinking"))).toMatch(/Thinking\s+not set\s+default/);
		for (const section of ["BACKGROUND SESSIONS", "ROLES", "MESSAGING", "TREE", "PANE", "ROLE FRAGMENTS"]) expect(text).toContain(section);
		expect(text).toContain("approval · Which messages between agents wait for you");
		expect(text).toContain("LATTICE_APPROVAL in the environment overrides it.");
		expect(lines[lines.length - 1]).toContain("←→ choose");
	});

	it("opens on this repository's file when there is one, and tab switches to the person's own", () => {
		expect(newSettingsScreen(data()).scope).toBe("repo");
		expect(newSettingsScreen(data({}, null)).scope).toBe("user");
		const d = data();
		const switched = press(newSettingsScreen(d), d, "tab");
		expect(switched).toMatchObject({ screen: { scope: "user" } });
		expect(renderSettings((switched as { screen: SettingsScreen }).screen, d, 84)[1]).toContain("/home/me/.pi/agent/lattice/config.json");
		// With no tree here there is only one file to write.
		expect(press(newSettingsScreen(data({}, null)), data({}, null), "tab")).toMatchObject({ screen: { scope: "user" } });
	});

	it("moves through the rows and stops at either end", () => {
		const d = data();
		const last = settingsRows(d).length - 1;
		expect(press(newSettingsScreen(d), d, "up")).toMatchObject({ screen: { at: 0 } });
		expect(press(newSettingsScreen(d), d, "down", { text: "j" }, { text: "k" })).toMatchObject({ screen: { at: 1 } });
		expect(press(newSettingsScreen(d), d, "end", "down")).toMatchObject({ screen: { at: last } });
	});

	it("switches a toggle and steps through choices with one key, writing to the file it is on", () => {
		const d = data();
		expect(press(on(d, "pane.bell"), d, "space")).toMatchObject({ write: { scope: "repo", key: "pane.bell", value: false } });
		expect(press(on(d, "approval", "user"), d, "right")).toMatchObject({ write: { scope: "user", key: "approval", value: "always" } });
		expect(press(on(d, "approval"), d, "left")).toMatchObject({ write: { key: "approval", value: "never" } });
		// A setting with no value starts at the first choice.
		expect(press(on(d, "thinking"), d, "right")).toMatchObject({ write: { key: "thinking", value: "off" } });
		expect(press(on(d, "limits.maxDepth"), d, "right")).toMatchObject({ write: { key: "limits.maxDepth", value: 5 } });
		const least = data({}, { limits: { maxDepth: 1 } });
		expect(press(on(least, "limits.maxDepth"), least, "left")).not.toHaveProperty("write");
	});

	it("steps through the models there are, and lets any other be typed", () => {
		const d = data();
		expect(press(on(d, "model"), d, "right")).toMatchObject({ write: { key: "model", value: "anthropic/big" } });
		expect(press(on(d, "model"), d, "enter", ...type("other/one"), "enter")).toMatchObject({ write: { key: "model", value: "other/one" } });
	});

	it("edits text, numbers and lists in place, starting from what the file holds", () => {
		const d = data({ roles: { root: ["coordinator"] } }, {});
		const editing = press(on(d, "roles.root", "user"), d, "enter");
		expect(editing).toMatchObject({ screen: { editing: { text: "coordinator", at: 11 } } });
		expect(renderSettings((editing as { screen: SettingsScreen }).screen, d, 84).find((line) => line.includes("First session"))).toContain("coordinator▏");
		expect(press(on(d, "roles.root", "user"), d, "enter", ...type(" lifecycle"), "enter")).toMatchObject({ write: { scope: "user", key: "roles.root", value: ["coordinator", "lifecycle"] } });
		expect(press(on(d, "limits.maxNodes"), d, "enter", "backspace", "backspace", ...type("80"), "enter")).toMatchObject({ write: { key: "limits.maxNodes", value: 80 } });
		// The caret moves, and text goes in where it is.
		expect(press(on(d, "limits.maxNodes"), d, "enter", "home", ...type("1"), "enter")).toMatchObject({ write: { value: 140 } });
	});

	it("says what is wrong with what was typed and keeps it there to fix", () => {
		const d = data();
		const result = press(on(d, "limits.maxNodes"), d, "enter", ...type("x"), "enter");
		expect(result).not.toHaveProperty("write");
		expect(result).toMatchObject({ screen: { editing: { text: "40x" }, error: "limits.maxNodes takes a whole number from 1." } });
		expect(renderSettings((result as { screen: SettingsScreen }).screen, d, 84).join("\n")).toContain("takes a whole number");
		// Escape drops the edit; the next escape closes the screen.
		expect(press((result as { screen: SettingsScreen }).screen, d, "escape")).toEqual({ screen: on(d, "limits.maxNodes") });
		expect(press(on(d, "limits.maxNodes"), d, "escape")).toEqual({ close: true });
	});

	it("clears a setting from the file it is on, by x or by saving nothing", () => {
		const d = data({ model: "mine" }, { model: "ours" });
		expect(press(on(d, "model"), d, { text: "x" })).toMatchObject({ write: { scope: "repo", key: "model", value: undefined } });
		expect(press(on(d, "model", "user"), d, "enter", "backspace", "backspace", "backspace", "backspace", "enter")).toMatchObject({ write: { scope: "user", key: "model", value: undefined } });
	});

	it("says when another layer wins, so a change that shows nothing is explained", () => {
		const d = data({ model: "mine" }, { model: "ours" }, { LATTICE_APPROVAL: "never" });
		expect(renderSettings(on(d, "model", "user"), d, 84).join("\n")).toContain("This repository sets its own, which wins here. Yours is mine.");
		expect(renderSettings(on(d, "model"), d, 84).join("\n")).toContain("Yours is mine; this repository's wins here.");
		expect(renderSettings(on(d, "approval"), d, 84).join("\n")).toContain("LATTICE_APPROVAL is set in the environment and wins over both files.");
		const refused = press(on(d, "approval"), d, "right");
		expect(refused).not.toHaveProperty("write");
		expect(refused).toMatchObject({ screen: { error: expect.stringContaining("Unset it to change this here") } });
	});

	it("opens a file row with the command that edits it", () => {
		const d = data();
		const at = settingsRows(d).findIndex((row) => "link" in row);
		expect(press({ scope: "repo", at }, d, "enter")).toEqual({ command: "/role edit worker" });
		const lines = renderSettings({ scope: "repo", at }, d, 84);
		expect(lines.find((line) => line.includes("▸"))).toMatch(/▸ worker\s+built in/);
		expect(lines.join("\n")).toContain("Do one bounded piece of work.");
		expect(lines[lines.length - 1]).toContain("⏎ edit the file");
	});

	it("keeps the cursor in view on a short terminal, with the explanation and keys pinned below", () => {
		const d = data();
		const lines = renderSettings(on(d, "pane.width"), d, 84, undefined, 22);
		expect(lines).toHaveLength(22);
		expect(lines.join("\n")).toContain("▸ Width");
		expect(lines.join("\n")).toMatch(/↑ \d+ more/);
		expect(lines[lines.length - 1]).toContain("esc close");
		expect(lines.join("\n")).toContain("pane.width · How many columns the pane takes.");
	});

	it("shows what is wrong with a file", () => {
		const d = { ...data(), problems: ["/work/shop/.lattice/config.json: thinking takes off | minimal."] };
		expect(renderSettings(newSettingsScreen(d), d, 84).join("\n")).toContain("! /work/shop/.lattice/config.json: thinking takes");
	});
});
