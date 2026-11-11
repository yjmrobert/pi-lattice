/** Command-line parsing for `pi-lattice`. Pure, so it can be tested without starting anything. */

export interface CliOptions {
	/** `daemon`: the background host a person's Pi talks to. `plain`: a line-based interface, for scripting. */
	command: "plain" | "daemon";
	cwd: string;
	stateDir: string | undefined;
	name: string | undefined;
	kind: string | undefined;
	fragments: string[];
	brief: string | undefined;
	/** `[host:]port` to accept connections from paired people on. Turns sharing on. */
	listen: string | undefined;
	/** Host name or address other people should use to reach this machine. */
	advertise: string | undefined;
	/** Invites from people to pair with. */
	peers: string[];
	/** The name this person acts as: owner of the nodes created here. */
	as: string | undefined;
	/** Daemon only: seconds without a terminal or work before exiting. 0 never exits. */
	idleExit: number | undefined;
	help: boolean;
	/** Everything after `--`, passed to every Pi session (for example `--model ...`). */
	piArgs: string[];
}

export const USAGE = `Usage: pi-lattice [daemon] [options] [-- <pi arguments>]

Most people never run this directly: install the pi-lattice package into Pi, open
pi in a project and run /lattice. Pi starts the host in the background as needed.

  pi-lattice daemon   Run the background host for a project in the foreground.
  pi-lattice          A line-based interface to a host, for scripting and debugging.

Options:
  --cwd <dir>        Project directory (default: current directory)
  --state <dir>      Where the host keeps its tree and sessions (default: <cwd>/.lattice)
  --as <name>        The name you act as (default: your OS user name)
  --listen [host:]port  Share this tree, peer to peer: accept paired people on this port
  --peer <invite>    Pair with someone by their invite (repeatable); implies sharing
  --advertise <host> Address others should use to reach you (default: first network address)
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
		command: "plain", cwd, stateDir: undefined, name: undefined, kind: undefined, fragments: [], brief: undefined,
		listen: undefined, advertise: undefined, peers: [], as: undefined, idleExit: undefined, help: false, piArgs: [],
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
		if (i === 0 && arg === "daemon") options.command = "daemon";
		else if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "--plain") options.command = "plain";
		else if (arg === "--cwd") options.cwd = value(arg, i++);
		else if (arg === "--state") options.stateDir = value(arg, i++);
		else if (arg === "--name") options.name = value(arg, i++);
		else if (arg === "--kind") options.kind = value(arg, i++);
		else if (arg === "--brief") options.brief = value(arg, i++);
		else if (arg === "--listen") options.listen = value(arg, i++);
		else if (arg === "--advertise") options.advertise = value(arg, i++);
		else if (arg === "--peer") options.peers.push(value(arg, i++));
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
