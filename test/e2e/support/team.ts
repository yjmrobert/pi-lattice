/** What the tests between machines share: a repository both people have, a person at a Pi, and joining the server. */
import type { UiState } from "@pi-lattice/protocol";
import { eventually, type PiChild, type RpcEvent } from "../../support/harness.ts";
import { HOME, type Machine, type Stack } from "./stack.ts";

export const SHOP = `${HOME}/shop`;

/** A repository both have: yan starts it and pushes it where sam clones it from. */
export const shop = async (stack: Stack): Promise<void> => {
	await stack.sh("yan", "git init -q --bare /srv/git/shop.git && mkdir shop && cd shop && git init -q && echo shop > README.md && git add . && git commit -q -m init && git remote add origin /srv/git/shop.git && git push -q origin main", HOME);
	await stack.sh("sam", "git clone -q /srv/git/shop.git shop", HOME);
};

/** What a person at a Pi is told and asked, and their answers. */
export const person = (pi: PiChild) => {
	const answered = new Set<string>();
	const told = (saying: string, timeoutMs = 40_000) =>
		pi.waitFor(() => pi.notifications().find((text) => text.includes(saying)), `to be told "${saying}"`, timeoutMs).catch((error: Error) => {
			throw new Error(`${error.message}\n${pi.name} was told:\n${pi.notifications().map((text) => `  ${text}`).join("\n")}`);
		});
	/** Wait for the next prompt of a kind whose title says something, and answer it. */
	const answer = async (method: string, saying: string, payload: Record<string, unknown>): Promise<RpcEvent> => {
		const dialog = await pi.waitFor(
			() => pi.events.find((event) => event.type === "extension_ui_request" && event.method === method && !answered.has(event.id) && String(event.title).includes(saying)),
			`a ${method} prompt saying "${saying}"`, 30_000,
		);
		answered.add(dialog.id);
		pi.answer(dialog.id, payload);
		return dialog;
	};
	/** Start a command that asks something; it finishes once the test has answered. */
	const start = (text: string): void => void pi.command(text).catch(() => {});
	return { pi, told, answer, start };
};
export type Person = ReturnType<typeof person>;

/** Open Pi in the shop on a machine and join the server with the line it printed, saying what to be called. */
export const join = async (stack: Stack, machine: Machine, address: string, env: Record<string, string> = {}): Promise<Person> => {
	const at = person(await stack.pi(machine, SHOP, env));
	at.start(`/lattice server ${address}`);
	await at.answer("input", "The name your teammates will see you as", { value: machine });
	await at.told("Joined https://server");
	return at;
};

/** What the host of the shop on a machine knows, once it satisfies a probe. On timeout the error shows what it knew. */
export const shopState = (stack: Stack, machine: Machine, probe: (state: UiState) => unknown, what: string, timeoutMs = 40_000): Promise<UiState> =>
	eventually(async () => {
		const state = await stack.state(machine, SHOP);
		return state && probe(state) ? state : undefined;
	}, what, timeoutMs).catch(async (error: Error) => {
		const state = await stack.state(machine, SHOP).catch(() => undefined);
		throw new Error(`${error.message}\n${machine}'s host knows:\n${JSON.stringify(state && { nodes: state.nodes.map((node) => `${node.name} ${node.owner} v${node.version} ${node.status}`), sharing: state.sharing }, null, 1)}`);
	});

/** A directive the scripted model obeys: call a tool. */
export const tool = (name: string, args: Record<string, unknown>): string => `!tool ${name} ${JSON.stringify(args)}`;

/** Yan's session becomes a tree, and its agent starts a child in a worktree of its own. Gives the two sessions. */
export const tree = async (stack: Stack, yan: Person) => {
	await yan.pi.prompt("hello");
	await yan.pi.command("/lattice");
	const root = (await shopState(stack, "yan", (state) => state.nodes.some((node) => node.parentId === null && node.owner === "yan"), "yan's tree to start")).nodes.find((node) => node.parentId === null);
	await yan.pi.prompt(tool("spawn_session", { name: "impl", brief: "the password is heliotrope", workspace: "worktree", fragments: ["worker"] }));
	const kid = (await shopState(stack, "yan", (state) => state.nodes.some((node) => node.name === "impl" && node.status === "idle"), "yan's child to settle")).nodes.find((node) => node.name === "impl");
	if (!root || !kid) throw new Error("yan's tree did not start");
	return { root, kid };
};
