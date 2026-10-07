// Token bucket: `capacity` updates can arrive back to back, after which the
// connection is held to `ratePerSec`.
export class TokenBucket {
  constructor(ratePerSec, capacity = ratePerSec, now = Date.now) {
    this.rate = ratePerSec;
    this.capacity = capacity;
    this.tokens = capacity;
    this.now = now;
    this.updatedAt = now();
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.updatedAt) / 1000) * this.rate);
    this.updatedAt = t;
  }

  take() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  // Milliseconds until one more update would be accepted.
  retryAfter() {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }
}

// Counts events inside a sliding window (used for failed joins and drops).
export class WindowCounter {
  constructor(windowMs, now = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
    this.hits = [];
  }

  add() {
    const t = this.now();
    this.hits.push(t);
    this.prune(t);
    return this.hits.length;
  }

  count() {
    this.prune(this.now());
    return this.hits.length;
  }

  prune(t) {
    while (this.hits.length && this.hits[0] <= t - this.windowMs) this.hits.shift();
  }
}
