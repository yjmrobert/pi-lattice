#!/usr/bin/env node
/** `pi-lattice`: the lattice host, as a background daemon or with a line-based interface. */
import { basename, join, resolve } from "node:path";
import { parseArgs, USAGE } from "./args.ts";
import { runDaemon } from "./daemon.ts";
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
