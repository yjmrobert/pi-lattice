/** A line-based interface to the host, for terminals without full-screen support and for scripting. */
import { createInterface } from "node:readline";
import { formatTree } from "@pi-lattice/protocol";
import type { LatticeHost } from "./host.ts";
import type { RpcRecord } from "./pi-process.ts";

const HELP = `Type a message to send it to the current session. Commands:
  :tree              show the session tree
  :use <id|name>     switch the current session
  :inbox             list mail waiting for approval
  :approve <id>      approve a pending message      :reject <id>   reject it
  :dialogs           list dialogs blocking sessions
  :answer <n> <text> answer dialog n (for confirm: yes or no)
  :abort             stop the current session's work
  :quit              stop all sessions and exit
Sharing, peer to peer:
  :share [port]      turn sharing on                         :invite         show your invite
  :add <invite>      pair with someone                       :trust <name>   pair with someone who knocked
  :people            paired people and who is online         :handoffs       open ownership handoffs
  :offer <session> <person>   :accept <session>   :confirm <session>   :cancel <session>   :sync`;

export async function runPlain(host: LatticeHost, rootId: string | undefined, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
	let current = rootId ?? "";
	const print = (text: string): void => void output.write(`${text}\n`);
	const label = (id: string): string => host.node(id)?.name ?? id;
	const openDialogs = () => host.nodes().flatMap((node) => host.dialogs(node.id).map((dialog) => ({ nodeId: node.id, dialog })));

	host.on("node", (node) => print(`[tree] ${node.name} (${node.id}) is ${node.status}`));
	host.on("envelope", (envelope, recipients) => print(`[mail] ${label(envelope.from)} -> ${recipients.map(label).join(", ")}: ${envelope.intent}`));
	host.on("mail", (nodeId, envelope, state) => {
		if (state === "pending") print(`[inbox] ${label(nodeId)} has a message from ${label(envelope.from)} waiting for approval: ${envelope.id}`);
	});
	host.on("dialog", (nodeId) => {
		for (const dialog of host.dialogs(nodeId)) print(`[blocked] ${label(nodeId)} asks: ${dialog.title}${dialog.options ? ` [${dialog.options.join(" / ")}]` : ""} (see :dialogs)`);
	});
	host.on("log", (level, message) => print(`[${level}] ${message}`));
	const find = (text: string) => host.nodes().find((node) => node.id === text || node.name === text);
	host.on("session", (nodeId, event: RpcRecord) => {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = (event.message.content as RpcRecord[]).filter((part) => part.type === "text").map((part) => part.text).join("");
			if (text.trim() !== "") print(`\n${label(nodeId)}> ${text}\n`);
		} else if (event.type === "extension_ui_request" && event.method === "notify") {
			print(`[${label(nodeId)}] ${event.message}`);
		}
	});

	print(formatTree(host.nodes()));
	print(HELP);
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const raw of lines) {
		const line = raw.trim();
		if (line === "") continue;
		try {
			if (!line.startsWith(":")) {
				if (!host.node(current)) current = host.nodes()[0]?.id ?? "";
				if (!current) print("There are no sessions yet.");
				else await host.prompt(current, line);
				continue;
			}
			const [command, ...rest] = line.slice(1).split(/\s+/);
			const arg = rest.join(" ");
			if (command === "quit" || command === "q") break;
			if (command === "tree") print(formatTree(host.nodes(), { self: current }));
			else if (command === "help") print(HELP);
			else if (command === "use") {
				const target = host.nodes().find((node) => node.id === arg || node.name === arg);
				if (!target) print(`No session "${arg}".`);
				else {
					current = target.id;
					print(`Now talking to ${target.name} (${target.id}).`);
				}
			} else if (command === "inbox") {
				const pending = host.pendingMail();
				print(pending.length === 0 ? "Nothing is waiting for approval." : pending.map((r) => `${r.envelope.id}  to ${label(r.recipient)} from ${label(r.envelope.from)}: ${r.envelope.payload.text}`).join("\n"));
			} else if (command === "approve" || command === "reject") {
				const record = host.pendingMail().find((r) => r.envelope.id === arg);
				if (!record) print(`No pending message ${arg}.`);
				else await host.decideMail(record.recipient, record.envelope.id, command);
			} else if (command === "dialogs") {
				const dialogs = openDialogs();
				print(dialogs.length === 0 ? "No session is blocked." : dialogs.map((d, i) => `${i + 1}. ${label(d.nodeId)}: ${d.dialog.title}${d.dialog.options ? ` [${d.dialog.options.join(" / ")}]` : ""}`).join("\n"));
			} else if (command === "answer") {
				const entry = openDialogs()[Number(rest[0]) - 1];
				const text = rest.slice(1).join(" ");
				if (!entry) print("No such dialog. See :dialogs.");
				else if (entry.dialog.method === "confirm") host.answerDialog(entry.nodeId, entry.dialog.id, { confirmed: /^(y|yes|true)$/i.test(text) });
				else host.answerDialog(entry.nodeId, entry.dialog.id, text === "" ? { cancelled: true } : { value: text });
			} else if (command === "abort") await host.abort(current);
			else if (["share", "invite", "add", "people", "trust", "handoffs", "sync", "offer", "accept", "confirm", "cancel"].includes(command ?? "")) {
				const sharing = host.uiState().sharing;
				const run = async (action: string, args: string[]): Promise<void> => print(await host.runSharing(action, args));
				if (command === "share") await run("start", rest);
				else if (!sharing) print("Sharing is off. Turn it on with :share [port].");
				else if (command === "people") print(sharing.people.map((p) => `${p.name}${p.self ? " (you)" : ""}  ${p.trust}  ${p.online ? "online" : "offline"}  ${p.fingerprint}`).join("\n"));
				else if (command === "handoffs") print(sharing.handoffs.map((h) => `${h.nodeName}: ${h.from} -> ${h.to}, ${h.state} (you are the ${h.role})`).join("\n") || "No open handoffs.");
				else if (command === "invite" || command === "add" || command === "trust") await run(command, rest);
				else if (command === "sync") await run("refresh", []);
				else {
					const target = find(rest[0] ?? "");
					if (!target) print(`No session "${rest[0] ?? ""}".`);
					else await run(command ?? "", [target.id, ...rest.slice(1)]);
				}
			}
			else print(`Unknown command :${command}. Try :help.`);
		} catch (error) {
			print(`[error] ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	lines.close();
}
