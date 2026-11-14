/**
 * `pi-lattice work`: the team's work from a shell, for agents that are not Pi sessions and for
 * scripts. It talks to the server the person has joined, as that person, and says which agent
 * is asking. There is nothing here for a person to edit issues with: a person says what they
 * want in Pi, on the tree.
 */
import { repoName } from "@pi-lattice/host";
import { directionsFor, formatWork, type Issue, type IssueChange, issueLine, type Place } from "@pi-lattice/protocol";
import { WorkClient } from "@pi-lattice/server";
import { readAccount } from "./work.ts";

export interface WorkIo {
	/** The person's lattice home: where `server.json` says which server they are on. */
	home: string;
	cwd: string;
	env: Record<string, string | undefined>;
	out(text: string): void;
	err(text: string): void;
	/** Everything on standard input, for `--body -`. */
	stdin?: () => Promise<string>;
}

export const WORK_USAGE = `Usage: pi-lattice work [command] [options]

The team's work, for an agent that is not a Pi session. It acts as the person who
joined the server on this machine, and records which agent did what.

  pi-lattice work                    the work that is not finished, as a tree
  pi-lattice work next               take the next issue that is ready, and print its brief
  pi-lattice work show <n>           one issue: what it is, what was said and done on it
  pi-lattice work add "<title>"      file an issue. Say why.
  pi-lattice work note <n> "<text>"  write down what you learned, for whoever comes next
  pi-lattice work done <n>           the work is finished: --summary says what, --check how you know
  pi-lattice work drop <n> "<why>"   give it back
  pi-lattice work prime              what an agent needs to be told, to put in its instructions

Options:
  --agent <name>     which agent is asking (default: $LATTICE_AGENT, or "agent")
  --json             print data, not text
  --under <n>        next, add, and the tree: only what is under this issue
  --type <type>      next: only this type. add: the type, when it is not what goes under its parent
  --label <label>    next: only issues with this label
  --all              the tree: finished work too
  --body <text|->    add: what it is and what done means; - reads standard input
  --waits <n,n>      add: the issues that must be finished first
  --human            add: it is for a person to do
  --first, --before <n>, --after <n>   add: where it goes among the others under its parent
  --why <text>       add: why it is filed
  --summary <text>   done: what was done
  --check <text>     done: how it was checked
  --url <where>      done: where to look

It exits 0 when it did what was asked, 3 when there is nothing to take, 4 when it was
refused, and 2 when the command was not understood. What went wrong is one line on
standard error.
`;

const PRIME = `This team keeps its work as issues on a lattice server, in a tree: larger pieces at
the root, tasks at the tips. Agents keep the issues; you are one of them. People do not
edit issues: they say what they want, and what they say can stand on an issue as a
direction for everything under it.

  pi-lattice work next
      Take the next issue that is ready. Do that issue and nothing else. It prints the
      directions that reach it: a person gave them, and they outrank the issue.
  pi-lattice work note <n> "<text>"
      Write down what you learn. The next agent reads it.
  pi-lattice work add "<title>" --under <n> --why "<why>"
      File what you find that is not yours to do now. Say why.
  pi-lattice work done <n> --summary "<what you did>" --check "<how you know it works>"
      The work is finished. Something else checks it and closes it; you do not.
  pi-lattice work drop <n> "<why>"
      Give it back when you cannot finish.

The issue is yours while you go on speaking of it. Go quiet for half an hour and it is
given to someone else. Add --json to any command to read it as data, and --agent <name>
(or LATTICE_AGENT) to say which agent you are.
`;

class Usage extends Error {}

interface Parsed {
	verb: string;
	words: string[];
	flags: Map<string, string | true>;
}

const VALUED = new Set(["agent", "under", "type", "label", "body", "waits", "before", "after", "why", "summary", "check", "url"]);
const SWITCHES = new Set(["json", "all", "human", "first", "help"]);

function parse(argv: readonly string[]): Parsed {
	const flags = new Map<string, string | true>();
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "-h") flags.set("help", true);
		else if (arg.startsWith("--")) {
			const name = arg.slice(2);
			if (SWITCHES.has(name)) flags.set(name, true);
			else if (VALUED.has(name)) {
				const value = argv[++i];
				if (value === undefined) throw new Usage(`${arg} needs a value.`);
				flags.set(name, value);
			} else throw new Usage(`There is no option ${arg}.`);
		} else words.push(arg);
	}
	return { verb: words[0] ?? "list", words: words.slice(1), flags };
}

