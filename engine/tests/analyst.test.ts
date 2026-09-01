import { describe, it, expect } from "vitest";
import { analyze, withLandedCost } from "../src/analyst/analyst.js";
import { testConfig, snap } from "./helpers.js";

const cfg = testConfig();

describe("analyze (full pure pipeline)", () => {
  it("computes landed cost, filters, dedupes, ranks", () => {
    const snapshots = [
      // clean local, low price -> should rank #1
      snap({ vin: "1GYKPSRL2RZ100001", zip: "48226", price: 58000 }),
      // clean far (Portland) -> higher shipping band
      snap({ vin: "1GYKPSRL2RZ100002", zip: "97201", price: 57000 }),
      // same VIN as #2 from another source, cheaper -> dedup canonical
      snap({ vin: "1GYKPSRL2RZ100002", source: "source-c", zip: "97201", price: 56000 }),
      // 2-owner: owner flag unreliable -> verify-by-hand now (not rejected)
      snap({ vin: "1GYKPSRL2RZ100003", ownerCount: 2 }),
      // unverified bucket (no history at all)
      snap({ vin: "1GYKPSRL2RZ100004", historyStatus: "unverified", accidentSeverity: "unknown", ownerCount: null }),
    ];
    const r = analyze(snapshots, cfg);

    expect(r.rejected).toHaveLength(0); // 2-owner no longer hard-rejected
    expect(r.unverified).toHaveLength(2); // 100003 (2-owner) + 100004 (no history)
    expect(r.buyable).toHaveLength(2); // 100001 + deduped 100002

    // landed cost attached + ranks assigned
    for (const b of r.buyable) {
      expect(b.landedPrice).not.toBeNull();
      expect(b.rank).toBeGreaterThan(0);
      expect(b.monthly.find((m) => m.months === 60)).toBeDefined();
      expect(b.monthly.find((m) => m.months === 84)).toBeDefined();
    }

    // dedupe kept the cheaper 'cars' source as canonical for 100002
    const dedup = r.buyable.find((b) => b.vin === "1GYKPSRL2RZ100002");
    expect(dedup?.source).toBe("source-c");
    expect(dedup?.alternates).toHaveLength(1);
  });

  it("flags the reference baseline VIN", () => {
    const r = analyze([snap({ vin: cfg.referenceVin, zip: "97201" })], cfg);
    expect(r.buyable[0]?.isReferenceBaseline).toBe(true);
  });
});

describe("withLandedCost", () => {
  it("local zip -> small shipping band", () => {
    const s = withLandedCost(snap({ zip: "48226", price: 58000 }), cfg);
    expect(s.shippingEst).toBe(400);
    expect(s.landedPrice).toBe(58400);
    expect(s.distanceMi).toBeLessThan(500);
  });
});

describe("analyze — PO ruled-out memory", () => {
  it("pulls a ruled-out VIN into its own bucket, out of every other bucket", () => {
    const c = { ...cfg, ruledOut: { "1GYKPSRL2RZ100009": "branded title — NO GO" } };
    const r = analyze(
      [
        snap({ vin: "1GYKPSRL2RZ100001", price: 58000 }), // buyable
        snap({ vin: "1GYKPSRL2RZ100009", ownerCount: 2 }), // would be rejected, but ruled out
      ],
      c,
    );
    expect(r.ruledOut).toHaveLength(1);
    expect(r.ruledOut[0]?.snapshot.vin).toBe("1GYKPSRL2RZ100009");
    expect(r.ruledOut[0]?.reason).toMatch(/branded/);
    const everywhereElse = [
      ...r.buyable.map((x) => x.vin),
      ...r.unverified.map((x) => x.vin),
      ...r.rejected.map((x) => x.snapshot.vin),
    ];
    expect(everywhereElse).not.toContain("1GYKPSRL2RZ100009");
  });

  it("matches the ruled-out VIN case-insensitively", () => {
    const c = { ...cfg, ruledOut: { "1GYKPSRL2RZ100009": "x" } };
    const r = analyze([snap({ vin: "1gykpsrl2rz100009" })], c);
    expect(r.ruledOut).toHaveLength(1);
  });

  it("ruledOut is empty when config has no ruled-out VINs", () => {
    const r = analyze([snap({ vin: "1GYKPSRL2RZ100001" })], cfg);
    expect(r.ruledOut).toHaveLength(0);
  });
});

