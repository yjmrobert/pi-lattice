// Phase 0 verification spikes. Run: node spikes/phase0/run.mjs
// Spawns real Pi processes in RPC mode against a scripted model provider. No network, no tokens.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const out = join(here, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "agent"), { recursive: true });
mkdirSync(join(out, "work"), { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = fn();
		if (v) return v;
		await sleep(20);
	}
	return undefined;
};

// --- host socket -----------------------------------------------------------
const sockPath = join(out, "host.sock");
const records = []; // { tag, ...record }
const conns = new Map(); // tag -> socket
const server = createServer((sock) => {
	let buffer = "";
	let tag;
	sock.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let nl;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const rec = JSON.parse(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
			if (rec.type === "session_start") {
				tag = rec.tag;
				conns.set(tag, sock);
			}
			records.push({ ...rec, tag: tag ?? rec.tag });
		}
	});
	sock.on("error", () => {});
});
await new Promise((r) => server.listen(sockPath, r));
const sendTo = (tag, cmd) => conns.get(tag).write(`${JSON.stringify(cmd)}\n`);
const recs = (tag, type) => records.filter((r) => r.tag === tag && r.type === type);

// --- child factory ---------------------------------------------------------
const cliPath = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const spawn = async (tag, { extraArgs = [], cwd = join(out, "work"), role = `ROLE-${tag}` } = {}) => {
	const client = new RpcClient({
		cliPath,
		cwd,
		provider: "lattice-faux",
		model: "scripted",
		env: {
			PI_CODING_AGENT_DIR: join(out, "agent"),
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			LATTICE_SOCK: sockPath,
			LATTICE_TAG: tag,
			LATTICE_ROLE_TEXT: role,
			LATTICE_FAUX_SCRIPT: join(here, "script-echo.mjs"),
		},
		args: [
			"-e", join(here, "ext/faux.ts"),
			"-e", join(here, "ext/probe.ts"),
			"-e", join(here, "pkg"),
			"--session-dir", join(out, "sessions"),
			"--no-skills", "--no-context-files",
			...extraArgs,
		],
	});
	const events = [];
	client.onEvent((e) => events.push(e));
	await client.start();
	return { client, events, tag };
};
const lastAssistantText = (events) => {
	const ends = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
	const msg = ends[ends.length - 1]?.message;
	return msg?.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
};

