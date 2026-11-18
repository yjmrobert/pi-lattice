/**
 * Two people on two machines and a server that stays on: what docs/two-machine-handoff.md
 * checks by hand, checked here. Each machine is a container with its own filesystem, keys
 * and network address, running Pi with pi-lattice installed from the packed package.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeMeta } from "@pi-lattice/protocol";
import { eventually } from "../support/harness.ts";
import { Stack } from "./support/stack.ts";
import { join, SHOP, shop, shopState, tool, tree } from "./support/team.ts";

let stack: Stack;

beforeEach(async () => {
	stack = await Stack.up();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(`What the machines said is in ${await stack.keepLogs(context.task.name)}`);
	await stack.down();
});

describe("two machines and a server", () => {
	it("a session goes from one machine to the other with its conversation and its branch, and mail between them waits for a person", async () => {
		const address = await stack.address();
		await shop(stack);
		const yan = await join(stack, "yan", address);
		const sam = await join(stack, "sam", address);
		await sam.told("Found yan");

		// Yan's session becomes a tree, and its agent starts a child in a worktree of its own, which commits.
		const { root, kid } = await tree(stack, yan);
		await stack.sh("yan", `echo "yan's work in progress" > work.txt && git add . && git commit -q -m wip`, kid.cwd);

		// Sam's machine hears of both, as yan's, and reads the child's conversation from yan's machine.
		await shopState(stack, "sam", (state) => state.nodes.filter((node) => node.owner === "yan").length === 2, "yan's sessions to appear for sam");
		sam.start(`/lattice open ${kid.id}`);
		const reading = await sam.answer("editor", "impl (owned by yan, read-only", { cancelled: true });
		expect(String(reading.prefill)).toContain("heliotrope");

		// Sam asks for it. It stays yan's until yan says yes, and then it moves by itself.
		sam.start(`/lattice take ${kid.id}`);
		await sam.told("Asked yan");
		await shopState(stack, "yan", (state) => state.sharing?.requests.some((request) => request.from === "sam" && request.nodeId === kid.id), "sam's request to reach yan");
		expect((await stack.state("yan", SHOP))?.nodes.find((node) => node.id === kid.id)?.owner).toBe("yan");
		yan.start(`/lattice approve ${kid.id} sam`);
		await yan.answer("confirm", 'Hand "impl" to sam?', { confirmed: true });
		await shopState(stack, "yan", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam"), "yan to let the session go");

		// It arrived: on sam's machine, in a worktree of sam's checkout, on the same branch, with yan's commit.
		const adopted = (await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam"), "sam to take the session over")).nodes.find((node) => node.id === kid.id) as NodeMeta;
		expect(adopted).toMatchObject({ owner: "sam", version: 2, workspace: "worktree", branch: kid.branch });
		expect(adopted.cwd.startsWith(`${SHOP}/.lattice/worktrees/`)).toBe(true);
		expect(await stack.sh("sam", "cat work.txt && git log -1 --format=%s", adopted.cwd)).toBe("yan's work in progress\nwip");
		await shopState(stack, "yan", (state) => state.sharing?.pendingTransfers.length === 0, "sam's receipt to reach yan");
		// The conversation came along: it is read on sam's machine now, with nothing asked of yan's.
		expect(JSON.stringify((await stack.ui("sam", SHOP, "messages", { nodeId: kid.id }))?.messages ?? [])).toContain("heliotrope");

		// Mail from yan's agent to the session sam now owns waits on sam's machine for sam.
		await yan.pi.prompt(tool("send_message", { to: kid.id, text: "!reply thanks from sam's side" }));
		const held = await eventually(async () => (await stack.ui("sam", SHOP, "pendingMail", {}))?.mail[0], "yan's message to wait for sam", 30_000);
		expect(held.envelope).toMatchObject({ from: root.id, fromOwner: "yan" });
		// Sam approves; sam's agent answers; the answer waits on yan's machine for yan.
		await stack.ui("sam", SHOP, "decideMail", { nodeId: kid.id, envelopeId: held.envelope.id, action: "approve" });
		const reply = await eventually(async () => (await stack.ui("yan", SHOP, "pendingMail", {}))?.mail[0], "the answer to wait for yan", 30_000);
		expect(reply.envelope).toMatchObject({ from: kid.id, fromOwner: "sam", payload: { text: "thanks from sam's side" } });

		// Sam offers it back, and yan accepts: it is yan's again, with nothing more for sam to do.
		sam.start(`/lattice offer ${kid.id} yan`);
		await sam.told("Offered to yan");
		await shopState(stack, "yan", (state) => state.sharing?.handoffs.some((handoff) => handoff.nodeId === kid.id && handoff.role === "recipient" && handoff.state === "offered"), "sam's offer to reach yan");
		await stack.ui("yan", SHOP, "sharing", { action: "accept", args: [kid.id] });
		await shopState(stack, "yan", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "yan" && node.version === 3), "the session to be yan's again");
		await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "yan"), "sam to see it is yan's");

		// Sam's machine leaves the network, saying nothing: yan sees that sam is away, and the tree is as it was.
		await stack.unplug("sam");
		const after = await shopState(stack, "yan", (state) => state.sharing?.people.some((each) => each.name === "sam" && !each.online), "yan to see that sam is away", 90_000);
		expect(after.nodes.map((node) => node.id)).toContain(kid.id);
	});
});
