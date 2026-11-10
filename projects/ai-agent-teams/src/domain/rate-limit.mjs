/**
 * Small, deterministic interval limiter for provider-facing dispatches.
 * It spaces request starts so a burst of 16/32 workers does not immediately
 * exhaust a provider's requests-per-minute quota.
 */
export class IntervalRateLimiter {
  constructor({ requestsPerMinute = 0, now = () => Date.now(), sleep } = {}) {
    this.requestsPerMinute = Number(requestsPerMinute) || 0;
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.intervalMs = this.requestsPerMinute > 0 ? 60000 / this.requestsPerMinute : 0;
    this.nextAt = 0;
    this.tail = Promise.resolve();
  }

  async acquire() {
    if (!this.intervalMs) return;
    const run = this.tail.then(async () => {
      const wait = Math.max(0, this.nextAt - this.now());
      if (wait > 0) await this.sleep(wait);
      this.nextAt = Math.max(this.now(), this.nextAt) + this.intervalMs;
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
