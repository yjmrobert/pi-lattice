import { childrenOf } from "../../packages/protocol/src/index.ts";
import type { Scenario } from "./scenario.ts";

/** A coordinator moves its own session from one phase to the next, and is still a coordinator afterwards. */
export const phaseChange: Scenario = {
	name: "phase-change",
	about: "A session told to move to the next phase applies it, and keeps every other role it had.",
	exercises: ["lifecycle", "coordinator", "grilling", "planning", "protocol", "tools"],
	async run(world, check) {
		const first = await world.host.createRoot({
			name: "eval",
			cwd: world.work,
			fragments: ["coordinator", "lifecycle", "grilling"],
			brief: [
				"The grilling of this request is finished and I accept its result: add a --json flag to the report command.",
				"Move this session on to the planning phase now, the way your lifecycle role says a session changes phase.",
				"Do not write the plan yet, create no sessions and change no files.",
				"Then answer with one line that starts with PHASE and names the phase this session is in.",
			].join(" "),
		});
		const done = await world.until(async () => world.quiet() && /^\s*PHASE/m.test(await world.last(first.id)));
		const roles = world.roles(first.id);
		const calls = (await world.tools(first.id)).filter((call) => call.name === "apply_role" && Array.isArray(call.args.fragments) && call.args.fragments.length > 0);

		check(world.blocked === "", "nobody waited on a question", world.blocked);
		check(done, "it finished and said which phase it is in", (await world.last(first.id)).slice(0, 200));
		check(roles.includes("planning"), "the session is in the planning phase", `roles: ${roles.join(" ")}`);
		check(!roles.includes("grilling"), "it is no longer in the grilling phase", `roles: ${roles.join(" ")}`);
		check(["protocol", "coordinator", "lifecycle"].every((name) => roles.includes(name)), "it kept the roles it was given", `roles: ${roles.join(" ")}`);
		check(calls.length === 1, "it changed phase with one call", `${calls.length} calls: ${JSON.stringify(calls.map((call) => call.args))}`);
		check(world.changed().length === 0, "it changed no files", world.changed().join(", "));
		check(childrenOf(world.nodes(), first.id).length === 0, "it created no sessions");
	},
};

const SERVER = `import { createServer } from "node:http";

const notes = new Map();

// GET /notes lists them, POST /notes adds one, DELETE /notes/:id removes one.
export const server = createServer(async (request, response) => {
	const url = new URL(request.url, "http://localhost");
	if (request.method === "GET" && url.pathname === "/notes") return send(response, 200, [...notes.values()]);
	if (request.method === "POST" && url.pathname === "/notes") {
		const note = { id: String(notes.size + 1), text: await body(request) };
		notes.set(note.id, note);
		return send(response, 201, note);
	}
	if (request.method === "DELETE" && url.pathname.startsWith("/notes/")) return send(response, notes.delete(url.pathname.slice(7)) ? 204 : 404, null);
	send(response, 404, { error: "not found" });
});

function send(response, status, value) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(value === null ? "" : JSON.stringify(value));
}

async function body(request) {
	let text = "";
	for await (const chunk of request) text += chunk;
	return text;
}

if (process.argv[1] === new URL(import.meta.url).pathname) server.listen(process.env.PORT ?? 3000);
`;

/** A session in the grilling phase reads, asks, and builds nothing. */
export const grillingReads: Scenario = {
	name: "grilling-reads",
	about: "A session grilling a vague request reads the code, asks what changes the outcome, and changes nothing.",
	exercises: ["grilling", "worker", "story", "protocol"],
	async run(world, check) {
		world.file("server.js", SERVER);
		world.file("README.md", "# notes\n\nA small notes API. `node server.js` starts it on port 3000.\n");
		const first = await world.host.createRoot({
			name: "eval",
			cwd: world.work,
			fragments: ["worker", "grilling", "story"],
			brief: "The request, as it reached us: add rate limiting to the API. Grill it.",
		});
		const done = await world.until(async () => world.quiet() && (await world.texts(first.id)).length > 0);
		const calls = await world.tools(first.id);
		const said = (await world.texts(first.id)).join("\n");
		const writes = calls.filter((call) => call.name === "edit" || call.name === "write");

		check(world.blocked === "", "nobody waited on a question", world.blocked);
		check(done, "it finished");
		check(calls.some((call) => JSON.stringify(call.args).includes("server.js")), "it read the code before asking", calls.map((call) => call.name).join(" "));
		check((said.match(/\?/g) ?? []).length >= 3, "it asked questions", `${(said.match(/\?/g) ?? []).length} question marks`);
		check(writes.length === 0 && world.changed().length === 0, "it changed no files", [...writes.map((call) => `${call.name} ${call.args.path ?? ""}`), ...world.changed()].join(", "));
		check(childrenOf(world.nodes(), first.id).length === 0, "it created no sessions");
	},
};
