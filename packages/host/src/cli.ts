#!/usr/bin/env node
/** `pi-lattice`: start a lattice host for a project. */
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CollabSession, GitSharedStore, Identity, TrustStore } from "@pi-lattice/collab";
import { parseArgs, USAGE } from "./args.ts";
import { LatticeHost } from "./host.ts";
import { runPlain } from "./plain.ts";
import { TreeApp } from "./ui/app.ts";

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
	const stateDir = options.stateDir ? resolve(options.stateDir) : join(cwd, ".lattice");
	const host = await LatticeHost.start({ stateDir, piArgs: options.piArgs, ...(options.as !== undefined ? { owner: options.as } : {}) });
	let collab: CollabSession | undefined;
	let stopping = false;
	const shutdown = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await collab?.stop().catch(() => {});
		await host.stop();
	};
	process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
	process.once("SIGTERM", () => void shutdown().then(() => process.exit(143)));
	try {
		if (options.share !== undefined) {
			collab = new CollabSession({
				host,
				identity: Identity.loadOrCreate(join(getAgentDir(), "lattice", "identity"), host.owner),
				trust: new TrustStore(join(stateDir, "collab", "trusted.json")),
				store: new GitSharedStore({ remote: options.share, dir: join(stateDir, "collab", "shared"), author: host.owner }),
				dir: join(stateDir, "collab"),
				projectDir: cwd,
			});
			await collab.start();
		}
		let root = host.nodes().find((node) => node.parentId === null);
		// Joining someone else's shared tree creates nothing: their sessions appear once trusted.
		const joining = options.share !== undefined && options.name === undefined;
		if (!root && !joining) {
			root = await host.createRoot({
				name: options.name ?? basename(cwd),
				cwd,
				fragments: options.fragments,
				...(options.kind !== undefined ? { kind: options.kind } : {}),
				...(options.brief !== undefined ? { brief: options.brief } : {}),
			});
			await collab?.sync();
		}
		if (options.plain || !process.stdout.isTTY || !process.stdin.isTTY) {
			await runPlain(host, root?.id, process.stdin, process.stdout, collab);
		} else {
			const app = new TreeApp({ host, rootId: root?.id, ...(collab ? { collab } : {}) });
			app.start();
			await app.done;
		}
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