const numberOf = (text: string | undefined, what: string): number => {
	const number = Number((text ?? "").replace(/^#/, ""));
	if (text === undefined || !Number.isInteger(number) || number <= 0) throw new Usage(`${what} is an issue's number.`);
	return number;
};

/** An issue as an agent about to work on it needs it: what it is, what stands above it, and what was said on it. */
function brief(issue: Issue, all: readonly Issue[], comments: ReadonlyArray<{ author: string; body: string }>): string[] {
	const by = new Map(all.map((entry) => [entry.number, entry]));
	const above = directionsFor(issue, by);
	return [
		issueLine(issue),
		...(issue.body.trim() ? ["", issue.body.trim()] : []),
		"",
		...(above.length > 0 ? ["Directions that reach it. A person gave them; they outrank the issue:", ...above.map((direction) => `  ⚑ ${direction.text}   (${direction.who}, on #${direction.on})`)] : ["No directions stand on it or above it."]),
		...(comments.length > 0 ? ["", "Said on it:", ...comments.map((comment) => `  ${comment.author}: ${comment.body}`)] : []),
	];
}

/** Run one `pi-lattice work` command. Returns the exit code. */
export async function workCommand(argv: readonly string[], io: WorkIo): Promise<number> {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		io.err(`${(error as Error).message} pi-lattice work --help lists what there is.`);
		return 2;
	}
	const { verb, words, flags } = parsed;
	const text = (name: string): string | undefined => (typeof flags.get(name) === "string" ? (flags.get(name) as string) : undefined);
	const json = flags.has("json");
	const print = (data: unknown, lines: string[]): void => io.out(json ? `${JSON.stringify(data, null, 2)}\n` : `${lines.join("\n")}\n`);
	if (flags.has("help") || verb === "help") {
		io.out(WORK_USAGE);
		return 0;
	}
	if (verb === "prime") {
		io.out(PRIME);
		return 0;
	}
	const account = readAccount(io.home);
	if (!account) {
		io.err("This machine has joined no server. In pi, /lattice server start keeps the work here, and /lattice server <address> joins a team's.");
		return 4;
	}
	const client = new WorkClient(account);
	const as = text("agent") ?? io.env.LATTICE_AGENT ?? "agent";
	try {
		const under = text("under") !== undefined ? numberOf(text("under"), "--under") : undefined;
		if (verb === "list") {
			await client.refresh();
			const state = client.state();
			print({ issues: state.issues, scheme: state.scheme }, [formatWork(state, { ...(under !== undefined ? { under } : {}), open: !flags.has("all") })]);
			return 0;
		}
		if (verb === "next") {
			const type = text("type");
			const label = text("label");
			const { issue, waiting } = await client.next({ repo: repoName(io.cwd), lease: true, ...(under !== undefined ? { under } : {}), ...(type ? { type } : {}), ...(label ? { label } : {}) }, { as });
			if (!issue) {
				const why = waiting > 0 ? `Nothing to take: ${waiting === 1 ? "1 issue waits" : `${waiting} issues wait`} on others that are not finished.` : "Nothing to take: nothing is ready for this repository.";
				if (json) io.out(`${JSON.stringify({ issue: null, waiting })}\n`);
				else io.err(why);
				return 3;
			}
			await client.refresh();
			const read = await client.read(issue.number, as);
			const all = client.state().issues;
			print({ issue, directions: directionsFor(issue, new Map(all.map((entry) => [entry.number, entry]))), comments: read.comments }, [...brief(issue, all, read.comments), "", "It is yours until you say done or drop it, or go quiet for 30 minutes."]);
			return 0;
		}
		if (verb === "show") {
			const number = numberOf(words[0], "What to show");
			await client.refresh();
			const read = await client.read(number, as);
			const result = read.issue.result;
			print(read, [
				...brief(read.issue, client.state().issues, read.comments),
				...(result ? ["", `Result, from ${result.by}: ${result.summary}`, ...(result.checks ? [`  checked: ${result.checks}`] : []), ...(result.url ? [`  where: ${result.url}`] : [])] : []),
				...(read.history.length > 0 ? ["", "What happened:", ...read.history.slice(-10).map((event) => `  ${event.as ?? event.who} ${event.what}${event.to !== undefined ? ` -> ${event.to}` : ""}${event.why ? `  (${event.why})` : ""}`)] : []),
			]);
			return 0;
		}
		if (verb === "add") {
			const title = words.join(" ").trim();
			if (title === "") throw new Usage("Give the issue a title.");
			const body = text("body") === "-" ? await (io.stdin?.() ?? Promise.resolve("")) : text("body");
			const waits = text("waits")?.split(",").map((entry) => numberOf(entry.trim(), "--waits"));
			const type = text("type");
			const place: Place | undefined = flags.has("first") ? "first" : text("before") !== undefined ? { before: numberOf(text("before"), "--before") } : text("after") !== undefined ? { after: numberOf(text("after"), "--after") } : undefined;
			const change: IssueChange = { title, ...(under !== undefined ? { parent: under } : {}), ...(body ? { body } : {}), ...(waits ? { waitsOn: waits } : {}), ...(flags.has("human") ? { human: true } : {}), ...(type ? { type } : {}), ...(place ? { place } : {}) };
			const why = text("why");
			const issue = await client.create(change, { as, ...(why ? { why } : {}) });
			print({ issue }, [`Added ${issueLine(issue)}${issue.parent !== undefined ? `, under #${issue.parent}` : ""}. Nobody is on it.`]);
			return 0;
		}
		if (verb === "note") {
			const number = numberOf(words[0], "What to note on");
			const said = words.slice(1).join(" ").trim();
			if (said === "") throw new Usage("Say what to note.");
			await client.comment(number, said, { as });
			print({ ok: true }, [`Noted on #${number}.`]);
			return 0;
		}
		if (verb === "done") {
			const number = numberOf(words[0], "What is done");
			const summary = text("summary") ?? words.slice(1).join(" ").trim();
			if (summary === "") throw new Usage('Say what was done: --summary "…".');
			const [checks, url] = [text("check"), text("url")];
			const issue = await client.done(number, { summary, ...(checks ? { checks } : {}), ...(url ? { url } : {}) }, { as });
			print({ issue }, [`The result is on #${number}, which is now ${issue.state}. It is checked from here: you do not close it.`]);
			return 0;
		}
		if (verb === "drop") {
			const number = numberOf(words[0], "What to give back");
			const why = words.slice(1).join(" ").trim();
			if (why === "") throw new Usage("Say why, for whoever takes it next.");
			const issue = await client.drop(number, why, as);
			print({ issue }, [`#${number} is given back, with what you said. It is ${issue.state} again.`]);
			return 0;
		}
		throw new Usage(`There is no "${verb}".`);
	} catch (error) {
		if (error instanceof Usage) {
			io.err(`${error.message} pi-lattice work --help lists what there is.`);
			return 2;
		}
		io.err(error instanceof Error ? error.message : String(error));
		return 4;
	}
}
