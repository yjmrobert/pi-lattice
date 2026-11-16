import { childrenOf, isPlanned } from "../../packages/protocol/src/index.ts";
import type { Scenario } from "./scenario.ts";

const LEVELS = ["epic", "feature", "story", "task"];

/** A coordinator with no server lays work out on the tree before any of it starts. */
export const planLayout: Scenario = {
	name: "plan-layout",
	about: "A coordinator asked for a plan lays it out as planned items, by level, and starts none of it.",
	exercises: ["coordinator", "plan-items", "protocol", "tools"],
	async run(world, check) {
		world.file("report.js", "// Prints the monthly report as a table.\nexport function report(rows) {\n\treturn rows.map((row) => row.join(\" | \")).join(\"\\n\");\n}\n");
		const first = await world.host.createRoot({
			name: "eval",
			cwd: world.work,
			fragments: ["coordinator"],
			brief: [
				"Plan this, and only plan it: the report command gets CSV export.",
				"Lay the plan out on the tree as one feature with two or three stories under it, so that I can see it and put sessions on it myself.",
				"Start none of it, and change no files.",
				"Then answer with one line that starts with PLANNED.",
			].join(" "),
		});
		const done = await world.until(async () => world.quiet() && /^\s*PLANNED/m.test(await world.last(first.id)));
		const calls = await world.tools(first.id);
		const items = calls.filter((call) => call.name === "plan_item");
		const all = world.nodes();
		const planned = all.filter((node) => node.rootId === first.id && isPlanned(node));
		const features = planned.filter((node) => node.kind === "feature");
		const stories = planned.filter((node) => node.kind === "story");

		check(world.blocked === "", "nobody waited on a question", world.blocked);
		check(done, "it finished and said PLANNED", (await world.last(first.id)).slice(0, 200));
		check(items.length >= 3, "it laid the work out as planned items", `${items.length} planned`);
		check(planned.length > 0 && planned.every((node) => LEVELS.includes(node.kind)), "every item has a kind that says its level", planned.map((node) => `${node.name}: ${node.kind}`).join(", "));
		check(features.length === 1 && stories.length >= 2 && stories.length <= 3, "one feature with two or three stories", `${features.length} features, ${stories.length} stories`);
		check(stories.length > 0 && stories.every((story) => story.parentId === features[0]?.id), "the stories are under the feature", stories.map((story) => `${story.name} under ${all.find((node) => node.id === story.parentId)?.name}`).join(", "));
		check(!calls.some((call) => call.name === "spawn_session") && childrenOf(all, first.id).every((node) => isPlanned(node)), "it started none of it", calls.map((call) => call.name).join(" "));
		check(world.changed().length === 0, "it changed no files", world.changed().join(", "));
	},
};
