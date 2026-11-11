/** Command-line parsing for `pi-lattice`. Pure, so it can be tested without starting anything. */

export interface CliOptions {
	cwd: string;
	stateDir: string | undefined;
	name: string | undefined;
	kind: string | undefined;
	fragments: string[];
	brief: string | undefined;
	plain: boolean;
	/** `[host:]port` to accept connections from paired people on. Turns sharing on. */
	listen: string | undefined;
	/** Host name or address other people should use to reach this machine. */
	advertise: string | undefined;
	/** Invites from people to pair with. */
	peers: string[];
	/** The name this person acts as: owner of the nodes created here. */
	as: string | undefined;
	help: boolean;
	/** Everything after `--`, passed to every Pi session (for example `--model ...`). */
	piArgs: string[];
}

export const USAGE = `Usage: pi-lattice [options] [-- <pi arguments>]

Runs a lattice host for a project: a tree of Pi sessions you can enter at any node.

Options:
  --cwd <dir>        Project directory (default: current directory)
  --state <dir>      Where the host keeps its tree and sessions (default: <cwd>/.lattice)
  --name <name>      Name for the root session, when the tree is empty
  --kind <kind>      Free-form kind for the root session (default: feature)
  --role <a,b,...>   Role fragments for the root session, in order
  --brief <text>     First prompt for the root session
  --plain            Line-based interface instead of the full-screen tree
  --listen [host:]port  Share this tree, peer to peer: accept paired people on this port
  --peer <invite>    Pair with someone by their invite (repeatable); implies sharing
  --advertise <host> Address others should use to reach you (default: first network address)
  --as <name>        The name you act as (default: your OS user name)
  -h, --help         Show this help

Arguments after -- are passed to every Pi session, for example:
  pi-lattice --role coordinator -- --model sonnet

Sharing is direct between the two machines; there is no server. To join someone's
tree, pass their invite with --peer and no --name: no root is created, and their
sessions appear once they have paired with you too.
`;

export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
	const options: CliOptions = {
		cwd, stateDir: undefined, name: undefined, kind: undefined, fragments: [], brief: undefined, plain: false, listen: undefined, advertise: undefined, peers: [], as: undefined, help: false, piArgs: [],
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
		if (arg === "-h" || arg === "--help") options.help = true;
		else if (arg === "--plain") options.plain = true;
		else if (arg === "--cwd") options.cwd = value(arg, i++);
		else if (arg === "--state") options.stateDir = value(arg, i++);
		else if (arg === "--name") options.name = value(arg, i++);
		else if (arg === "--kind") options.kind = value(arg, i++);
		else if (arg === "--brief") options.brief = value(arg, i++);
		else if (arg === "--listen") options.listen = value(arg, i++);
		else if (arg === "--advertise") options.advertise = value(arg, i++);
		else if (arg === "--peer") options.peers.push(value(arg, i++));
		else if (arg === "--as") options.as = value(arg, i++);
		else if (arg === "--role" || arg === "--roles") {
			options.fragments.push(...value(arg, i++).split(/[,+]/).map((name) => name.trim()).filter(Boolean));
		} else throw new Error(`Unknown option ${arg}`);
	}
	return options;
}
