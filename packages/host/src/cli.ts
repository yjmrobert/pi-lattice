#!/usr/bin/env node
/** `pi-lattice`: start a lattice host for a project. */
import { basename, join, resolve } from "node:path";
import { parseArgs, USAGE } from "./args.ts";
import { LatticeHost } from "./host.ts";
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
	const host = await LatticeHost.start({ stateDir: options.stateDir ? resolve(options.stateDir) : join(cwd, ".lattice"), piArgs: options.piArgs });
	let stopping = false;
	const shutdown = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await host.stop();
	};
	process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
	process.once("SIGTERM", () => void shutdown().then(() => process.exit(143)));
	try {
		const existing = host.nodes().find((node) => node.parentId === null);
		const root =
			existing ??
			(await host.createRoot({
				name: options.name ?? basename(cwd),
				cwd,
				fragments: options.fragments,
				...(options.kind !== undefined ? { kind: options.kind } : {}),
				...(options.brief !== undefined ? { brief: options.brief } : {}),
			}));
		await runPlain(host, root.id, process.stdin, process.stdout);
		return 0;
	} finally {
		await shutdown();
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`pi-lattice: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
