/**
 * Before the tests: build the package as it is published, and the image of a machine that has
 * it installed. The machines run what people get, not this checkout.
 *
 *   E2E_PI_VERSION   the Pi to install on the machines (default: the one this repository is built against)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

export default function setup(): void {
	const build = join(here, ".build");
	rmSync(build, { recursive: true, force: true });
	const context = join(build, "context");
	mkdirSync(context, { recursive: true });
	const built = join(build, "package");
	execFileSync(process.execPath, [join(root, "scripts/pack.mjs"), built], { stdio: "pipe" });
	execFileSync("npm", ["pack", "--pack-destination", context], { cwd: built, stdio: "pipe" });
	renameSync(join(context, readdirSync(context).find((name) => name.endsWith(".tgz")) as string), join(context, "pi-lattice.tgz"));
	const pi = process.env.E2E_PI_VERSION || (JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")) as { version: string }).version;
	try {
		execFileSync("docker", ["build", "--quiet", "--file", join(here, "Dockerfile"), "--build-arg", `PI_VERSION=${pi}`, "--tag", "pi-lattice-e2e", context], { stdio: "pipe" });
	} catch (error) {
		const said = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
		throw new Error(`The image of a machine could not be built. These tests need Docker with compose.\n${said}`);
	}
}
