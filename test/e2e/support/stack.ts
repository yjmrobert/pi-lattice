/**
 * A team's server and two people's machines, as containers (compose.yml), and what a test does
 * with them: run a command on a machine, open a Pi there, ask a host there what it knows, and
 * take a machine off a network.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { UiApi, UiMethod, UiState } from "@pi-lattice/protocol";
import { eventually, PiChild, repoRoot } from "../../support/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const composeFile = join(here, "..", "compose.yml");
const shim = join(here, "docker-pi.mjs");
/** Where a failed test leaves what the machines said, for whoever reads the failure. */
export const logsDir = join(here, "..", ".build", "logs");

/** A person's home on their machine, and where a host keeps a repository's tree. */
export const HOME = "/home/node";
export const stateOf = (checkout: string): string => `${checkout}/.lattice`;

export type Machine = "server" | "yan" | "sam";

const run = (command: string, args: string[], input?: string): Promise<string> =>
	new Promise((done, failed) => {
		const child = execFile(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error ? failed(new Error(`${command} ${args.join(" ")}\n${stderr || error.message}`)) : done(stdout)));
		if (input !== undefined) child.stdin?.end(input);
	});

export class Stack {
	readonly project: string;
	private readonly pis: PiChild[] = [];

	private constructor(project: string) {
		this.project = project;
	}

	/** Start the server and both machines, each new: nothing is kept from one test to the next. */
	static async up(): Promise<Stack> {
		const stack = new Stack(`lattice-e2e-${randomBytes(4).toString("hex")}`);
		await stack.compose("up", "--detach", "--wait");
		// The scripted model reports to its parent only when a test says so, so the reminder a quiet
		// child gets would add turns to every test (as in the tests on one machine).
		for (const machine of ["yan", "sam"] as const) {
			await stack.sh(machine, `mkdir -p ${HOME}/.pi/agent/lattice && echo '{"reports":{"remind":false}}' > ${HOME}/.pi/agent/lattice/config.json`);
		}
		return stack;
	}

	compose(...args: string[]): Promise<string> {
		return run("docker", ["compose", "--project-name", this.project, "--file", composeFile, ...args]);
	}

	container(machine: Machine): string {
		return `${this.project}-${machine}-1`;
	}

	/** Run a program on a machine and give what it printed. */
	exec(machine: Machine, command: string[], options: { cwd?: string } = {}): Promise<string> {
		return run("docker", ["exec", ...(options.cwd ? ["--workdir", options.cwd] : []), this.container(machine), ...command]);
	}

	/** Run a line of shell on a machine. */
	async sh(machine: Machine, script: string, cwd?: string): Promise<string> {
		return (await this.exec(machine, ["bash", "-ec", script], cwd ? { cwd } : {})).trim();
	}

	/** The line the server prints for teammates to join with: its address, the team's code, and which server it is. */
	async address(): Promise<string> {
		return eventually(async () => /\/lattice server (\S+)/.exec(await this.compose("logs", "--no-log-prefix", "server"))?.[1], "the server to print its address", 30_000);
	}

	/** Open Pi on a machine, in a directory there, and drive it as its RPC client. */
	async pi(machine: Machine, cwd: string, env: Record<string, string> = {}): Promise<PiChild> {
		const client = new RpcClient({
			cliPath: shim,
			cwd: repoRoot,
			provider: "lattice-faux",
			model: "scripted",
			env: { E2E_CONTAINER: this.container(machine), E2E_CWD: cwd, E2E_ENV: JSON.stringify(env) },
			args: ["-e", "/repo/test/support/faux-provider.ts", "--no-skills", "--no-context-files"],
		});
		const child = new PiChild(machine, client);
		this.pis.push(child);
		await client.start();
		return child;
	}

	/** Ask the host of a checkout on a machine something, as that person's terminal would. Undefined when no host runs there. */
	async ui<K extends UiMethod>(machine: Machine, checkout: string, method: K, params: UiApi[K]["params"]): Promise<UiApi[K]["result"] | undefined> {
		const out = await this.exec(machine, ["node", "--disable-warning=ExperimentalWarning", "/repo/test/e2e/support/probe.ts", stateOf(checkout), method, JSON.stringify(params)]);
		const answer = JSON.parse(out) as UiApi[K]["result"] | { error: string } | null;
		if (answer === null) return undefined;
		if (typeof answer === "object" && "error" in answer) throw new Error(`${machine}: ${String(answer.error)}`);
		return answer;
	}

	/** What the host of a checkout on a machine knows. Undefined when no host runs there. */
	state(machine: Machine, checkout: string): Promise<UiState | undefined> {
		return this.ui(machine, checkout, "state", {});
	}

	/** The networks a machine is on besides the one everyone is on: its own link to the server. */
	private linkOf(machine: Machine): string[] {
		return machine === "server" ? ["yan-link", "sam-link"] : [`${machine}-link`];
	}

	/**
	 * Take a machine off a network, as a cable pulled or a laptop closed: nothing is told to anyone.
	 * Off `mesh` it still reaches the server by its own link; off `everything` it reaches nobody.
	 */
	async unplug(machine: Machine, from: "mesh" | "everything" = "everything"): Promise<void> {
		for (const network of from === "mesh" ? ["mesh"] : ["mesh", ...this.linkOf(machine)]) {
			await run("docker", ["network", "disconnect", `${this.project}_${network}`, this.container(machine)]).catch(() => {});
		}
	}

	/** Put a machine back on a network it was taken off. It may be given another address there, as a laptop is. */
	async plug(machine: Machine, to: "mesh" | "everything" = "everything"): Promise<void> {
		for (const network of to === "mesh" ? ["mesh"] : ["mesh", ...this.linkOf(machine)]) {
			await run("docker", ["network", "connect", "--alias", machine, `${this.project}_${network}`, this.container(machine)]).catch(() => {});
		}
	}

	/** Keep what every machine said and what each host logged, under a name, for reading after a failure. */
	async keepLogs(name: string): Promise<string> {
		const dir = join(logsDir, name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "compose.log"), await this.compose("logs", "--timestamps").catch((error: Error) => error.message));
		for (const machine of ["yan", "sam"] as const) {
			const hosts = await this.sh(machine, `for f in $(find ${HOME} -name 'daemon.*' -path '*.lattice*' 2>/dev/null); do echo "== $f"; cat "$f"; done; echo "== processes"; (ps -eo pid,etime,args 2>/dev/null || echo "no ps on this machine") | cut -c1-200`).catch((error: Error) => error.message);
			writeFileSync(join(dir, `${machine}.log`), `${hosts}\n`);
		}
		for (const pi of this.pis) writeFileSync(join(dir, `${pi.name}.pi.log`), `${pi.notifications().map((text) => `told: ${text}`).join("\n")}\n\nstderr:\n${pi.client.getStderr()}\n`);
		return dir;
	}

	/** Stop everything and remove it, the volume with it. */
	async down(): Promise<void> {
		for (const pi of this.pis) await pi.stop().catch(() => {});
		await this.compose("down", "--volumes", "--timeout", "2").catch(() => {});
	}
}
