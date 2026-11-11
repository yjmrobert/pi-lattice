/** Small modal building blocks for the host UI: a framed panel that asks one question. */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, matchesKey, type SelectItem, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bold, dim } from "./style.ts";

/** A framed panel with a title, optional message, one interactive child and a hint line. */
export class Modal implements Component, Focusable {
	private readonly title: string;
	private readonly message: string;
	private readonly child: Component;
	private readonly hint: string;
	private isFocused = false;

	constructor(title: string, message: string, child: Component, hint: string) {
		this.title = title;
		this.message = message;
		this.child = child;
		this.hint = hint;
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		if ("focused" in this.child) (this.child as Focusable).focused = value;
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	render(width: number): string[] {
		const inner = Math.max(10, width - 4);
		const body = [
			...wrapTextWithAnsi(bold(this.title), inner),
			...(this.message ? ["", ...this.message.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner))] : []),
			"",
			...this.child.render(inner),
			"",
			...wrapTextWithAnsi(dim(this.hint), inner),
		];
		const pad = (line: string): string => {
			const clipped = truncateToWidth(line, inner);
			return `│ ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} │`;
		};
		return [`┌${"─".repeat(inner + 2)}┐`, ...body.map(pad), `└${"─".repeat(inner + 2)}┘`];
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

export interface Choice {
	value: string;
	label: string;
	description?: string;
}

/** A select-one modal. `onDone` receives the chosen value, or undefined when cancelled. */
export function selectModal(title: string, message: string, choices: readonly Choice[], onDone: (value: string | undefined) => void): Modal {
	const items: SelectItem[] = choices.map((choice) => ({ value: choice.value, label: choice.label, ...(choice.description ? { description: choice.description } : {}) }));
	const list = new SelectList(items, Math.min(12, Math.max(3, items.length)), getSelectListTheme());
	list.onSelect = (item) => onDone(item.value);
	list.onCancel = () => onDone(undefined);
	return new Modal(title, message, list, "↑↓ move · enter choose · esc cancel");
}

/** A pick-several modal. Enter toggles an item; choosing "Done" finishes. */
export function multiSelectModal(title: string, message: string, choices: readonly Choice[], initial: readonly string[], onDone: (values: string[] | undefined) => void): Modal {
	const chosen = [...initial];
	const DONE = "\u0000done";
	let index = 0;
	const build = (): SelectList => {
		const items: SelectItem[] = [
			{ value: DONE, label: `Done${chosen.length > 0 ? ` (${chosen.join(" + ")})` : " (none)"}` },
			...choices.map((choice) => ({
				value: choice.value,
				label: `${chosen.includes(choice.value) ? "[x]" : "[ ]"} ${choice.label}`,
				...(choice.description ? { description: choice.description } : {}),
			})),
		];
		const list = new SelectList(items, Math.min(14, items.length), getSelectListTheme());
		list.setSelectedIndex(index);
		list.onSelectionChange = (item) => {
			index = items.findIndex((candidate) => candidate.value === item.value);
		};
		list.onCancel = () => onDone(undefined);
		list.onSelect = (item) => {
			if (item.value === DONE) {
				onDone(chosen);
				return;
			}
			const at = chosen.indexOf(item.value);
			if (at >= 0) chosen.splice(at, 1);
			else chosen.push(item.value);
			index = items.findIndex((candidate) => candidate.value === item.value);
			holder.list = build();
		};
		return list;
	};
	const holder = { list: build() };
	const proxy: Component = {
		render: (width) => holder.list.render(width),
		handleInput: (data) => holder.list.handleInput(data),
		invalidate: () => holder.list.invalidate(),
	};
	return new Modal(title, message, proxy, "↑↓ move · enter toggle · choose Done to finish · esc cancel");
}

/** A one-line text modal. `onDone` receives the text, or undefined when cancelled. */
export function inputModal(title: string, message: string, options: { placeholder?: string; initial?: string }, onDone: (value: string | undefined) => void): Modal {
	const input = new Input(options.placeholder ? { placeholder: options.placeholder } : {});
	if (options.initial) input.setValue(options.initial);
	input.onSubmit = (value) => onDone(value);
	input.onEscape = () => onDone(undefined);
	const proxy: Component & Focusable = {
		get focused() {
			return input.focused;
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		render: (width) => input.render(width),
		handleInput: (data) => {
			if (matchesKey(data, "escape")) onDone(undefined);
			else input.handleInput(data);
		},
		invalidate: () => input.invalidate(),
	};
	return new Modal(title, message, proxy, "enter confirm · esc cancel");
}
