import type { Check, Scenario } from "./scenario.ts";
import type { World } from "./world.ts";

/** A small board with a coordinator tending it, and one line said on the second feature. */
async function steer(world: World, check: Check, text: string): Promise<{ answer: string; calls: Awaited<ReturnType<World["tools"]>> }> {
	const planner = await world.client("planner");
	await planner.create({ title: "Shop", type: "epic", body: "People can find things and pay for them." });
	await planner.create({ title: "Search", parent: 1, body: "People can find a product by name." });
	await planner.create({ title: "Checkout", parent: 1, body: "People can pay by card." });
	await world.until(() => world.issues().length === 3);
	const lead = await world.host.createRoot({ name: "lead", cwd: world.work, fragments: ["coordinator"] });
	const said = await world.host.steer({ number: 3, text });
	const answered = await world.until(() => world.quiet() && Boolean(world.host.uiState().steers?.find((entry) => entry.id === said.id)?.answer));
	const answer = world.host.uiState().steers?.find((entry) => entry.id === said.id)?.answer ?? "";
	const calls = await world.tools(lead.id);

	check(world.blocked === "", "nobody waited on a question", world.blocked);
	check(answered, "the session tending the branch answered");
	check(answer.length > 0 && answer.length <= 320 && answer.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 2, "its answer is a sentence, not a report", answer.slice(0, 400));
	check(world.issues().length === 3 && world.issue(1)?.title === "Shop" && world.issue(2)?.title === "Search" && world.issue(3)?.title === "Checkout", "nothing else on the board was changed", world.issues().map((issue) => `#${issue.number} ${issue.title}`).join(", "));
	return { answer, calls };
}

const first = (world: World): number | undefined => world.issues().filter((issue) => issue.parent === 1).sort((a, b) => a.rank - b.rank)[0]?.number;

/** Something to do once: the work is reordered and nothing is left standing. */
export const steerErrand: Scenario = {
	name: "steer-errand",
	about: 'A person says "this first" on the tree: the work is reordered, with a reason, and no direction is left standing.',
	exercises: ["coordinator", "protocol", "template:steer", "tools"],
	board: true,
	async run(world, check) {
		const { calls } = await steer(world, check, "this first");
		const changes = calls.filter((call) => call.name === "work_update" || call.name === "work_add");
		check(first(world) === 3, "the item was put first", `first under the epic is #${first(world)}`);
		check((world.issue(3)?.directions ?? []).length === 0, "nothing was kept as a direction: it was something to do once", JSON.stringify(world.issue(3)?.directions ?? []));
		check(changes.length > 0 && changes.every((call) => typeof call.args.why === "string" && call.args.why.trim() !== ""), "every change says why", JSON.stringify(changes.map((call) => call.args)).slice(0, 300));
	},
};

/** A rule that should hold from here on: it is kept as a direction, and the work is left as it was. */
export const steerRule: Scenario = {
	name: "steer-rule",
	about: 'A person says "ask me before anything here lands": it is kept as a direction, and nothing is reordered.',
	exercises: ["coordinator", "protocol", "template:steer", "tools"],
	board: true,
	async run(world, check) {
		await steer(world, check, "ask me before anything here lands");
		const directions = world.issue(3)?.directions ?? [];
		check(directions.length === 1, "it was kept as one direction on the item", JSON.stringify(directions));
		check(directions[0]?.text === "ask me before anything here lands", "in the person's own words", directions[0]?.text ?? "");
		check(first(world) === 2, "the order of the work was left alone", `first under the epic is #${first(world)}`);
	},
};
