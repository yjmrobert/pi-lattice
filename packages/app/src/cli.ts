#!/usr/bin/env node
/** `pi-lattice`: the lattice host, as a background daemon or with a line-based interface. */
import { homedir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { formatJoinCode, localHosts } from "@pi-lattice/collab";
import { latticeHome } from "@pi-lattice/protocol";
import { parseArgs, USAGE } from "./args.ts";
import { chooseName, chosenName, joinNetwork, runDaemon, startNetwork } from "./daemon.ts";
import { runPlain } from "./plain.ts";

async function main(): Promise<number> {
	let options: ReturnType<typeof parseArgs>;
	try {
		options = parseArgs(process.argv.slice(2), process.cwd());
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (options.command === "join" || options.command === "create") {
		// Nothing to start: every repository's host follows the network file, now or when it next runs.
		const home = latticeHome(process.env, homedir());
		const had = chosenName(home);
		if (options.as !== undefined && options.as !== had) chooseName(home, options.as);
		const me = chosenName(home) ?? userInfo().username;
		if (options.command === "join") {
			const network = joinNetwork(home, options.subject as string);
			process.stdout.write(`You are in ${network.name} as ${me}. Open pi in a project: your teammates' sessions are in the pane.\n`);
		} else {
			const network = startNetwork(home, options.subject ?? "team");
			process.stdout.write(`Created ${network.name}; you are ${me}. Teammates join with:\n\n  pi-lattice join ${formatJoinCode(network, localHosts())}\n\nWhoever has the code is in, so send it over a channel you trust.\n`);
		}
		return 0;
	}
	const cwd = resolve(options.cwd);
	const daemon = await runDaemon({
		stateDir: options.stateDir ? resolve(options.stateDir) : join(cwd, ".lattice"),
		cwd,
		...(options.piArgs.length > 0 ? { piArgs: options.piArgs } : {}),
		...(options.as !== undefined ? { owner: options.as } : {}),
		...(options.join !== undefined ? { join: options.join } : {}),
		...(options.advertise !== undefined ? { advertise: options.advertise } : {}),
		// With the line interface a person is present for as long as the process runs.
		idleExitMs: options.command === "daemon" ? (options.idleExit ?? 600) * 1000 : 0,
	});
	process.once("SIGINT", () => void daemon.stop().then(() => process.exit(130)));
	process.once("SIGTERM", () => void daemon.stop().then(() => process.exit(143)));
	try {
		if (options.command === "daemon") {
			await daemon.done;
			return 0;
		}
		const host = daemon.host;
		let root = host.nodes().find((node) => node.parentId === null);
		// Joining a network creates nothing: the teammates' sessions appear once their hosts are found.
		const joining = options.join !== undefined && options.name === undefined;
		if (!root && !joining) {
			root = await host.createRoot({
				name: options.name ?? basename(cwd),
				cwd,
				fragments: options.fragments,
				...(options.kind !== undefined ? { kind: options.kind } : {}),
				...(options.brief !== undefined ? { brief: options.brief } : {}),
			});
		}
		await runPlain(host, root?.id, process.stdin, process.stdout);
		return 0;
	} finally {
		await daemon.stop();
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`pi-lattice: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
