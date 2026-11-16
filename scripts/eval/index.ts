import { delegation } from "./delegation.ts";
import { grillingReads, phaseChange } from "./phases.ts";
import { planLayout } from "./planning.ts";
import { resultFail, resultPass, reviewFail, reviewPass } from "./review.ts";
import type { Scenario } from "./scenario.ts";
import { steerErrand, steerRule } from "./steering.ts";
import { workerStays } from "./worker.ts";

export type { Check, Scenario } from "./scenario.ts";
export { World, type WorldOptions } from "./world.ts";

/** Every scenario, in the order they are run and printed. */
export const SCENARIOS: readonly Scenario[] = [delegation, planLayout, phaseChange, grillingReads, workerStays, steerErrand, steerRule, resultPass, resultFail, reviewPass, reviewFail];
