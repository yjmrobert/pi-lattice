/**
 * pi-lattice launcher: starts the background host when the pane asks for one.
 *
 * The pane knows how to talk to a host but not how one is started; this extension knows
 * how to start one but nothing about the pane. They meet on the `lattice:host:launch` event.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
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
		// From source the host is beside this file; in the published package it is built into `host/`.
		const here = dirname(fileURLToPath(import.meta.url));
		const built = join(here, "..", "host", "cli.js");
		const cli = existsSync(built) ? built : join(here, "cli.ts");
		// The host reads session files with Pi's library, and has no copy of its own: tell it which Pi this is.
		const started = process.argv[1];
		// Node 22 says on every start that its SQLite is experimental; kept out of daemon.err, which is read for what went wrong.
		const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "daemon", "--state", request.stateDir, "--cwd", request.cwd], {
			cwd: request.cwd,
			env: { ...process.env, ...(started ? { LATTICE_PI_STARTED: started } : {}) },
			detached: true,
			stdio: ["ignore", log, log],
		});
		child.unref();
		closeSync(log);
	});
}
