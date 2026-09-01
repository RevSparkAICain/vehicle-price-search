import { describe, it, expect } from "vitest";
import { jitteredDelayMs, RateLimiter } from "../src/collector/pacing.js";
import { looksLikeChallenge, challengeSelectors } from "../src/collector/captcha.js";

describe("pacing — jitteredDelayMs (pure)", () => {
  it("returns min when rng=0 and max when rng=1", () => {
    expect(jitteredDelayMs(2000, 6000, () => 0)).toBe(2000);
    expect(jitteredDelayMs(2000, 6000, () => 1)).toBe(6000);
  });
  it("returns a mid value for rng=0.5", () => {
    expect(jitteredDelayMs(2000, 6000, () => 0.5)).toBe(4000);
  });
  it("rejects max < min", () => {
    expect(() => jitteredDelayMs(6000, 2000)).toThrow();
  });
});

describe("rate limiter — computeWaitMs (pure)", () => {
  it("no wait on first hit", () => {
    expect(RateLimiter.computeWaitMs(undefined, 1000, 4000)).toBe(0);
  });
  it("waits the remaining interval", () => {
    expect(RateLimiter.computeWaitMs(1000, 2000, 4000)).toBe(3000);
  });
  it("no wait once the interval has elapsed", () => {
    expect(RateLimiter.computeWaitMs(1000, 6000, 4000)).toBe(0);
  });
});

describe("captcha — looksLikeChallenge (pure heuristic)", () => {
  it("flags a Cloudflare 'Just a moment' title", () => {
    expect(looksLikeChallenge("Just a moment...", [])).toBe(true);
  });
  it("flags 'Attention Required' title", () => {
    expect(looksLikeChallenge("Attention Required! | Cloudflare", [])).toBe(true);
  });
  it("flags when a challenge selector is present", () => {
    expect(looksLikeChallenge("Cars for sale", ["#px-captcha"])).toBe(true);
  });
  it("does not flag a normal results page", () => {
    expect(looksLikeChallenge("Used 2024 Example Model for Sale - ExampleCars", [])).toBe(false);
  });
  it("exposes a non-empty selector list for the live probe", () => {
    expect(challengeSelectors().length).toBeGreaterThan(0);
  });
});
