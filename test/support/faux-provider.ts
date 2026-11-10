/**
 * Test-support extension: a scripted model provider. Deterministic, no network, no tokens.
 * `LATTICE_FAUX_SCRIPT` names a module whose default export builds the response steps.
 */
import { pathToFileURL } from "node:url";
import * as ai from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function fauxProviderExtension(pi: ExtensionAPI): Promise<void> {
	const faux = ai.fauxProvider({ provider: "lattice-faux", models: [{ id: "scripted" }], tokensPerSecond: 100_000 });
	const scriptPath = process.env.LATTICE_FAUX_SCRIPT;
	if (scriptPath) {
		const mod = (await import(pathToFileURL(scriptPath).href)) as { default: (api: typeof ai) => Parameters<typeof faux.setResponses>[0] };
		faux.setResponses(mod.default(ai));
	}
	pi.registerProvider(faux.provider);
}
