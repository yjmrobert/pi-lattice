/**
 * A scripted "model" that obeys directives found in the last message it was shown.
 *
 *   !tool <name> <json>   call a tool with the given arguments
 *   !reply <text>         answer the <lattice-message> in the last message via send_message
 *   !pingpong             answer every lattice message with another !pingpong
 *   !sleep <seconds>      (in a lattice message) run a shell sleep, to stay busy for a while
 *
 * After a tool result it reports the result as text. Anything else is echoed, together
 * with the role sections it can see, so tests can assert on exactly what the model saw.
 */
const textOf = (message) => {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
};

export default (ai) => {
	const step = (context) => {
		const last = context.messages[context.messages.length - 1];
		const text = textOf(last);
		if (last.role === "toolResult") {
			return ai.fauxAssistantMessage(`tool-result${last.isError ? "-error" : ""}: ${text}`);
		}
		const inbound = /<lattice-message id="([^"]+)" from="([^"]+)"/.exec(text);
		const tool = /!tool (\w+) (\{[\s\S]*\})/.exec(text);
		if (tool && !inbound) {
			return ai.fauxAssistantMessage([ai.fauxToolCall(tool[1], JSON.parse(tool[2]))], { stopReason: "toolUse" });
		}
		if (inbound) {
			const body = /<lattice-message [^>]*>\n([\s\S]*?)\n<\/lattice-message>/.exec(text)?.[1] ?? "";
			const nap = /!sleep (\d+)/.exec(body);
			if (nap) return ai.fauxAssistantMessage([ai.fauxToolCall("bash", { command: `sleep ${nap[1]}` })], { stopReason: "toolUse" });
			const reply = /!reply (.*)/.exec(body);
			const answer = body.includes("!pingpong") ? "!pingpong" : reply?.[1];
			if (answer !== undefined) {
				return ai.fauxAssistantMessage([ai.fauxToolCall("send_message", { to: inbound[2], text: answer, replyTo: inbound[1] })], { stopReason: "toolUse" });
			}
		}
		const system = ai.getCurrentSystemPrompt(context.messages);
		const roles = [...system.matchAll(/<(lattice-role-[\w-]+)>/g)].map((match) => match[1]).join(",");
		return ai.fauxAssistantMessage(`echo[${last.role}] roles=[${roles}] ${text}`);
	};
	return Array.from({ length: 200 }, () => step);
};
