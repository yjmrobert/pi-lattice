/**
 * Manual-test helper, not part of the bundle: a tool that asks the person a yes/no question.
 *
 * Nothing in pi-lattice makes a background session ask a question on its own, so this gives a
 * model a way to raise one. See docs/testing.md for how to install it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function askHumanExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_human",
		label: "Ask human",
		description: "Ask the person a yes/no question and wait for their answer. Use it when told to ask before doing something.",
		parameters: Type.Object({
			question: Type.String({ description: "The yes/no question, in one sentence" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const yes = await ctx.ui.confirm("Question", params.question);
			return { content: [{ type: "text", text: yes ? "The person answered yes." : "The person answered no." }], details: { yes } };
		},
	});
}