try {
	// S1 faux provider + S2 manifest/workspace dep + S3 prompt sections
	const idA = randomUUID();
	const a = await spawn("A", { extraArgs: ["--session-id", idA] });
	const startA = await until(() => recs("A", "session_start")[0]);
	check("S5 extension reaches host unix socket in session_start", !!startA, JSON.stringify(startA));
	check("S8 --session-id assigns the Pi session id", startA?.sessionId === idA, `${startA?.sessionId}`);
	const bus = await until(() => recs("A", "bus")[0]);
	check("S2 package manifest loads; workspace-linked TS dep + typebox resolve; S7 pi.events crosses extensions",
		bus?.data?.protocol === 1 && bus?.data?.typebox === "function", JSON.stringify(bus?.data));

	await a.client.promptAndWait("hello", undefined, 15000);
	const t1 = lastAssistantText(a.events);
	check("S1 scripted faux provider drives a full run over RPC", t1.includes("lastRole=user"), t1);
	check("S3 systemPromptOptions.sections injects a per-session role section", t1.includes("role=ROLE-A"), t1);

	// S5b host -> extension -> sendMessage(triggerTurn) starts a run with no user prompt
	a.events.length = 0;
	sendTo("A", { cmd: "inject", text: "INBOUND-FROM-HOST" });
	await until(() => a.events.some((e) => e.type === "agent_settled"), 15000);
	const t2 = lastAssistantText(a.events);
	check("S5b socket-injected sendMessage(triggerTurn) wakes an idle session", t2.includes("INBOUND-FROM-HOST"), t2);
	const bas = recs("A", "before_agent_start").map((r) => r.messageType);
	check("S5c before_agent_start distinguishes user vs custom runs", bas.join(",") === "user,custom", bas.join(","));

	// S6 dialogs are forwarded over RPC and block until answered
	a.events.length = 0;
	sendTo("A", { cmd: "confirm" });
	const uiReq = await until(() => a.events.find((e) => e.type === "extension_ui_request" && e.method === "confirm"));
	check("S6 ctx.ui.confirm surfaces as extension_ui_request", !!uiReq, JSON.stringify(uiReq));
	await sleep(300);
	check("S6b dialog blocks until the client answers", recs("A", "confirm-result").length === 0);
	check("S6c RpcClient has no public API to answer dialogs", typeof a.client.respondToExtensionUI === "undefined" && typeof a.client.sendExtensionUIResponse === "undefined");
	a.client.process.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: uiReq.id, confirmed: true })}\n`);
	const conf = await until(() => recs("A", "confirm-result")[0]);
	check("S6d answering via raw stdin resolves the dialog", conf?.ok === true, JSON.stringify(conf));

	// S8b session replacement inside one process changes identity
	await a.client.newSession();
	const starts = await until(() => (recs("A", "session_start").length >= 2 ? recs("A", "session_start") : undefined));
	check("S8b new_session fires shutdown(new)+start(new) with a different session id",
		recs("A", "session_shutdown")[0]?.reason === "new" && starts?.[1]?.reason === "new" && starts[1].sessionId !== idA,
		`${starts?.[1]?.sessionId}`);
	await a.client.stop();

	// S4 concurrency
	const n = 8;
	const t0 = Date.now();
	const kids = await Promise.all(Array.from({ length: n }, (_, i) => spawn(`K${i}`)));
	await until(() => kids.every((k) => recs(k.tag, "session_start").length > 0), 30000);
	const startMs = Date.now() - t0;
	const t1b = Date.now();
	await Promise.all(kids.map((k) => k.client.promptAndWait(`ping ${k.tag}`, undefined, 30000)));
	const runMs = Date.now() - t1b;
	const okAll = kids.every((k) => lastAssistantText(k.events).includes(`role=ROLE-${k.tag}`) && lastAssistantText(k.events).includes(`ping ${k.tag}`));
	const rss = kids.map((k) => recs(k.tag, "session_start")[0]?.rssMb);
	check(`S4 ${n} concurrent RPC children start and run in isolation`, okAll, `start ${startMs}ms, run ${runMs}ms, rss at start MB ${rss.join("/")}`);
	await Promise.all(kids.map((k) => k.client.stop()));

	// S9 resume a session whose working directory is gone
	const gone = join(out, "gone");
	mkdirSync(gone);
	const idG = randomUUID();
	const g = await spawn("G", { cwd: gone, extraArgs: ["--session-id", idG] });
	await g.client.promptAndWait("persist me", undefined, 15000);
	const gFile = (await until(() => recs("G", "session_start")[0])).sessionFile;
	await g.client.stop();
	const same = await spawn("G2", { cwd: gone, extraArgs: ["--session", gFile] });
	const s2 = await until(() => recs("G2", "session_start")[0]);
	check("S9 resume by session file keeps the same session id", s2?.sessionId === idG, `${s2?.sessionId}`);
	await same.client.stop();
	rmSync(gone, { recursive: true });
	let moved = "started";
	let g3;
	try {
		g3 = await spawn("G3", { extraArgs: ["--session", gFile] });
		const s3 = await until(() => recs("G3", "session_start")[0], 3000);
		moved = s3 ? `started cwd=${s3.cwd}` : `no session_start; stderr=${g3.client.getStderr().trim().slice(0, 200)}`;
	} catch (e) {
		moved = `exit: ${String(e.message).slice(0, 240)}`;
	}
	check("S9b resume with missing cwd fails in RPC mode (transfer needs fork/import)", !moved.startsWith("started"), moved);
	await g3?.client.stop().catch(() => {});
	const g4 = await spawn("G4", { extraArgs: ["--fork", gFile] });
	const s4 = await until(() => recs("G4", "session_start")[0], 5000);
	check("S9c --fork adopts a foreign session into the local cwd with a new id", !!s4 && s4.sessionId !== idG, JSON.stringify(s4 ?? g4.client.getStderr().slice(0, 200)));
	if (s4) {
		await g4.client.promptAndWait("after fork", undefined, 15000);
		const msgs = await g4.client.getMessages();
		check("S9d forked session carries prior history", JSON.stringify(msgs).includes("persist me"));
	}
	await g4.client.stop().catch(() => {});

	// S10 Pi's own chat components are importable by a host process
	const pi = await import("@earendil-works/pi-coding-agent");
	check("S10 Pi exports its interactive message components for a host renderer",
		["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent", "CustomMessageComponent"].every((k) => typeof pi[k] === "function"));
} catch (e) {
	check("runner completed without exception", false, e.stack ?? String(e));
} finally {
	server.close();
	for (const s of conns.values()) s.destroy();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
