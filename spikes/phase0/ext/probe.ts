// Probe extension: reports what it observes to a unix socket owned by the spike runner,
// and executes a few commands the runner sends back.
import { connect, type Socket } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let sock: Socket | undefined;
	const report = (record: Record<string, unknown>) => sock?.write(`${JSON.stringify(record)}\n`);

	pi.events.on("lattice:spike-hello", (data) => report({ type: "bus", data }));

	pi.on("session_start", async (event, ctx) => {
		const path = process.env.LATTICE_SOCK;
		if (!path) return;
		sock = connect(path);
		let buffer = "";
		sock.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const cmd = JSON.parse(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (cmd.cmd === "inject") {
					pi.sendMessage({ customType: "lattice-spike", content: cmd.text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				} else if (cmd.cmd === "confirm") {
					void ctx.ui.confirm("Spike approval", "Deliver inbound message?").then((ok) => report({ type: "confirm-result", ok }));
				}
			}
		});
		sock.on("error", () => {});
		await new Promise<void>((resolve) => sock?.once("connect", () => resolve()));
		report({
			type: "session_start",
			tag: process.env.LATTICE_TAG,
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			cwd: ctx.cwd,
			mode: ctx.mode,
			hasUI: ctx.hasUI,
			pid: process.pid,
			rssMb: Math.round(process.memoryUsage().rss / 1e6),
		});
	});

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections["lattice-role"] = process.env.LATTICE_ROLE_TEXT ?? "ROLE-MARKER-DEFAULT";
		report({ type: "before_agent_start", messageType: event.messageType });
	});

	pi.on("session_shutdown", async (event) => {
		report({ type: "session_shutdown", reason: event.reason });
		sock?.end();
		sock = undefined;
	});
}
