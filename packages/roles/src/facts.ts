/**
 * What is so for this session, gathered before each turn: the tools it has, which it knows
 * itself, and what its host says of it. The one place in the roles extension that asks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitEvent, type Facts, type LatticeEvents, TOOL_FACT, toolFacts } from "@pi-lattice/protocol";

/** How long a turn waits for a host to say what is so. After that it goes on with what was last known. */
const WAIT_MS = 1500;

/** The tools the session has been given, whether or not they are declared to the model at this moment. */
function tools(pi: Pick<ExtensionAPI, "getAllTools">): string[] {
	try {
		return pi.getAllTools().filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	} catch {
		return [];
	}
}

/**
 * Ask what is so. Whoever knows something fills it in; an answer that has to be fetched is
 * handed over as a promise and waited for, briefly. With no answer in time, what the host said
 * last still stands: a fact does not stop being so because a socket was slow.
 */
export async function gatherFacts(pi: Pick<ExtensionAPI, "events" | "getAllTools">, last: Facts = {}): Promise<Facts> {
	const request: LatticeEvents["lattice:facts:query"] = { facts: {}, pending: [] };
	emitEvent(pi.events, "lattice:facts:query", request);
	let inTime = true;
	if (request.pending && request.pending.length > 0) {
		let timer: NodeJS.Timeout | undefined;
		const late = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), WAIT_MS);
			timer.unref?.();
		});
		inTime = await Promise.race([Promise.allSettled(request.pending).then(() => true as const), late]);
		clearTimeout(timer);
	}
	const fromHost = inTime ? request.facts : Object.fromEntries(Object.entries(last).filter(([name]) => !name.startsWith(TOOL_FACT)));
	return { ...fromHost, ...toolFacts(tools(pi)) };
}
