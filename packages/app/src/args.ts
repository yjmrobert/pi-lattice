/** Command-line parsing for `pi-lattice`. Pure, so it can be tested without starting anything. */

export interface CliOptions {
	/** `daemon`: the background host a person's Pi talks to. `plain`: a line-based interface, for scripting. */
	command: "plain" | "daemon" | "join" | "create" | "server";
	/** `join`: the code. `create`: the network's name. */
	subject: string | undefined;
	cwd: string;
	stateDir: string | undefined;
	name: string | undefined;
	kind: string | undefined;
	fragments: string[];
	brief: string | undefined;
	/** A join code: become a member of that network before starting. */
	join: string | undefined;
	/** Host name or address teammates should use to reach this machine. */
	advertise: string | undefined;
	/** The name this person acts as: owner of the nodes created here. */
	as: string | undefined;
	/** Daemon only: seconds without a terminal or work before exiting. 0 never exits. */
	idleExit: number | undefined;
	help: boolean;
	/** `server`: the port to listen on. */
	port: number | undefined;
	/** `server`: the file its work is kept in. */
	data: string | undefined;
	/** `server`: the address teammates reach it at, when that is not this machine's name and port. */
	url: string | undefined;
	/** `server`: be the board on this machine, which a host starts for its person. */
	board: boolean;
	/** `server --board`: let other machines reach it. */
	shared: boolean;
	/** Everything after `--`, passed to every Pi session (for example `--model ...`). */
	piArgs: string[];
}

export const USAGE = `Usage: pi-lattice [daemon] [options] [-- <pi arguments>]

Most people never run this directly: install the pi-lattice package into Pi, open
pi in a project and run /lattice. Pi starts the host in the background as needed.

  pi-lattice join <code>    Join a teammate's network, once for every project on this machine.
  pi-lattice create [name]  Start a network and print the code teammates join with.
                            Both take --as <name>: the name your teammates see you as.
  pi-lattice server   Run a team's server: one always-on place for its work. Prints the address
                      teammates join with. Takes --port (default 7420), --data <file> (default
                      <lattice home>/server/work.db) and --url <address teammates reach it at>.
                      For a machine that is always on. To keep the work on your own machine
                      instead, there is nothing to run: /lattice server start, in pi.
  pi-lattice daemon   Run the background host for a project in the foreground.
  pi-lattice          A line-based interface to a host, for scripting and debugging.

Options:
  --cwd <dir>        Project directory (default: current directory)
  --state <dir>      Where the host keeps its tree and sessions (default: <cwd>/.lattice)
  --as <name>        The name you act as (default: the one you chose, or your OS user name)
  --join <code>      Join a network with the code a teammate gave you
  --advertise <host> Address teammates should use to reach you (default: every network address)
  --idle-exit <sec>  daemon: exit after this long with nobody connected (default 600, 0 = never)
  -h, --help         Show this help

Line interface only:
  --name <name>      Name for the root session, when the tree is empty
  --kind <kind>      Free-form kind for the root session (default: feature)
  --role <a,b,...>   Role fragments for the root session, in order
  --brief <text>     First prompt for the root session

Arguments after -- are passed to every Pi session, for example -- --model sonnet.
`;

export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
	const options: CliOptions = {
		command: "plain", subject: undefined, cwd, stateDir: undefined, name: undefined, kind: undefined, fragments: [], brief: undefined,
		join: undefined, advertise: undefined, as: undefined, idleExit: undefined, help: false, port: undefined, data: undefined, url: undefined, board: false, shared: false, piArgs: [],
	};
	const value = (flag: string, index: number): string => {
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
		return next;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--") {
			options.piArgs = argv.slice(i + 1);
			break;
		}
		if (i === 0 && (arg === "daemon" || arg === "server")) options.command = arg;
		else if (arg === "--port") {
			const port = Number(value(arg, i++));
			if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port needs a port number");
			options.port = port;
		} else if (arg === "--data") options.data = value(arg, i++);
		else if (arg === "--url") options.url = value(arg, i++);
		else if (arg === "--board") options.board = true;
		else if (arg === "--shared") options.shared = true;
		else if (i === 0 && (arg === "join" || arg === "create")) {
			options.command = arg;
			const next = argv[1];
			if (next !== undefined && !next.startsWith("-")) {
				options.subject = next;
				i++;
			} else if (arg === "join") throw new Error("join needs the code a teammate gave you");
		}
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "--plain") options.command = "plain";
		else if (arg === "--cwd") options.cwd = value(arg, i++);
		else if (arg === "--state") options.stateDir = value(arg, i++);
		else if (arg === "--name") options.name = value(arg, i++);
		else if (arg === "--kind") options.kind = value(arg, i++);
		else if (arg === "--brief") options.brief = value(arg, i++);
		else if (arg === "--join") options.join = value(arg, i++);
		else if (arg === "--advertise") options.advertise = value(arg, i++);
		else if (arg === "--as") options.as = value(arg, i++);
		else if (arg === "--idle-exit") {
			const seconds = Number(value(arg, i++));
			if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--idle-exit needs a number of seconds");
			options.idleExit = seconds;
		} else if (arg === "--role" || arg === "--roles") {
			options.fragments.push(...value(arg, i++).split(/[,+]/).map((name) => name.trim()).filter(Boolean));
		} else throw new Error(`Unknown option ${arg}`);
	}
	return options;
}
