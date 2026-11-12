/**
 * A board on this machine: the same server a team runs, started by the person's own host with
 * nothing to deploy. It keeps its work in the lattice home, listens only to this machine until
 * it is shared, and is one process for every repository's host. Nobody is in charge of it: a
 * host that finds it gone starts it, and the port decides which of two started at once stays.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { WorkServer } from "@pi-lattice/server";

/** The first port tried. A team's server defaults to the one below, so both can run on one machine. */
export const BOARD_PORT = 7421;
const PORTS = 20;

export interface Board {
	port: number;
	pid: number;
	/** The code that lets someone join. Whoever can read this file is the person the board belongs to. */
	code: string;
	/** Whether other machines can reach it. */
	shared: boolean;
}

const dir = (home: string): string => join(home, "board");
const file = (home: string): string => join(dir(home), "board.json");

/** What the board last wrote about itself. It may no longer be running. */
export function readBoard(home: string): Board | undefined {
	try {
		const value = JSON.parse(readFileSync(file(home), "utf8")) as Partial<Board>;
		return typeof value.port === "number" && typeof value.pid === "number" && typeof value.code === "string" ? { port: value.port, pid: value.pid, code: value.code, shared: value.shared === true } : undefined;
	} catch {
		return undefined;
	}
}

/** The process answering on a port, when it is a lattice server. */
async function answering(port: number): Promise<number | undefined> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
		const value = (await response.json()) as { service?: string; pid?: number };
		return value.service === "pi-lattice" && typeof value.pid === "number" ? value.pid : undefined;
	} catch {
		return undefined;
	}
}

/** The board, when it is running: the file names a process, and that process answers on its port. */
export async function liveBoard(home: string): Promise<Board | undefined> {
	const board = readBoard(home);
	return board && (await answering(board.port)) === board.pid ? board : undefined;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Be the board: the body of `pi-lattice server --board`. Returns when it should exit: at once
 * when another process already is the board, on a signal, or, while it is not shared, when no
 * host has asked anything for `idleMs`.
 */
export async function runBoard(home: string, options: { shared: boolean; idleMs: number }): Promise<void> {
	mkdirSync(dir(home), { recursive: true });
	const before = readBoard(home);
	// The port it had before comes first: hosts that joined it remember that address.
	const ports = [...new Set([...(before ? [before.port] : []), ...Array.from({ length: PORTS }, (_, index) => BOARD_PORT + index)])];
	let server: WorkServer | undefined;
	let port = 0;
	for (const candidate of ports) {
		const attempt = new WorkServer({ file: join(dir(home), "work.db"), port: candidate, ...(options.shared ? {} : { host: "127.0.0.1" }), info: { pid: process.pid } });
		try {
			port = await attempt.start();
			server = attempt;
			break;
		} catch (error) {
			await attempt.stop().catch(() => {});
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Taken by this person's board, started a moment ago by another host: that one stays.
			await pause(300);
			if (await liveBoard(home)) return;
		}
	}
	if (!server) throw new Error(`No port from ${BOARD_PORT} to ${BOARD_PORT + PORTS - 1} is free for the board.`);
	writeFileSync(file(home), `${JSON.stringify({ port, pid: process.pid, code: server.tracker.code, shared: options.shared } satisfies Board, null, 2)}\n`, { mode: 0o600 });
	await new Promise<void>((done) => {
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done());
		if (!options.shared && options.idleMs > 0) {
			const quiet = setInterval(() => {
				if ((server as WorkServer).quietMs >= options.idleMs) {
					clearInterval(quiet);
					done();
				}
			}, Math.min(options.idleMs, 10_000));
		}
	});
	await server.stop();
}

/** Make sure the board runs, starting it when it does not. `spawn` starts `pi-lattice server --board` with the arguments given, detached. */
export async function ensureBoard(home: string, spawn: (args: string[]) => void, shared?: boolean): Promise<Board> {
	const running = await liveBoard(home);
	if (running) return running;
	spawn(["server", "--board", ...((shared ?? readBoard(home)?.shared) ? ["--shared"] : [])]);
	for (let waited = 0; waited < 15_000; waited += 100) {
		await pause(100);
		const board = await liveBoard(home);
		if (board) return board;
	}
	throw new Error(`The board on this machine did not start. Its log is ${join(dir(home), "board.log")}.`);
}

/** Stop the board, when it runs. The work stays in its file. */
export async function stopBoard(home: string): Promise<void> {
	const board = await liveBoard(home);
	if (!board) return;
	try {
		process.kill(board.pid, "SIGTERM");
	} catch {
		// Gone between the asking and the stopping.
	}
	for (let waited = 0; waited < 10_000 && (await answering(board.port)) === board.pid; waited += 100) await pause(100);
}

/** Start it again, open to other machines or closed to them. */
export async function shareBoard(home: string, spawn: (args: string[]) => void, shared: boolean): Promise<Board> {
	const board = await liveBoard(home);
	if (board && board.shared === shared) return board;
	await stopBoard(home);
	return ensureBoard(home, spawn, shared);
}

/** The addresses other machines may reach this one at: one for each network it is on. */
export function boardAddresses(board: Board): string[] {
	const hosts = Object.values(networkInterfaces())
		.flat()
		.filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")
		.map((entry) => (entry as { address: string }).address);
	return [...new Set(hosts)].map((host) => `http://${host}:${board.port}/#${board.code}`);
}
