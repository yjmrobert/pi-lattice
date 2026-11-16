import { childrenOf, isClosed } from "../../packages/protocol/src/index.ts";
import type { Check, Scenario } from "./scenario.ts";
import type { World } from "./world.ts";

const STORY = "FACT.txt in the root of the repository holds the single word heliotrope.\n\nDone means: the file exists and its only content is that word.";

/** A result reported on a story, with the file as it was left, and the reviewer the host starts for it. */
async function review(world: World, check: Check, content: string): Promise<{ closed: boolean; state: string; comments: string[] }> {
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
	const done = await world.until(() => world.quiet() && reviewer()?.done === true && world.issue(3)?.state !== "review");
	const scheme = world.host.uiState().work?.scheme;
	const issue = world.issue(3);
	const comments = (await planner.read(3)).comments.map((comment) => comment.body);
	const toLead = world.host.traffic({ node: lead.id, limit: 1000 }).filter((record) => record.recipient === lead.id && record.envelope.intent === "result");

	check(world.blocked === "", "nobody waited on a question", world.blocked);
	check(reviewer() !== undefined, "a reviewer was started for the result");
	check(done, "the reviewer decided and reported", `the issue is ${issue?.state}`);
	check(world.read("FACT.txt") === `${content}\n` && world.changed().length === 0, "the reviewer changed nothing in the work", world.changed().join(", "));
	check(toLead.length === 1, "it sent the session it works for one report", `${toLead.length} reports`);
	return { closed: Boolean(scheme && issue && isClosed(scheme, issue)), state: issue?.state ?? "", comments };
}

/** The work does what the issue says: the reviewer closes it. */
export const reviewPass: Scenario = {
	name: "review-pass",
	about: "A result that does what the issue says done means is closed, with what was checked.",
	exercises: ["reviewer", "reporting", "protocol", "template:review", "tools"],
	board: true,
	async run(world, check) {
		const { closed, state } = await review(world, check, "heliotrope");
		check(closed && state === "done", "the issue is closed as done", `it is ${state}`);
	},
};

/** The work does not: the reviewer says what is missing and puts it back. */
export const reviewFail: Scenario = {
	name: "review-fail",
	about: "A result that does not is sent back to be taken again, with what is missing written on the issue.",
	exercises: ["reviewer", "reporting", "protocol", "template:review", "tools"],
	board: true,
	async run(world, check) {
		const { closed, state, comments } = await review(world, check, "magenta");
		check(!closed, "the issue was not closed", `it is ${state}`);
		check(state === "todo", "it is back where work is taken from", `it is ${state}`);
		check(comments.some((comment) => /heliotrope|magenta/i.test(comment)), "what is missing is written on the issue", comments.join(" | ").slice(0, 300));
	},
};
