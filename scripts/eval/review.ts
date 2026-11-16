import { childrenOf } from "../../packages/protocol/src/index.ts";
import type { Check, Scenario } from "./scenario.ts";
import type { ToolCall, World } from "./world.ts";

const STORY = "FACT.txt in the root of the repository holds the single word heliotrope.\n\nDone means: the file exists and its only content is that word.";

/** A command that changes the work, as far as its text says. Reading is always allowed. */
const WRITES = /(>\s*\S*FACT|\bgit\s+(add|commit|reset|checkout|restore)\b|\bsed\s+-i\b|\btee\b|\brm\s|\bmv\s)/;

interface Verdict {
	/** The state the reviewer moved the issue to, when it moved it. */
	state: string | undefined;
	/** What it wrote on the issue. */
	comments: string[];
	/** Whether it gave a reason with what it changed. */
	why: boolean;
}

/**
 * A result reported on a story, with the file as it was left, and the reviewer the host starts
 * for it. What is judged is what that reviewer did until it reported: the session it works for
 * may then act on the verdict, have the work fixed and have it checked again, and that is not
 * the reviewer's doing.
 */
async function review(world: World, check: Check, content: string): Promise<Verdict> {
	world.file("FACT.txt", `${content}\n`);
	const planner = await world.client("planner");
	await planner.create({ title: "Facts", type: "epic" });
	await planner.create({ title: "Colours", parent: 1 });
	await planner.create({ title: "The colour file", parent: 2, body: STORY });
	await world.until(() => world.issues().length === 3);
	const lead = await world.host.createRoot({ name: "lead", cwd: world.work, fragments: ["coordinator"] });
	// The work was done by an agent that is not a session here; what it reports is all the reviewer is given.
	const taken = await planner.next({ repo: "work", lease: true, type: "story" }, { as: "builder" });
	await planner.done(taken.issue?.number ?? 3, { summary: "FACT.txt holds the word heliotrope.", checks: "cat FACT.txt" }, { as: "builder" });
	const reviewer = (): ReturnType<World["nodes"]>[number] | undefined => childrenOf(world.nodes(), lead.id).find((node) => node.fragments.includes("reviewer"));
	const reported = await world.until(() => reviewer()?.done === true);
	const id = reviewer()?.id;

	// Everything between the reviewer and the session it works for, oldest first.
	const mail = id ? world.host.traffic({ node: id, limit: 1000 }).reverse() : [];
	const heard = mail.findIndex((record) => record.recipient === id);
	const before = heard === -1 ? mail : mail.slice(0, heard);
	const reports = before.filter((record) => record.envelope.from === id && record.envelope.intent === "result");
	// What it did up to its report: the calls before the message that carried it.
	const calls: ToolCall[] = id ? await world.tools(id) : [];
	const upTo = calls.findIndex((call) => call.name === "send_message" && call.args.intent === "result" && call.args.to === "parent" && (call.args.replyTo === undefined || /^env_/.test(String(call.args.replyTo))));
	const own = upTo === -1 ? calls : calls.slice(0, upTo);
	const updates = own.filter((call) => call.name === "work_update");
	const wrote = own.filter((call) => call.name === "edit" || call.name === "write" || (call.name === "bash" && WRITES.test(String(call.args.command ?? ""))));

	check(world.blocked === "", "nobody waited on a question", world.blocked);
	check(id !== undefined, "a reviewer was started for the result");
	check(reported, "the reviewer decided and reported", `the issue is ${world.issue(3)?.state}`);
	check(own.some((call) => call.name === "work_list" && call.args.under === 3), "it read the issue before deciding", own.map((call) => call.name).join(" "));
	check(wrote.length === 0, "the reviewer changed nothing in the work", wrote.map((call) => `${call.name} ${String(call.args.command ?? call.args.path ?? "")}`).join(" | ").slice(0, 300));
	check(reports.length === 1, "it sent the session it works for one report", `${reports.length} reports before it heard back`);
	return {
		state: updates.map((call) => call.args.state).filter((state): state is string => typeof state === "string").at(-1),
		comments: updates.map((call) => call.args.comment).filter((comment): comment is string => typeof comment === "string"),
		why: updates.length > 0 && updates.every((call) => typeof call.args.why === "string" && call.args.why.trim() !== ""),
	};
}

/** The work does what the issue says: the reviewer closes it. */
export const reviewPass: Scenario = {
	name: "review-pass",
	about: "A result that does what the issue says done means is closed, with what was checked.",
	exercises: ["reviewer", "reporting", "protocol", "template:review", "tools"],
	board: true,
	async run(world, check) {
		const verdict = await review(world, check, "heliotrope");
		check(verdict.state === "done", "the reviewer closed the issue as done", `it moved it to ${verdict.state ?? "nothing"}`);
		check(verdict.why, "it said what it checked", "no why on the change");
	},
};

/** The work does not: the reviewer says what is missing and puts it back. */
export const reviewFail: Scenario = {
	name: "review-fail",
	about: "A result that does not is sent back to be taken again, with what is missing written on the issue.",
	exercises: ["reviewer", "reporting", "protocol", "template:review", "tools"],
	board: true,
	async run(world, check) {
		const verdict = await review(world, check, "magenta");
		check(verdict.state === "todo", "the reviewer put the issue back where work is taken from", `it moved it to ${verdict.state ?? "nothing"}`);
		check(verdict.comments.some((comment) => /heliotrope|magenta/i.test(comment)), "what is missing is written on the issue", verdict.comments.join(" | ").slice(0, 300));
	},
};
