import { childrenOf } from "../../packages/protocol/src/index.ts";
import type { Scenario } from "./scenario.ts";

const WORD = "heliotrope";

/** One delegation: a coordinator creates a child, the child does the work and reports once. */
export const delegation: Scenario = {
	name: "delegation",
	about: "A coordinator delegates one piece of work; the child does it and reports once, unprompted.",
	exercises: ["coordinator", "protocol", "reporting", "worker", "template:brief", "template:reminder", "tools"],
	async run(world, check) {
		const first = await world.host.createRoot({
			name: "eval",
			cwd: world.work,
			fragments: ["coordinator"],
			brief: [
				"This is a check of delegation. Do not do the work yourself.",
				`Create exactly one child session and have it create a file named FACT.txt in the working directory containing the single word ${WORD}.`,
				"When the child has reported back, check the file, then answer me with one line that starts with DONE.",
			].join(" "),
		});
		const done = await world.until(async () => world.quiet() && (await world.texts(first.id)).some((text) => /^\s*DONE/m.test(text)));

		const children = childrenOf(world.nodes(), first.id);
		const child = children[0];
		const toParent = world.host.traffic({ node: first.id, limit: 1000 }).filter((record) => record.recipient === first.id);
		const results = toParent.filter((record) => record.envelope.intent === "result");
		const stopped = toParent.filter((record) => record.envelope.intent === "stopped");
		const childHistory = child ? await world.history(child.id) : "";
		const fact = world.read("FACT.txt", child?.cwd ?? world.work);

		check(world.blocked === "", "nobody waited on a question", world.blocked);
		check(done, "the coordinator finished and said DONE");
		check(children.length === 1, "it created exactly one child", `${children.length} created`);
		check(Boolean(child && child.brief.includes("FACT.txt") && child.brief.toLowerCase().includes(WORD)), "the brief stands on its own: it names the file and the word", child ? `brief: ${child.brief.slice(0, 200)}` : "");
		check(child?.fragments.includes("reporting") === true, "the child was told how to report", child ? `roles: ${child.fragments.join(" ")}` : "");
		check(fact?.toLowerCase().includes(WORD) === true, "the child did the work", fact ?? "no FACT.txt");
		check(results.length === 1, "the child sent its parent exactly one result", `${results.length} result${results.length === 1 ? "" : "s"}, ${toParent.length} message${toParent.length === 1 ? "" : "s"} in all`);
		check(child?.done === true, "the child is marked done");
		check(!childHistory.includes("You ended your turn without reporting"), "the child did not have to be reminded");
		check(stopped.length === 0, "the parent was never told a child went quiet", stopped[0]?.envelope.payload.text.slice(0, 200) ?? "");
	},
};
