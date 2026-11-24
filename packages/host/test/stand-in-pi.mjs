/**
 * A stand-in for `pi --mode rpc`, for tests of how the host supervises sessions: it connects to
 * the host as the session it was started as, takes a prompt as the start of a turn, and ends
 * the turn when told to `settle`. It says what happens to it in `life.log`, a line each.
 * A session whose name has "slow" in it takes a while to connect.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const dir = process.env.STAND_IN_DIR;
const name = process.env.LATTICE_NODE_NAME ?? "";
const id = process.env.LATTICE_NODE_ID;
const log = (what) => appendFileSync(join(dir, "life.log"), `${name} ${what}\n`);
const say = (...records) => process.stdout.write(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
const file = join(dir, `${id}.jsonl`);
writeFileSync(file, "");
log(`started pid=${process.pid}`);

setTimeout(() => {
	const socket = connect(process.env.LATTICE_SOCK);
	socket.on("error", () => {});
	socket.write(`${JSON.stringify({ t: "hello", token: process.env.LATTICE_TOKEN, nodeId: id, channel: "a2a", protocol: 1, pid: process.pid, sessionId: `s-${id}`, sessionFile: file })}\n`);
}, name.includes("slow") ? 600 : 30);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
		const line = buffer.slice(0, at);
		buffer = buffer.slice(at + 1);
		if (line === "") continue;
		const command = JSON.parse(line);
		if (command.type === "prompt") {
			log(`prompted: ${String(command.message).replace(/\s+/g, " ").slice(0, 80)}`);
			say({ type: "response", id: command.id, success: true, data: { disposition: "started" } }, { type: "agent_start" });
		} else if (command.type === "settle") say({ type: "response", id: command.id, success: true, data: {} }, { type: "agent_settled" });
		else say({ type: "response", id: command.id, success: true, data: {} });
	}
});
process.stdin.on("end", () => {
	log("stopped");
	process.exit(0);
});
