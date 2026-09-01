import type { Config } from "../src/config.js";
import type { ListingSnapshot } from "../src/lib/types.js";

/** A minimal valid config for analyst/reporter tests (no live paths needed). */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    target: { year: 2024, make: "Cadillac", model: "LYRIQ", trim: "Luxury 3", drivetrain: "AWD" },
    maxMileage: 15000,
    owners: 1,
    accidentsAllowed: "minor",
    homeZip: "60601",
    referenceVin: "1GYKPSRL2RZ141166",
    sources: [{ name: "marketcheck", enabled: true }],
    shippingBands: [
      { maxDistanceMi: 500, cost: 400 },
      { maxDistanceMi: 1500, cost: 900 },
      { maxDistanceMi: 2500, cost: 1300 },
      { maxDistanceMi: null, cost: 1500 },
    ],
    financing: [
      { apr: 4.74, months: 60 },
      { apr: 5.24, months: 84 },
    ],
    pacing: { minActionDelayMs: 2000, maxActionDelayMs: 6000, perDomainMinIntervalMs: 4000 },
    paths: {
      dbFile: "C:\\dev\\vehicle-price-search\\test.db",
      profilesDir: "C:\\dev\\vehicle-price-search\\profiles",
      outDir: "C:\\dev\\vehicle-price-search\\out",
      scratchDir: "C:\\dev\\vehicle-price-search\\scratch",
      resultsCopyDir: "C:\\OneDrive\\results",
    },
    ...overrides,
  };
}

/** Build a snapshot with sensible defaults; override any field. */
export function snap(overrides: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    vin: "1GYKPSRL2RZ100001",
    runId: 1,
    source: "source-a",
    price: 58995,
    mileage: 8000,
    dealer: "Synthetic Cadillac",
    location: "Detroit, MI",
    zip: "48226",
    drivetrain: "AWD",
    trim: "Luxury 3",
    url: "https://example.test/vdp/1",
    exteriorColor: null,
    ownerCount: 1,
    accidentSeverity: "none",
    serviceIssueFlag: false,
    historyStatus: "verified",
    shippingEst: null,
    distanceMi: null,
    landedPrice: null,
    capturedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}
