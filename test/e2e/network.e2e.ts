/**
 * The shapes a network takes between two people, from "things to try on purpose" in
 * docs/two-machine-handoff.md: machines that reach the server and not each other, an address
 * nobody answers at, a machine that goes away half way through, and a server that restarts.
 * None of these can be made on one machine's loopback, which is why they are here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Stack } from "./support/stack.ts";
import { join, person, SHOP, shop, shopState, tree } from "./support/team.ts";

let stack: Stack;

beforeEach(async () => {
	stack = await Stack.up();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(`What the machines said is in ${await stack.keepLogs(context.task.name)}`);
	await stack.down();
});

describe("the network between two machines", () => {
	it("with the server reached and each other not, says which addresses did not answer, and connects once they do", async () => {
		const address = await stack.address();
		await shop(stack);
		// Neither machine is on the network the other is on: each reaches the server by a link of its own.
		await stack.unplug("yan", "mesh");
		await stack.unplug("sam", "mesh");
		const yan = await join(stack, "yan", address);
		const sam = await join(stack, "sam", address);
		const { kid } = await tree(stack, yan);

		// Sam's host says which address it tried and why it did not answer; the server still says what yan is running.
		const apart = await shopState(stack, "sam", (state) => (state.sharing?.tried?.length ?? 0) > 0 && state.work?.sessions.some((session) => session.id === kid.id), "sam's host to have tried yan's address");
		expect(apart.sharing?.tried?.[0]?.why).toContain("no answer");
		expect(apart.sharing?.people.find((each) => each.name === "yan")).toMatchObject({ here: false });
		expect(apart.work?.sessions.find((session) => session.id === kid.id)).toMatchObject({ owner: "yan", name: "impl" });
		expect(apart.nodes).toEqual([]); // the sessions themselves come from yan's machine, which is not reached

		// An offer goes through the server, so it arrives. The session cannot: it goes machine to machine.
		yan.start(`/lattice offer ${kid.id} sam`);
		await yan.told("Offered to sam");
		await shopState(stack, "sam", (state) => state.sharing?.handoffs.some((handoff) => handoff.nodeId === kid.id && handoff.role === "recipient"), "yan's offer to reach sam through the server");
		expect(await stack.ui("sam", SHOP, "sharing", { action: "accept", args: [kid.id] })).toEqual({ text: "Accepted. It is on its way." });
		await shopState(stack, "yan", (state) => state.sharing?.handoffs.some((handoff) => handoff.nodeId === kid.id && handoff.state === "accepted"), "sam's yes to reach yan through the server");
		expect((await stack.state("yan", SHOP))?.nodes.find((node) => node.id === kid.id)?.owner).toBe("yan");

		// Both come onto a network they share, with an address there that neither had when its host started.
		await stack.plug("yan", "mesh");
		await stack.plug("sam", "mesh");
		await shopState(stack, "sam", (state) => state.sharing?.people.some((each) => each.name === "yan" && each.here), "sam's host to connect to yan's", 60_000);
		// What was agreed while they were apart now happens, with nobody doing anything.
		const moved = await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam"), "the session to go to sam", 60_000);
		expect(moved.nodes.find((node) => node.id === kid.id)?.cwd.startsWith(`${SHOP}/.lattice/worktrees/`)).toBe(true);
		await shopState(stack, "yan", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam") && state.sharing?.pendingTransfers.length === 0, "yan to know it arrived");
	}, 240_000);

	it("with machines that say they are where nothing listens, names the address and says so, and still shows what is running there", async () => {
		const address = await stack.address();
		await shop(stack);
		// Each machine gives the server an address that is not its own: the server's, where nothing listens on that port.
		const yan = await join(stack, "yan", address, { LATTICE_ADVERTISE: "server" });
		await join(stack, "sam", address, { LATTICE_ADVERTISE: "server" });
		const { kid } = await tree(stack, yan);
		const seen = await shopState(stack, "sam", (state) => (state.sharing?.tried?.length ?? 0) > 0 && state.work?.sessions.some((session) => session.id === kid.id), "sam's host to have tried the address");
		expect(seen.sharing?.tried).toEqual([{ address: expect.stringMatching(/^server:\d+$/), why: expect.stringContaining("nothing is listening there") }]);
		// The sessions come from yan's machine, which is not reached; the server still says what runs there.
		expect(seen.nodes).toEqual([]);
		expect(seen.work?.sessions.find((session) => session.id === kid.id)).toMatchObject({ owner: "yan", name: "impl" });
	});

	it("with a machine gone half way through a handover, nothing moves until it is back, and then it does by itself", async () => {
		const address = await stack.address();
		await shop(stack);
		const yan = await join(stack, "yan", address);
		const sam = await join(stack, "sam", address);
		const { kid } = await tree(stack, yan);
		await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id), "yan's session to appear for sam");

		// Sam asks, and then sam's machine is off every network: the lid is closed.
		sam.start(`/lattice take ${kid.id}`);
		await sam.told("Asked yan");
		await shopState(stack, "yan", (state) => state.sharing?.requests.some((request) => request.from === "sam" && request.nodeId === kid.id), "sam's request to reach yan");
		await stack.unplug("sam");
		await shopState(stack, "yan", (state) => state.sharing?.people.some((each) => each.name === "sam" && !each.online), "yan to see that sam is away", 90_000);

		// Yan says yes anyway. There is nobody to send it to: it stays yan's.
		yan.start(`/lattice approve ${kid.id} sam`);
		await yan.answer("confirm", 'Hand "impl" to sam?', { confirmed: true });
		await new Promise((resolve) => setTimeout(resolve, 5000));
		expect((await stack.state("yan", SHOP))?.nodes.find((node) => node.id === kid.id)).toMatchObject({ owner: "yan" });

		// Sam is back, perhaps at another address. Nobody does anything more.
		await stack.plug("sam");
		const moved = await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam"), "the session to go to sam once sam is back", 150_000);
		expect(moved.nodes.find((node) => node.id === kid.id)).toMatchObject({ owner: "sam", version: 2 });
		await shopState(stack, "yan", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam"), "yan to see it is sam's");
	}, 300_000);

	it("with the server restarted, the team is as it was, and what goes through the server goes again", async () => {
		const address = await stack.address();
		await shop(stack);
		const yan = await join(stack, "yan", address);
		const sam = await join(stack, "sam", address);
		const { kid } = await tree(stack, yan);
		await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id), "yan's session to appear for sam");

		await stack.compose("restart", "--timeout", "2", "server");
		// It gives out the same address: the same team, and the same server by its certificate.
		expect(await stack.address()).toBe(address);
		await shopState(stack, "sam", (state) => state.work?.connected && state.work.people.some((each) => each.name === "yan" && each.online), "sam's host to be on the server again", 90_000);
		await shopState(stack, "yan", (state) => state.work?.connected && state.work.hosts.some((host) => host.owner === "sam"), "yan's host to be on the server again", 90_000);

		// A request goes through the server, so this says the server carries them again.
		sam.start(`/lattice take ${kid.id}`);
		await sam.told("Asked yan");
		await shopState(stack, "yan", (state) => state.sharing?.requests.some((request) => request.from === "sam" && request.nodeId === kid.id), "sam's request to reach yan through the restarted server", 60_000);
		yan.start(`/lattice approve ${kid.id} sam`);
		await yan.answer("confirm", 'Hand "impl" to sam?', { confirmed: true });
		await shopState(stack, "sam", (state) => state.nodes.some((node) => node.id === kid.id && node.owner === "sam"), "the session to go to sam");
	}, 300_000);

	it("with a line whose code is wrong, lets nobody in, and with the right one lets them in after all", async () => {
		const address = await stack.address();
		await shop(stack);
		await join(stack, "yan", address);
		const sam = person(await stack.pi("sam", SHOP));
		// The same server, by its certificate, and a code that is not the team's.
		const wrong = address.replace(/#[0-9a-f]{4}/, (start) => (start === "#0000" ? "#1111" : "#0000"));
		sam.start(`/lattice server ${wrong}`);
		await sam.answer("input", "The name your teammates will see you as", { value: "sam" });
		await sam.told("That is not this team's code.");
		expect((await stack.state("sam", SHOP))?.sharing ?? null).toBeNull();
		expect((await stack.state("yan", SHOP))?.work?.people.map((each) => each.name)).toEqual(["yan"]);

		sam.start(`/lattice server ${address}`);
		await sam.told("Joined https://server");
		await sam.told("Found yan");
	}, 120_000);
});
