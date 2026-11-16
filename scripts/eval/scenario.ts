/** A scenario: one small piece of work given to real sessions, and what must be true afterwards. */
import type { World } from "./world.ts";

/** Record one thing that was checked: whether it held, what it is, and what was seen when it did not. */
export type Check = (ok: boolean, what: string, detail?: string) => void;

export interface Scenario {
	name: string;
	/** What it shows, in one line. */
	about: string;
	/**
	 * What it puts to the test: role fragments by name, `template:<name>` for a text pi-lattice
	 * writes into a session, `tools` for the guidelines that come with the tools.
	 */
	exercises: string[];
	/** It needs a server for the team's work. */
	board?: boolean;
	/** Set the world up, let the sessions work, and check what happened. Never how it was worded. */
	run(world: World, check: Check): Promise<void>;
}
