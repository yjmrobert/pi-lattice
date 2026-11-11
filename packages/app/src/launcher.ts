/**
 * pi-lattice launcher: starts the background host when the pane asks for one.
 *
 * The pane knows how to talk to a host but not how one is started; this extension knows
 * how to start one but nothing about the pane. They meet on the `lattice:host:launch` event.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onEvent } from "@pi-lattice/protocol";

export default function launcherExtension(pi: ExtensionAPI): void {
	// A session the host runs headless never starts another host.
	if (process.env.LATTICE_HEADLESS) return;
	onEvent(pi.events, "lattice:host:launch", (request) => {
		// The bus keeps handlers from earlier sessions of this process; the first to claim starts the host.
		if (request.claimed) return;
		request.claimed = true;
		mkdirSync(request.stateDir, { recursive: true });
		const log = openSync(join(request.stateDir, "daemon.err"), "a");
		const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
		const child = spawn(process.execPath, [cli, "daemon", "--state", request.stateDir, "--cwd", request.cwd], {
			cwd: request.cwd,
			detached: true,
			stdio: ["ignore", log, log],
		});
		child.unref();
		closeSync(log);
	});
}
