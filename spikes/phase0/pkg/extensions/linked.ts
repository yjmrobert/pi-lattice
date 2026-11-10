// Spike: a Pi package whose extension imports a workspace-linked TypeScript dependency
// and talks to a separately loaded extension over pi.events.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "@pi-lattice/protocol";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		pi.events.emit("lattice:spike-hello", { from: "linked", protocol: PROTOCOL_VERSION, typebox: typeof Type.Object });
	});
}
