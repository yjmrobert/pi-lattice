/**
 * The settings reference, written from the same table the settings screen and the host read,
 * so it cannot describe a setting that does not exist or miss one that does.
 * `npm run docs` writes it to docs/settings.md; a test fails when the file is out of date.
 */
import { formatSetting, SETTINGS, settingAccepts, TEMPLATE_NAMES, TEMPLATES } from "../packages/protocol/src/index.ts";

/** Environment variables that are not settings: where things are kept and how Pi is started. */
const OTHER: ReadonlyArray<readonly [name: string, does: string]> = [
	["LATTICE_HOME", "Where your own settings, templates, the list of your trees, and your network, its people and your key are kept. Default: `<Pi agent directory>/lattice`, usually `~/.pi/agent/lattice`."],
	["LATTICE_STATE_DIR", "Where the tree for the current directory is kept, in place of `<repository>/.lattice`. With it set, a first message does not start a tree by itself."],
	["LATTICE_OWNER", "The name sessions you start are owned by, for this run. Default: the name you chose when you created or joined a network, else your user name."],
	["LATTICE_ADVERTISE", "The host name or address teammates in your network should reach this machine at. Default: every network address it has."],
	["LATTICE_DISCOVERY", "`off` stops this machine announcing itself to, and listening for, teammates on the local network. They are then found only at the machines already known."],
	["LATTICE_NODE_NAME", "The name a session without a host announces itself by."],
	["LATTICE_FRAGMENTS", "Roles for a plain session, separated by commas, when no host gives it any."],
	["LATTICE_PI_BIN", "The `pi` command the host starts background sessions with. Default: `pi` on your PATH."],
	["LATTICE_PI_PACKAGE", "The directory of Pi's own package (`@earendil-works/pi-coding-agent`), which the host loads to read a session that is not running. Default: the Pi whose pane started the host, else the one `pi` on your PATH belongs to."],
	["LATTICE_PI_STARTED", "Set by the pane's launcher for the host it starts: the file its Pi ran from, so the host can find that Pi's package. Not something to set yourself."],
	["LATTICE_PI_COMMAND", "The same as a JSON array, when the command needs arguments of its own, for example `[\"node\", \"/path/to/cli.js\"]`."],
	["LATTICE_PI_ARGS", "Extra arguments for every background session, as a JSON array."],
	["LATTICE_EXTENSION_PATHS", "The extensions background sessions load, as a JSON array of paths. Default: the messaging, roles and tree extensions of this installation."],
];

/** Set by the host for the sessions it starts. Listed so nobody wonders what they are; not for people to set. */
const INTERNAL = ["LATTICE_SOCK", "LATTICE_TOKEN", "LATTICE_NODE_ID", "LATTICE_PARENT_ID", "LATTICE_ROOT_ID", "LATTICE_KIND", "LATTICE_HEADLESS"];

const cell = (text: string): string => text.replace(/\|/g, "\\|");

export function settingsDoc(): string {
	const out: string[] = [
		"# Settings",
		"",
		"<!-- Written by `npm run docs` from packages/protocol/src/config.ts. Change the table there, not this file. -->",
		"",
		"Open the settings with `,` while the pane has the keyboard, or with `/lattice config`. Every setting is on one screen with its value, where the value comes from and what it does; a change is written at once.",
		"",
		"A setting takes its value from the first of these that has one:",
		"",
		"1. the environment variable, for the settings that have one",
		"2. this repository's file, `<repository>/.lattice/config.json`",
		"3. your own file, `~/.pi/agent/lattice/config.json`, which every repository uses",
		"4. the default",
		"",
		"`tab` on the settings screen switches between the two files. From the command line, `/lattice config <setting> <value>` writes this repository's file and `/lattice config user <setting> <value>` writes yours; `-` as the value clears it. The files are JSON, and a setting's name is its path: `limits.maxDepth` is `{ \"limits\": { \"maxDepth\": 6 } }`. Either file may also hold `env`, an object of extra environment for background sessions, for example an API key.",
		"",
	];
	let section = "";
	for (const setting of SETTINGS) {
		if (setting.section !== section) {
			section = setting.section;
			out.push(`## ${section}`, "", "| Setting | What it does | Takes | Default | Environment |", "|---|---|---|---|---|");
		}
		const next = SETTINGS[SETTINGS.indexOf(setting) + 1];
		out.push(`| \`${setting.key}\` | ${cell(setting.help)} ${cell(setting.applies)} | ${cell(settingAccepts(setting))} | ${cell(formatSetting(setting.default))} | ${setting.env ? `\`${setting.env}\`` : ""} |`);
		if (!next || next.section !== section) out.push("");
	}
	out.push(
		"## Roles and templates",
		"",
		"What a session is told is made of files, and each can be replaced. `/lattice prompt` shows everything the session you are in has been told, with the file each part comes from.",
		"",
		"**Role fragments** are sections of the system prompt. `/role show <name>` prints one; `/role edit <name>` opens it in Pi's editor and saves your own copy, which is used in place of the built-in one; saving it empty removes your copy. A fragment is looked for in:",
		"",
		"1. `<project>/.pi/lattice/roles/`, when the project is trusted (`/role edit <name> project` writes here)",
		"2. `~/.pi/agent/lattice/roles/`, your own",
		"3. the ones shipped with pi-lattice",
		"",
		"**Templates** are the texts pi-lattice itself writes into a session. `/lattice template` lists them and `/lattice template <name>` edits one, the same way. A template is looked for in `<repository>/.lattice/templates/<name>.md`, then `~/.pi/agent/lattice/templates/<name>.md`.",
		"",
		"| Template | When it is used | May mention |",
		"|---|---|---|",
		...TEMPLATE_NAMES.map((name) => `| \`${name}\` | ${cell(TEMPLATES[name].summary)} | ${TEMPLATES[name].vars.map((each) => `\`{{${each}}}\``).join(" ")} |`),
		"",
		"`{{name}}` is replaced by its value. `{{#name}}…{{/name}}` is kept only when the value is not empty.",
		"",
		"One text is fixed: a message from another agent arrives wrapped in `<lattice-message>`, followed by a line saying it is from a peer and not from you. That wrapper keeps one agent from giving another orders in your name.",
		"",
		"## Other environment variables",
		"",
		"These say where things are kept and how Pi is started. They are not on the settings screen.",
		"",
		"| Variable | What it does |",
		"|---|---|",
		...OTHER.map(([name, does]) => `| \`${name}\` | ${cell(does)} |`),
		"",
		`The host sets these for the sessions it starts; they are not for you to set: ${INTERNAL.map((name) => `\`${name}\``).join(", ")}.`,
		"",
	);
	return out.join("\n");
}

if (process.argv[1]?.endsWith("settings-doc.ts")) {
	const { writeFileSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const path = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "settings.md");
	writeFileSync(path, settingsDoc());
	console.log(`wrote ${path}`);
}