describe("withLandedCost — per-VIN firm shipping override", () => {
  it("uses the firm override and flags it when the VIN is listed", () => {
    const c = { ...cfg, shippingOverrides: { "1GYKPSRL2RZ100001": 1650 } };
    const s = withLandedCost(snap({ vin: "1GYKPSRL2RZ100001", zip: "97201", price: 44240 }), c);
    expect(s.shippingFirm).toBe(true);
    expect(s.shippingEst).toBe(1650); // firm, NOT the Portland distance band
    expect(s.landedPrice).toBe(45890); // 44240 + 1650
  });

  it("matches the override VIN case-insensitively", () => {
    const c = { ...cfg, shippingOverrides: { "1GYKPSRL2RZ100001": 1650 } };
    const s = withLandedCost(snap({ vin: "1gykpsrl2rz100001", zip: "97201", price: 44240 }), c);
    expect(s.shippingEst).toBe(1650);
    expect(s.shippingFirm).toBe(true);
  });

  it("leaves non-overridden VINs on the distance-band estimate", () => {
    const c = { ...cfg, shippingOverrides: { "1GYKPSRL2RZ999999": 1650 } };
    const s = withLandedCost(snap({ vin: "1GYKPSRL2RZ100001", zip: "97201", price: 44240 }), c);
    expect(s.shippingFirm).toBeFalsy();
    expect(s.shippingEst).not.toBe(1650);
  });
});

describe("analyze — PO-pinned manual listings", () => {
  const pinned = {
    "1GYKPSRL6RZ106372": {
      price: 45791,
      mileage: 12661,
      dealer: "Germain Cadillac Of Easton",
      location: "Columbus, OH",
      zip: "43219",
      drivetrain: "AWD",
      trim: "Luxury 3",
      url: "https://www.germaincadillacofeaston.com/inventory/x/",
      exteriorColor: "Opulent Blue Metallic",
      ownerCount: 1,
      accidentSeverity: "unknown" as const,
      note: "ADDED BY YOU. VERIFY drivetrain.",
    },
  };

  it("injects a pinned VIN into the run (here: unknown title -> verify-by-hand) with its note + landed cost", () => {
    const c = { ...cfg, pinnedListings: pinned };
    const r = analyze([snap({ vin: "1GYKPSRL2RZ100001", price: 58000 })], c);
    const all = [...r.buyable, ...r.unverified];
    const pin = all.find((x) => x.vin === "1GYKPSRL6RZ106372");
    expect(pin).toBeDefined();
    expect(r.unverified.map((u) => u.vin)).toContain("1GYKPSRL6RZ106372"); // unknown title
    expect(pin?.landedPrice).not.toBeNull();
    expect(pin?.serviceHistory).toBe("ADDED BY YOU. VERIFY drivetrain.");
    expect(pin?.exteriorColor).toBe("Opulent Blue Metallic");
  });

  it("a pinned VIN supersedes its feed copy (PO-corrected data wins; not double-listed)", () => {
    const vin = "1GYKPSRL0RZ124558";
    const c = {
      ...cfg,
      pinnedListings: {
        [vin]: {
          price: 50991, mileage: 9968, dealer: "Germain Cadillac Of Easton",
          location: "Columbus, OH", zip: "43219", drivetrain: "AWD", trim: "Luxury 3",
          exteriorColor: "Emerald Lake Metallic", ownerCount: 1,
          accidentSeverity: "none" as const, note: "CarFax says 1-owner",
        },
      },
    };
    // feed copy is the WRONG 2-owner one that would be rejected
    const r = analyze([snap({ vin, ownerCount: 2, price: 50991 })], c);
    expect(r.rejected.map((x) => x.snapshot.vin)).not.toContain(vin); // feed copy dropped
    expect(r.buyable.map((x) => x.vin)).toContain(vin); // pinned copy passes
    const pin = r.buyable.find((x) => x.vin === vin);
    expect(pin?.pinned).toBe(true);
    expect(pin?.ownerCount).toBe(1);
  });

  it("a pinned VIN that is also ruled out is excluded everywhere (ruledOut wins, not re-injected)", () => {
    const c = { ...cfg, pinnedListings: pinned, ruledOut: { "1GYKPSRL6RZ106372": "changed my mind" } };
    const r = analyze([snap({ vin: "1GYKPSRL2RZ100001" })], c);
    const everywhere = [...r.buyable, ...r.unverified, ...r.rejected.map((x) => x.snapshot)];
    expect(everywhere.map((x) => x.vin)).not.toContain("1GYKPSRL6RZ106372");
  });
});

