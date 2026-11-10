/** Limits enforced by code. All are defaults; the human can raise them through configuration. */
export interface Limits {
	/** Envelopes whose hop count exceeds this are refused. Stops agent ping-pong. */
	maxHops: number;
	/** Maximum serialized payload size in bytes. Larger content travels as a file reference. */
	maxPayloadBytes: number;
	/** Maximum envelopes one node may send per minute. */
	maxSendsPerMinute: number;
	/** Maximum depth of a session tree. The root is depth 0. */
	maxDepth: number;
	/** Maximum direct children of one node. */
	maxChildren: number;
	/** Maximum nodes in one tree. */
	maxNodes: number;
	/** Maximum concurrently running session processes under one host. */
	maxRunning: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
	maxHops: 8,
	maxPayloadBytes: 64 * 1024,
	maxSendsPerMinute: 30,
	maxDepth: 4,
	maxChildren: 8,
	maxNodes: 40,
	maxRunning: 8,
});

/** Read limit overrides from environment-style variables such as `LATTICE_MAX_HOPS`. Invalid values are ignored. */
export function limitsFromEnv(env: Record<string, string | undefined>, base: Limits = DEFAULT_LIMITS): Limits {
	const read = (name: string, fallback: number): number => {
		const raw = env[name];
		if (raw === undefined) return fallback;
		const value = Number(raw);
		return Number.isInteger(value) && value > 0 ? value : fallback;
	};
	return {
		maxHops: read("LATTICE_MAX_HOPS", base.maxHops),
		maxPayloadBytes: read("LATTICE_MAX_PAYLOAD_BYTES", base.maxPayloadBytes),
		maxSendsPerMinute: read("LATTICE_MAX_SENDS_PER_MINUTE", base.maxSendsPerMinute),
		maxDepth: read("LATTICE_MAX_DEPTH", base.maxDepth),
		maxChildren: read("LATTICE_MAX_CHILDREN", base.maxChildren),
		maxNodes: read("LATTICE_MAX_NODES", base.maxNodes),
		maxRunning: read("LATTICE_MAX_RUNNING", base.maxRunning),
	};
}
