import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkServer } from "../../server/src/index.ts";
import { joinAndSave, Work } from "../src/work.ts";

let server: WorkServer | undefined;
let work: Work | undefined;
let home: string | undefined;
afterEach(async () => {
	work?.stop();
	await server?.stop();
	if (home) rmSync(home, { recursive: true, force: true });
	server = work = home = undefined;
});

const eventually = async <T>(probe: () => T | undefined | false, what: string): Promise<T> => {
	for (const end = Date.now() + 10_000; ; ) {
		const value = probe();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

describe("a host on a server", () => {
	it("says where it is now when the machine has moved to another network, without waiting for the next beat", async () => {
		server = new WorkServer({ file: ":memory:", host: "127.0.0.1" });
		const address = `http://127.0.0.1:${await server.start()}/#${server.tracker.code}`;
		home = mkdtempSync(join(tmpdir(), "pi-lattice-work-"));
		await joinAndSave(home, address, "yan");
		// A beat so long that nothing here is said again because of it.
		work = new Work({ home, hostId: "laptop:shop", repo: "shop", name: () => "yan", beatMs: 3_600_000 });
		work.sync();
		let addresses = ["192.168.1.20:4100"];
		work.setPeering({ scope: "git:shop", addresses: () => addresses, key: "yans-key", heard: () => {} });
		const said = (): string[] | undefined => work?.state()?.hosts.find((host) => host.owner === "yan")?.addresses;
		await eventually(() => said()?.join() === "192.168.1.20:4100", "the server to know where the host is");

		// The laptop joins a VPN: it has an address more. The host's timer brings it in line.
		addresses = ["192.168.1.20:4100", "10.8.0.6:4100"];
		work.sync();
		await eventually(() => said()?.length === 2, "the server to know the new address");
		expect(said()).toEqual(["192.168.1.20:4100", "10.8.0.6:4100"]);
	});
});
