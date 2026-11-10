// Scripted model provider: deterministic, no network, no tokens.
// LATTICE_FAUX_SCRIPT points at a module whose default export builds the response steps.
import { pathToFileURL } from "node:url";
import * as ai from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
	const faux = ai.fauxProvider({ provider: "lattice-faux", models: [{ id: "scripted" }], tokensPerSecond: 100000 });
	const scriptPath = process.env.LATTICE_FAUX_SCRIPT;
	if (scriptPath) {
		const mod = await import(pathToFileURL(scriptPath).href);
		faux.setResponses(mod.default(ai));
	}
	pi.registerProvider(faux.provider);
}
