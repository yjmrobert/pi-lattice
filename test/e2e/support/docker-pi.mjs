#!/usr/bin/env node
/**
 * Stands where Pi's command line would, for Pi's RPC client, and runs Pi in a container
 * instead: what the client writes goes to that Pi, and what that Pi writes comes back.
 *
 *   E2E_CONTAINER   the container to run Pi in
 *   E2E_CWD         the directory there to run it in
 *   E2E_ENV         what to add to that Pi's environment, as a JSON object
 */
import { spawn } from "node:child_process";

const { E2E_CONTAINER: container, E2E_CWD: cwd } = process.env;
if (!container || !cwd) {
	process.stderr.write("docker-pi: E2E_CONTAINER and E2E_CWD say where Pi runs.\n");
	process.exit(2);
}
const env = Object.entries(JSON.parse(process.env.E2E_ENV ?? "{}")).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
const child = spawn("docker", ["exec", "-i", "-w", cwd, ...env, container, "pi", ...process.argv.slice(2)], { stdio: "inherit" });
// Ending `docker exec` closes that Pi's input, and a Pi in RPC mode with no input ends.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
