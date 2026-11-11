/**
 * Run the real Pi, in its real terminal interface, inside a pseudo-terminal, and read the
 * screen the way a person would see it. This is the only way the parts of the pane that hook
 * into Pi's own layout and keyboard get exercised: RPC mode has no terminal interface at all.
 *
 * The pseudo-terminal comes from `script` (util-linux), and the screen from a headless
 * terminal emulator fed with everything Pi writes.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { Terminal } from "@xterm/headless";
import { directorScript, extensionPaths, piCli, type Sandbox } from "./harness.ts";

/** Whether this machine can give a process a pseudo-terminal the way the harness needs. */
export const canRunTui = process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

/** Keys as a terminal sends them. */
export const KEY = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	backspace: "\x7f",
	altL: "\x1bl",
	ctrlC: "\x03",
} as const;

const quote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

export interface TuiOptions {
	extensions?: string[];
	env?: Record<string, string>;
	args?: string[];
	cwd?: string;
	cols?: number;
	rows?: number;
}

export class PiTui {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly terminal: Terminal;
	private pending: Promise<void> = Promise.resolve();
	private raw = "";

	private constructor(child: ChildProcessWithoutNullStreams, terminal: Terminal) {
		this.child = child;
		this.terminal = terminal;
		child.stdout.on("data", (data: Buffer) => {
			this.raw += data.toString("utf8");
			this.pending = this.pending.then(() => new Promise<void>((resolve) => terminal.write(data, resolve)));
		});
		// A terminal answers the questions a program asks it (which keys it supports, where the cursor is).
		terminal.onData((answer) => child.stdin.write(answer));
	}

	static start(sandbox: Sandbox, options: TuiOptions = {}): PiTui {
		const cols = options.cols ?? 120;
		const rows = options.rows ?? 36;
		const extensions = [extensionPaths.faux, ...(options.extensions ?? [])];
		const command = [
			process.execPath, piCli,
			...extensions.flatMap((path) => ["-e", path]),
			"--provider", "lattice-faux", "--model", "scripted", "--session-dir", sandbox.sessions, "--no-skills", "--no-context-files", "--approve",
			...(options.args ?? []),
		].map(quote).join(" ");
		const child = spawn("script", ["-qfec", `stty cols ${cols} rows ${rows}; exec ${command}`, "/dev/null"], {
			cwd: options.cwd ?? sandbox.work,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: sandbox.root,
				TERM: "xterm-256color",
				LANG: "C.UTF-8",
				PI_CODING_AGENT_DIR: sandbox.agentDir,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
				LATTICE_HOME: sandbox.home,
				LATTICE_OWNER: "tester",
				LATTICE_FAUX_SCRIPT: directorScript,
				...options.env,
			},
		});
		return new PiTui(child, new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 }));
	}

	/** The screen as rows of text, without colour. */
	async screen(): Promise<string[]> {
		await this.pending;
		const buffer = this.terminal.buffer.active;
		return Array.from({ length: this.terminal.rows }, (_unused, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
	}

	/** Press keys, or type text. */
	press(...keys: string[]): void {
		for (const key of keys) this.child.stdin.write(key);
	}

	/** Type a line into Pi's editor and send it. */
	async submit(text: string): Promise<void> {
		this.press(text);
		// Pi tells typing from pasting by how fast it arrives; give the text a moment before enter.
		await new Promise((resolve) => setTimeout(resolve, 80));
		this.press(KEY.enter);
	}

	/** Wait until the screen satisfies a probe, and return it. On timeout the error shows the screen. */
	async waitFor(probe: (screen: string, rows: string[]) => unknown, what: string, timeoutMs = 15_000): Promise<string[]> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const rows = await this.screen();
			if (probe(rows.join("\n"), rows)) return rows;
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}. The screen was:\n${rows.map((row) => `  |${row}`).join("\n")}`);
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
	}

	/** Wait for text to appear anywhere on the screen. */
	see(text: string | RegExp, timeoutMs?: number): Promise<string[]> {
		return this.waitFor((screen) => (typeof text === "string" ? screen.includes(text) : text.test(screen)), `"${text}" on the screen`, timeoutMs);
	}

	async stop(): Promise<void> {
		if (this.child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.kill("SIGTERM");
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(timer);
		this.terminal.dispose();
	}
}
