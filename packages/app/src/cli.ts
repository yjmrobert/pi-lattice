#!/usr/bin/env node
/** `pi-lattice`: the lattice host, as a background daemon or with a line-based interface. */
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { latticeHome } from "@pi-lattice/protocol";
import { parseArgs, USAGE } from "./args.ts";
import { runBoard } from "./board.ts";
import { runDaemon } from "./daemon.ts";
import { formatAddress, loadOrCreateCertificate, WorkServer } from "@pi-lattice/server";
import { runPlain } from "./plain.ts";
import { workCommand } from "./workcli.ts";

async function main(): Promise<number> {
	// The team's work from a shell, for agents that are not Pi sessions: it starts nothing and has its own options.
	if (process.argv[2] === "work") {
		return workCommand(process.argv.slice(3), {
			home: latticeHome(process.env, homedir()),
			cwd: process.cwd(),
			env: process.env,
			out: (text) => void process.stdout.write(text),
			err: (text) => void process.stderr.write(`${text}\n`),
			stdin: async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
				return Buffer.concat(chunks).toString("utf8");
			},
		});
	}
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
	if (options.command === "server" && options.board) {
		// Started by a host, for its person. Not shared, it stops once no host has asked anything for a while.
		await runBoard(latticeHome(process.env, homedir()), { shared: options.shared, idleMs: (options.idleExit ?? 600) * 1000 });
		return 0;
	}
	if (options.command === "server") {
		const home = latticeHome(process.env, homedir());
		const data = resolve(options.data ?? join(home, "server", "work.db"));
		// It encrypts by itself, with a certificate kept beside the work. An http:// address for teammates
		// says something in front of it does the encrypting, and it then speaks plain HTTP as before.
		const fronted = options.url?.startsWith("http://") === true;
		const server = new WorkServer({ file: data, port: options.port ?? 7420, ...(fronted ? {} : { tls: loadOrCreateCertificate(dirname(data)) }) });
		const port = await server.start();
		const url = options.url ?? `https://${hostname()}:${port}`;
		process.stdout.write(
			`The server is running. Teammates join with:\n\n  /lattice server ${formatAddress(url, server.tracker.code, server.pin)}\n\nAnyone with that address can read and change everything on it. ${
				fronted
					? "It speaks plain HTTP: put it behind TLS before it leaves a network you trust."
					: "Connections to it are encrypted, and the address says which server it is: pass on all of it, over a channel the team already trusts."
			}\n`,
		);
		await new Promise<void>((done) => {
			for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done());
		});
		await server.stop();
		return 0;
	}
	const cwd = resolve(options.cwd);
	const daemon = await runDaemon({
		stateDir: options.stateDir ? resolve(options.stateDir) : join(cwd, ".lattice"),
		cwd,
		...(options.piArgs.length > 0 ? { piArgs: options.piArgs } : {}),
		...(options.as !== undefined ? { owner: options.as } : {}),
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
		if (!root) {
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
