/**
 * In-memory fixed-window attempt counter.
 *
 * Sufficient for the single-process MVP (ARCHITECTURE.md §9: no Redis, no
 * distributed cache). Counts reset when the process restarts, and every app
 * instance owns its own limiter, so tests are isolated by construction; reset()
 * clears state explicitly.
 */

/** Above this many tracked keys, expired windows are swept on the next hit. */
const SWEEP_THRESHOLD = 10000;

export function createRateLimiter({ now = Date.now } = {}) {
  /** key -> { count, resetAt } */
  const windows = new Map();

  function current(key) {
    const window = windows.get(key);
    if (window && window.resetAt <= now()) {
      windows.delete(key);
      return undefined;
    }
    return window;
  }

  function sweep() {
    const time = now();
    for (const [key, window] of windows) {
      if (window.resetAt <= time) windows.delete(key);
    }
  }

  return {
    /** Seconds until `key` may try again, or 0 when it is under `limit`. */
    retryAfterSeconds(key, limit) {
      const window = current(key);
      if (!window || window.count < limit) return 0;
      return Math.ceil((window.resetAt - now()) / 1000);
    },

    /** Record one attempt for `key` in a window of `windowMs`. */
    hit(key, windowMs) {
      if (windows.size > SWEEP_THRESHOLD) sweep();
      const window = current(key);
      if (window) window.count += 1;
      else windows.set(key, { count: 1, resetAt: now() + windowMs });
    },

    /** Take back one attempt recorded by hit() (an attempt that did not count). */
    release(key) {
      const window = current(key);
      if (window && --window.count <= 0) windows.delete(key);
    },

    clear(key) {
      windows.delete(key);
    },

    reset() {
      windows.clear();
    },
  };
}
