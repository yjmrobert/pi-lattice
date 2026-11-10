// Every model call answers with what it can see, so the runner can assert on context.
export default (ai) => {
	const step = (context) => {
		const system = ai.getCurrentSystemPrompt(context.messages);
		const role = /<lattice-role>([\s\S]*?)<\/lattice-role>/.exec(system)?.[1]?.trim() ?? "none";
		const last = context.messages[context.messages.length - 1];
		const lastText = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
		return ai.fauxAssistantMessage(`role=${role} lastRole=${last.role} last=${lastText.slice(0, 120)}`);
	};
	return Array.from({ length: 50 }, () => step);
};
