import { describe, it, expect } from "vitest";
import { discoverAdapters, enabledAdapters } from "../src/collector/registry.js";
import { testConfig } from "./helpers.js";

/**
 * Auto-discovery test. After the source design the registry auto-loads the MarketCheck
 * API adapter alongside the 5 (now-dormant) scraper adapters from
 * src/adapters/*.adapter.ts with NO edits to the shared registry — confirming
 * the "drop a file in" extension seam works for the API source too.
 */
describe("adapter auto-discovery (registry)", () => {
  it("auto-discovers every adapter in src/adapters", async () => {
    // Discovery is by directory scan, not a hardcoded import list: a new source
    // is one new *.adapter.ts file. This repo ships MarketCheck (an official,
    // licensed API) as its only source.
    const adapters = await discoverAdapters();
    const names = adapters.map((a) => a.name).sort();
    expect(names).toContain("marketcheck");
    expect(names.length).toBeGreaterThan(0);
  });

  it("every discovered adapter implements the SourceAdapter contract", async () => {
    const adapters = await discoverAdapters();
    for (const a of adapters) {
      expect(typeof a.name).toBe("string");
      expect(typeof a.enabled).toBe("boolean");
      expect(typeof a.search).toBe("function");
      expect(typeof a.captureHistory).toBe("function");
    }
  });

  it("marketcheck is enabled by default", async () => {
    const adapters = await discoverAdapters();
    const enabledByDefault = adapters.filter((a) => a.enabled).map((a) => a.name);
    expect(enabledByDefault).toEqual(["marketcheck"]);
  });

  it("marketcheck is an HTTP adapter, so no browser is launched for it", async () => {
    const adapters = await discoverAdapters();
    const mc = adapters.find((a) => a.name === "marketcheck");
    expect(mc?.usesBrowser).toBe(false);
  });

  it("enabledAdapters honors config (intersection of adapter.enabled + config.enabled)", async () => {
    const adapters = await discoverAdapters();
    // testConfig lists marketcheck enabled -> only marketcheck is active.
    const active = enabledAdapters(adapters, testConfig().sources);
    expect(active.map((a) => a.name)).toEqual(["marketcheck"]);
  });
});
