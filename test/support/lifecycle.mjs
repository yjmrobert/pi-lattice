/**
 * A scripted "model" that plays out a feature lifecycle, choosing what to do from the role
 * fragments in its system prompt. A coordinator spawns one child per phase and advances when
 * each reports; a worker does its phase's work and reports to its parent.
 */
const textOf = (message) => {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
};
const PHASES = ["grilling", "planning", "implementation", "verification"];

export default (ai) => {
	const call = (name, args) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" });
	const say = (text) => ai.fauxAssistantMessage(text);

	const step = (context) => {
		const system = ai.getCurrentSystemPrompt(context.messages);
		const roles = [...system.matchAll(/<lattice-role-([\w-]+)>/g)].map((match) => match[1]);
		const last = context.messages[context.messages.length - 1];
		const text = textOf(last);

		if (roles.includes("coordinator")) {
			if (last.role === "toolResult") return say(`noted: ${text.split("\n")[0]}`);
			const inbound = /<lattice-message [^>]*>\n([\s\S]*?)\n<\/lattice-message>/.exec(text)?.[1];
			const spawn = (phase, extra = {}) =>
				call("spawn_session", {
					name: phase,
					kind: phase,
					fragments: ["worker", phase, ...(extra.scope ? [extra.scope] : [])],
					workspace: extra.workspace ?? "shared",
					brief: `Phase: ${phase}. Input from the previous phase: ${inbound ?? text}`,
				});
			if (!inbound) return spawn("grilling", { scope: "story" });
			if (inbound.startsWith("grilling done")) return spawn("planning");
			if (inbound.startsWith("planning done")) return spawn("implementation", { scope: "task", workspace: "worktree" });
			if (inbound.startsWith("implementation done")) return spawn("verification");
			if (inbound.startsWith("verification done")) return say(`FEATURE COMPLETE after ${inbound}`);
			return say(`unexpected message: ${inbound}`);
		}

		const phase = PHASES.find((name) => roles.includes(name)) ?? "unknown";
		const report = `${phase} done roles=${roles.join("+")}`;
		if (last.role === "toolResult") {
			if (last.toolName === "write") return call("send_message", { to: "parent", intent: "result", text: `${report} wrote feature.txt` });
			return say("reported");
		}
		if (phase === "implementation") return call("write", { path: "feature.txt", content: "built by the implementation session\n" });
		return call("send_message", { to: "parent", intent: "result", text: report });
	};
	return Array.from({ length: 200 }, () => step);
};
