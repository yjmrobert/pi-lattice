/**
 * Run inside a machine: ask the host of a repository there something, as that person's
 * terminal would, and print the answer as JSON. Prints `null` when no host is running.
 *
 *   node probe.ts <state directory> <method> [<params as JSON>]
 */
import type { UiMethod } from "@pi-lattice/protocol";
import { connectHost } from "../../../packages/pane/src/index.ts";

const [stateDir = "", method = "state", params = "{}"] = process.argv.slice(2);
const client = await connectHost(stateDir);
if (!client) {
	process.stdout.write("null\n");
	process.exit(0);
}
try {
	const answer = await client.ui(method as UiMethod, JSON.parse(params) as never);
	process.stdout.write(`${JSON.stringify(answer)}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
} finally {
	client.close();
}
process.exit(0);