describe("withLandedCost — per-VIN listing-URL override", () => {
  const override = "https://express.landrovereaston.com/express/used/1GYKPSRL6RZ105867?deal_type=cash";

  it("replaces the data-source URL with the override when the VIN is listed", () => {
    const c = { ...cfg, urlOverrides: { "1GYKPSRL6RZ105867": override } };
    const s = withLandedCost(snap({ vin: "1GYKPSRL6RZ105867", url: "https://feed.example/vdp/x" }), c);
    expect(s.url).toBe(override);
  });

  it("matches the override VIN case-insensitively", () => {
    const c = { ...cfg, urlOverrides: { "1GYKPSRL6RZ105867": override } };
    const s = withLandedCost(snap({ vin: "1gykpsrl6rz105867", url: "https://feed.example/vdp/x" }), c);
    expect(s.url).toBe(override);
  });

  it("leaves a non-overridden VIN's URL untouched", () => {
    const c = { ...cfg, urlOverrides: { "1GYKPSRL2RZ999999": override } };
    const s = withLandedCost(snap({ vin: "1GYKPSRL2RZ100001", url: "https://feed.example/vdp/x" }), c);
    expect(s.url).toBe("https://feed.example/vdp/x");
  });
});

describe("accidentOverrides — PO corrects severity from the dealer report", () => {
  const vin = "1GYKPSRL6RZ106372";

  it("withLandedCost overrides accidentSeverity for the listed VIN", () => {
    const c = { ...cfg, accidentOverrides: { [vin]: "minor" as const } };
    const s = withLandedCost(snap({ vin, accidentSeverity: "unknown" }), c);
    expect(s.accidentSeverity).toBe("minor");
  });

  it("promotes an owner-confirmed car from verify-by-hand to BUYABLE when severity is corrected unknown->minor (minor is allowed)", () => {
    const c = { ...cfg, accidentOverrides: { [vin]: "minor" as const } };
    const r = analyze([snap({ vin, ownerCount: 1, accidentSeverity: "unknown" })], c);
    expect(r.buyable.map((x) => x.vin)).toContain(vin);
    expect(r.unverified.map((x) => x.vin)).not.toContain(vin);
    expect(r.buyable.find((x) => x.vin === vin)?.accidentSeverity).toBe("minor");
  });

  it("leaves a non-listed VIN's severity untouched", () => {
    const c = { ...cfg, accidentOverrides: { "1GYKPSRL2RZ999999": "minor" as const } };
    const s = withLandedCost(snap({ vin: "1GYKPSRL2RZ100001", accidentSeverity: "unknown" }), c);
    expect(s.accidentSeverity).toBe("unknown");
  });
});
