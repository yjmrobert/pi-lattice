#!/usr/bin/env node
/**
 * Check that a real model follows the orchestration instructions.
 *
 *   npm run eval                          the model Pi is set up with
 *   npm run eval -- --model <model>       another one, as `pi --model` takes it
 *   npm run eval -- --minutes <n>         how long to wait (default 6)
 *
 * The tests use a scripted model, which shows the mechanics work and nothing about whether a
 * model does what the role fragments say. This runs one small delegation with a real model and
 * checks what happened, not how it was worded: a child was created with a brief that stands on
 * its own, it did the work, it sent its parent one result, and nobody had to be reminded.
 * Run it after changing a role fragment or a template. It uses your login and spends tokens.
 *
 * The run happens in a new directory under the system's temporary directory, which is left
 * behind so the sessions can be read; its path is printed at the end.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LatticeHost } from "../packages/host/src/index.ts";
import { childrenOf } from "../packages/protocol/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const value = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log("npm run eval [-- --model <model>] [--minutes <n>]\n\nRuns one delegation with a real model and checks that the sessions talked to each other as the role fragments say. Uses your Pi login and spends tokens.");
	process.exit(0);
}
const model = value("--model");
const minutes = Number(value("--minutes") ?? 6);
const WORD = "heliotrope";

const scratch = mkdtempSync(join(tmpdir(), "pi-lattice-eval-"));
const work = join(scratch, "work");
execFileSync("git", ["init", "-q", work]);
execFileSync("git", ["-c", "user.email=eval@example.com", "-c", "user.name=eval", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: work });

const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const host = await LatticeHost.start({
	stateDir: join(scratch, "state"),
	// Settings and templates come from here, so the run checks the built-in texts unless you copy yours in.
	userDir: join(scratch, "lattice"),
	piCommand: [process.execPath, cli],
	piArgs: ["--no-extensions", ...(model ? ["--model", model] : [])],
	extensionPaths: ["packages/a2a", "packages/roles", "packages/graph"].map((path) => join(root, path)),
});
host.on("log", (level, message) => {
	if (level !== "info") console.error(`  host ${level}: ${message}`);
});

const checks: Array<[ok: boolean, what: string, detail: string]> = [];
const check = (ok: boolean, what: string, detail = ""): void => void checks.push([ok, what, detail]);
let failed = true;
try {
	console.log(`Running one delegation${model ? ` on ${model}` : ""} in ${scratch} (up to ${minutes} minutes)…`);
	const first = await host.createRoot({
		name: "eval",
		cwd: work,
		fragments: ["coordinator"],
		brief: [
			"This is a check of delegation. Do not do the work yourself.",
			`Create exactly one child session and have it create a file named FACT.txt in the working directory containing the single word ${WORD}.`,
			"When the child has reported back, check the file, then answer me with one line that starts with DONE.",
		].join(" "),
	});
	const texts = async (id: string): Promise<string[]> =>
		(await host.readMessages(id))
			.filter((message) => message.role === "assistant")
			.map((message) => (Array.isArray(message.content) ? message.content : []).filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "").join(""));
	const end = Date.now() + minutes * 60_000;
	let done = false;
	let blocked = "";
	while (Date.now() < end && !done && !blocked) {
		await new Promise((wait) => setTimeout(wait, 2000));
		for (const node of host.nodes()) {
			const dialog = host.dialogs(node.id)[0];
			if (dialog) blocked = `"${node.name}" is waiting on a question nobody is here to answer: ${dialog.title}`;
		}
		const settled = host.nodes().every((node) => node.status === "idle" || node.status === "dormant");
		done = settled && (await texts(first.id)).some((text) => /^\s*DONE/m.test(text));
	}

	const children = childrenOf(host.nodes(), first.id);
	const child = children[0];
	const toParent = host.traffic({ node: first.id, limit: 1000 }).filter((record) => record.recipient === first.id);
	const results = toParent.filter((record) => record.envelope.intent === "result");
	const stopped = toParent.filter((record) => record.envelope.intent === "stopped");
	const childHistory = child ? JSON.stringify(await host.readMessages(child.id)) : "";
	const file = join(child?.cwd ?? work, "FACT.txt");

	check(!blocked, "nobody waited on a question", blocked);
	check(done, "the coordinator finished and said DONE", done ? "" : `it had not after ${minutes} minutes`);
	check(children.length === 1, "it created exactly one child", `${children.length} created`);
	check(Boolean(child && child.brief.includes("FACT.txt") && child.brief.toLowerCase().includes(WORD)), "the brief stands on its own: it names the file and the word", child ? `brief: ${child.brief.slice(0, 200)}` : "");
	check(child?.fragments.includes("reporting") === true, "the child was told how to report", child ? `roles: ${child.fragments.join(" ")}` : "");
	check(existsSync(file) && readFileSync(file, "utf8").toLowerCase().includes(WORD), "the child did the work", file);
	check(results.length === 1, "the child sent its parent exactly one result", `${results.length} result${results.length === 1 ? "" : "s"}, ${toParent.length} message${toParent.length === 1 ? "" : "s"} in all`);
	check(child?.done === true, "the child is marked done");
	check(!childHistory.includes("You ended your turn without reporting"), "the child did not have to be reminded");
	check(stopped.length === 0, "the parent was never told a child went quiet", stopped[0]?.envelope.payload.text.slice(0, 200) ?? "");

	console.log("");
	for (const [ok, what, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${what}${!ok && detail ? `\n    ${detail}` : ""}`);
	failed = checks.some(([ok]) => !ok);
	console.log("");
	for (const node of host.nodes()) console.log(`  ${node.name.padEnd(24)} ${node.usage ? `${node.usage.tokens} tokens${node.usage.cost > 0 ? ` · $${node.usage.cost.toFixed(4)}` : ""}` : "no usage recorded"}`);
} finally {
	await host.stop();
	console.log(`\nSessions and state are in ${scratch}`);
}
process.exit(failed ? 1 : 0);
