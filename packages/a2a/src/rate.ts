/** Sliding-window rate limit: at most `limit` events in any `windowMs`. */
export class RateLimiter {
	/** May be changed between events, when the setting behind it changes. */
	limit: number;
	private readonly windowMs: number;
	private stamps: number[] = [];

	constructor(limit: number, windowMs = 60_000) {
		this.limit = limit;
		this.windowMs = windowMs;
	}

	/** Record an event if allowed. Returns false when the limit is reached. */
	tryAcquire(now: number = Date.now()): boolean {
		this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs);
		if (this.stamps.length >= this.limit) return false;
		this.stamps.push(now);
		return true;
	}
}
