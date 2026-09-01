import type { Config } from "../config.js";

/**
 * Human-pacing + per-domain rate limiting.
 *
 * SECURITY: pacing is ON by default for every adapter (the security notes). There
 * is no bypass flag. The posture is "behave like a supervised human", NOT
 * stealth-at-scale — no proxy rotation, no fingerprint spoofing here or
 * anywhere. This is both a courtesy and a ban-avoidance control.
 */

/** Jittered delay between actions, bounds from config.pacing. Exposed pure for testing. */
export function jitteredDelayMs(
  minMs: number,
  maxMs: number,
  rng: () => number = Math.random,
): number {
  if (maxMs < minMs) throw new Error("maxMs must be >= minMs");
  return Math.round(minMs + (maxMs - minMs) * rng());
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-domain rate limiter: enforces a minimum interval between requests to the
 * same host. computeWaitMs is pure + unit-testable; throttle() applies it.
 */
export class RateLimiter {
  private lastHitAt = new Map<string, number>();

  constructor(private readonly perDomainMinIntervalMs: number) {}

  /** Pure: given the last-hit timestamp and now, how long must we wait? */
  static computeWaitMs(
    lastHitAt: number | undefined,
    now: number,
    minIntervalMs: number,
  ): number {
    if (lastHitAt === undefined) return 0;
    const elapsed = now - lastHitAt;
    return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
  }

  /** Block until the per-domain min interval has elapsed, then record the hit. */
  async throttle(domain: string, now: () => number = Date.now): Promise<void> {
    const wait = RateLimiter.computeWaitMs(
      this.lastHitAt.get(domain),
      now(),
      this.perDomainMinIntervalMs,
    );
    if (wait > 0) await sleep(wait);
    this.lastHitAt.set(domain, now());
  }
}

/** Bundles pacing + rate limiting; what adapters use to behave human-like. */
export class Pacer {
  readonly rateLimiter: RateLimiter;

  constructor(private readonly cfg: Config) {
    this.rateLimiter = new RateLimiter(cfg.pacing.perDomainMinIntervalMs);
  }

  /** Jittered pause between in-page actions. */
  async pauseBetweenActions(rng: () => number = Math.random): Promise<void> {
    const ms = jitteredDelayMs(
      this.cfg.pacing.minActionDelayMs,
      this.cfg.pacing.maxActionDelayMs,
      rng,
    );
    await sleep(ms);
  }

  /** Throttle then pause — call before a navigation to a domain. */
  async beforeNavigate(domain: string): Promise<void> {
    await this.rateLimiter.throttle(domain);
    await this.pauseBetweenActions();
  }
}
