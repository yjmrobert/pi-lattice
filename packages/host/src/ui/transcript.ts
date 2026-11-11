/**
 * One node's conversation, rendered with Pi's own chat components (ADR 0006). Built from
 * `get_messages` when a node is attached, then kept current from the live event stream.
 */
import { AssistantMessageComponent, CustomMessageComponent, getMarkdownTheme, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, type MarkdownTheme, Text, type TUI } from "@earendil-works/pi-tui";
import type { RpcRecord } from "../pi-process.ts";
import { dim } from "./style.ts";

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part: RpcRecord) => part?.type === "text").map((part: RpcRecord) => String(part.text ?? "")).join("");
};

export class Transcript {
	readonly container = new Container();
	/** True once history has been loaded from the session. */
	loaded = false;
	/** Live events held back while a history snapshot is in flight. */
	private held: Array<{ event: RpcRecord; seq: number }> | undefined;
	private readonly tui: TUI;
	private readonly cwd: string;
	private readonly markdown: MarkdownTheme;
	private streaming: AssistantMessageComponent | undefined;
	private readonly tools = new Map<string, ToolExecutionComponent>();

	constructor(tui: TUI, cwd: string) {
		this.tui = tui;
		this.cwd = cwd;
		this.markdown = getMarkdownTheme();
	}

	/** Replace the content with a placeholder line, for nodes whose session is not running. */
	placeholder(text: string): void {
		this.held = undefined;
		this.reset();
		this.container.addChild(new Text(dim(text), 1, 1));
	}

	private reset(): void {
		this.container.clear();
		this.tools.clear();
		this.streaming = undefined;
		this.loaded = false;
	}

	/**
	 * Call before requesting a history snapshot. Until {@link load}, live events are held
	 * back instead of being applied to content that is about to be replaced.
	 */
	beginLoad(): void {
		this.loaded = false;
		this.held = [];
	}

	/** Give up on a load that failed. */
	abandonLoad(): void {
		this.held = undefined;
	}

	/**
	 * Rebuild from a session's full message list, then apply the held events that came after
	 * it. `mark` is the sequence number of the last event the snapshot already reflects.
	 */
	load(messages: readonly RpcRecord[], mark = Number.POSITIVE_INFINITY): void {
		const held = this.held ?? [];
		this.held = undefined;
		this.reset();
		for (const message of messages) this.addMessage(message);
		this.loaded = true;
		for (const { event, seq } of held) {
			if (seq > mark) this.handle(event, seq);
		}
	}

	/** A line from the host or an extension, shown inline but not part of the conversation. */
	notice(text: string): void {
		this.container.addChild(new Text(dim(text), 1, 0));
	}

	private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
		let component = this.tools.get(id);
		if (!component) {
			component = new ToolExecutionComponent(name, id, args, {}, undefined, this.tui, this.cwd);
			this.tools.set(id, component);
			this.container.addChild(component);
		}
		return component;
	}

	private addToolCalls(message: RpcRecord, complete: boolean): void {
		for (const part of Array.isArray(message.content) ? (message.content as RpcRecord[]) : []) {
			if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
			const component = this.tool(part.id, String(part.name), part.arguments);
			component.updateArgs(part.arguments);
			if (complete) component.setArgsComplete();
		}
	}

	private addMessage(message: RpcRecord): void {
		switch (message.role) {
			case "user":
				this.container.addChild(new UserMessageComponent(textOf(message.content), this.markdown));
				break;
			case "assistant":
				this.container.addChild(new AssistantMessageComponent(message as never, false, this.markdown));
				this.addToolCalls(message, true);
				break;
			case "toolResult": {
				const component = this.tool(String(message.toolCallId), String(message.toolName ?? "tool"), undefined);
				component.updateResult({ content: message.content ?? [], details: message.details, isError: message.isError === true });
				break;
			}
			case "custom":
				if (message.display !== false) this.container.addChild(new CustomMessageComponent(message as never, undefined, this.markdown));
				break;
			case "bashExecution":
				this.container.addChild(new Text(`${dim("$")} ${String(message.command ?? "")}\n${String(message.output ?? "")}`, 1, 1));
				break;
			case "compactionSummary":
			case "branchSummary":
				this.container.addChild(new Text(dim("[earlier conversation summarized]"), 1, 1));
				break;
			default:
				break;
		}
	}

	/** Apply one live session event. Returns true when the transcript changed. */
	handle(event: RpcRecord, seq: number): boolean {
		if (!this.loaded) {
			this.held?.push({ event, seq });
			return false;
		}
		const message = event.message as RpcRecord | undefined;
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (message?.role !== "assistant") return false;
				if (!this.streaming) {
					this.streaming = new AssistantMessageComponent(undefined, false, this.markdown);
					this.container.addChild(this.streaming);
				}
				this.streaming.updateContent(message as never, true);
				this.addToolCalls(message, false);
				return true;
			case "message_end":
				if (!message) return false;
				if (message.role === "assistant") {
					if (this.streaming) this.streaming.updateContent(message as never, false);
					else this.container.addChild(new AssistantMessageComponent(message as never, false, this.markdown));
					this.streaming = undefined;
					this.addToolCalls(message, true);
					return true;
				}
				if (message.role === "toolResult") return false; // shown through tool_execution_end
				this.addMessage(message);
				return true;
			case "tool_execution_start":
				this.tool(String(event.toolCallId), String(event.toolName), event.args).markExecutionStarted();
				return true;
			case "tool_execution_update":
				if (event.partialResult) this.tool(String(event.toolCallId), String(event.toolName), event.args).updateResult({ ...event.partialResult, isError: false }, true);
				return true;
			case "tool_execution_end":
				this.tool(String(event.toolCallId), String(event.toolName), undefined).updateResult({
					content: event.result?.content ?? [], details: event.result?.details, isError: event.isError === true,
					...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
				});
				return true;
			case "extension_ui_request":
				if (event.method === "notify" && typeof event.message === "string") {
					this.notice(event.message);
					return true;
				}
				return false;
			default:
				return false;
		}
	}
}
