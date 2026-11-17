/** The tree of the mockup, as the state a host would give: three epics, features, stories and tasks, four people. */
import type { NodeMeta, NodeStatus, UiState } from "@pi-lattice/protocol";
import type { TreeSource } from "../src/index.ts";

export const LEVELS = ["epic", "feature", "story", "task"];

/**
 * Everything that has something under it, as a person who opened it all would have it in their
 * state: the whole tree is drawn whatever the room. A tree wider than its window otherwise folds
 * around this person's work; a test of how the whole of it is moved over wants it whole.
 */
export const allOpen = (items: Iterable<{ id: string; children: readonly unknown[] }>): Set<string> => new Set([...items].filter((item) => item.children.length > 0).map((item) => item.id));

type Spec = [name: string, kind: string, how: string, kids?: Spec[]];

/**
 * `how` is a few words: an owner (`@sam`), a role (`coordinator`), and a state: `run`, `ask`,
 * `idle`, `plan`, `done`, `fail`, or `wait:<name>`.
 */
export function world(specs: Spec[], me = "yan", extra: Partial<UiState> = {}): TreeSource {
	const nodes: NodeMeta[] = [];
	const attention: UiState["attention"] = {};
	const add = (spec: Spec, parent: NodeMeta | null, owner: string): void => {
		const [name, kind, how, kids] = spec;
		const words = how.split(" ").filter(Boolean);
		const by = words.find((word) => word.startsWith("@"))?.slice(1) ?? owner;
		const state = words.find((word) => /^(run|ask|idle|plan|done|fail|wait:.*)$/.test(word)) ?? "idle";
		const role = words.find((word) => !word.startsWith("@") && word !== state);
		const status: NodeStatus = state === "run" ? "running" : state === "ask" ? "blocked" : state === "fail" ? "failed" : state === "plan" || state.startsWith("wait") ? "dormant" : "idle";
		const node: NodeMeta = {
			id: name, parentId: parent?.id ?? null, rootId: parent?.rootId ?? name, kind, name, brief: "", fragments: ["protocol", ...(parent ? ["reporting"] : []), ...(role ? [role] : [])], owner: by, version: 1, status,
			sessionId: null, sessionFile: null, cwd: "/shop", workspace: "shared", branch: null, repo: "shop", createdAt: "2026-11-11", updatedAt: "2026-11-11",
			...(state === "plan" ? { planned: true } : {}), ...(state === "done" ? { done: true } : {}), ...(state.startsWith("wait:") ? { waitsOn: [state.slice(5)] } : {}),
		};
		nodes.push(node);
		if (state === "ask") attention[name] = { dialogs: 1, pending: 0 };
		for (const kid of kids ?? []) add(kid, node, by);
	};
	for (const spec of specs) add(spec, null, me);
	const owners = [...new Set(nodes.map((node) => node.owner))];
	return {
		key: "/shop/.lattice", repo: "shop",
		state: {
			owner: me, nodes, attention, foreground: [],
			sharing: { team: "harbor", scope: "shop", people: owners.map((name) => ({ name, fingerprint: name, trust: "trusted", online: name !== "teo", here: name !== "teo", self: name === me })), handoffs: [], requests: [], pendingTransfers: [], elsewhere: [] },
			...extra,
		},
	};
}

export const HARBOR: Spec[] = [
	["checkout-v2", "epic", "coordinator run", [
		["payments", "feature", "planner run", [
			["cards", "story", "plan", [["card-vault", "task", "worker done"], ["card-form", "task", "worker done"], ["3ds-flow", "task", "worker run"], ["e2e", "task", "worker wait:3ds-flow"]]],
			["webhooks", "story", "reviewer ask", [["stripe-listen", "task", "worker ask"], ["retry-queue", "task", "worker run"], ["signatures", "task", "plan"]]],
			["tax-lines", "story", "plan", [["rates", "task", "worker wait:copy"], ["display", "task", "plan"]]],
		]],
		["cart", "feature", "plan", [
			["totals-api", "story", "plan", [["endpoint", "task", "worker done"], ["cache", "task", "worker done"], ["docs", "task", "worker done"]]],
			["offline", "story", "@teo plan", [["local-store", "task", "worker done"], ["sync-engine", "task", "plan"], ["conflicts", "task", "worker ask"]]],
		]],
	]],
	["pricing-migration", "epic", "@sam coordinator run", [
		["new-tables", "feature", "plan", [
			["tables", "story", "planner idle", [["schema", "task", "worker done"], ["copy", "task", "worker run"], ["verify-copy", "task", "worker wait:copy"]]],
			["dual-write", "story", "plan", [["writer", "task", "worker run"], ["reader", "task", "plan"], ["flag", "task", "plan"], ["cutover", "task", "plan"]]],
		]],
		["invoices", "feature", "plan", [["export", "story", "plan", [["csv", "task", "worker done"], ["pdf", "task", "worker ask"], ["fixtures", "task", "worker done"], ["review", "verify", "verifier run"]]]]],
	]],
	["sso-rollout", "epic", "@mira coordinator run", [
		["sign-on", "feature", "planner run", [
			["oidc", "story", "plan", [["provider", "task", "worker run"], ["claims", "task", "worker done"], ["logout", "task", "plan"]]],
			["sessions", "story", "plan", [["store", "task", "worker run"], ["failover", "task", "worker done"], ["load-test", "task", "worker wait:store"]]],
		]],
	]],
];

/**
 * A project of many people, larger than any window: `epics` epics of `features` features of
 * `stories` stories of `tasks` tasks, each epic someone's. The same one every time it is built.
 * This person runs sessions in a few places in the first epic, and one of them asks; so does one
 * task in every other epic, of whoever that epic is.
 */
export function large(epics: number, features: number, stories: number, tasks: number, people = ["yan", "sam", "mira", "teo", "ines"]): Spec[] {
	let seed = 11;
	const chance = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	return Array.from({ length: epics }, (_e, e): Spec => {
		const owner = people[e % people.length] as string;
		return [`epic-${e}`, "epic", `@${owner} coordinator run`, Array.from({ length: features }, (_f, f): Spec => {
			const mine = e === 0 && f < 2;
			return [`feat-${e}-${f}`, "feature", mine ? "planner run" : "plan", Array.from({ length: stories }, (_s, s): Spec => {
				const here = mine && s === 0;
				return [`story-${e}-${f}-${s}`, "story", "plan", Array.from({ length: tasks }, (_t, t): Spec => {
					const state = here && t === 0 ? (f === 0 ? "worker ask" : "worker run") : e > 0 && f === 0 && s === 0 && t === 0 ? "worker ask" : chance() < 0.3 ? "worker done" : chance() < 0.08 ? "worker run" : "plan";
					return [`task-${e}-${f}-${s}-${t}`, "task", state];
				})];
			})];
		})];
	});
}
