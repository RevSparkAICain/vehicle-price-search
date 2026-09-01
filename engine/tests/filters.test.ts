import { describe, it, expect } from "vitest";
import {
  applyHardFilters,
  dedupeByVin,
  rankByLandedPriceAsc,
} from "../src/analyst/filters.js";
import { testConfig, snap } from "./helpers.js";

const cfg = testConfig();

describe("applyHardFilters", () => {
  it("passes a clean verified match", () => {
    const r = applyHardFilters([snap()], cfg);
    expect(r.passed).toHaveLength(1);
    expect(r.unverified).toHaveLength(0);
    expect(r.rejected).toHaveLength(0);
  });

  it("rejects high mileage (>= maxMileage)", () => {
    const r = applyHardFilters([snap({ mileage: 15000 })], cfg);
    expect(r.passed).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/mileage/);
  });

  it("rejects wrong trim", () => {
    const r = applyHardFilters([snap({ trim: "Tech" })], cfg);
    expect(r.rejected[0]?.reason).toMatch(/trim/);
  });

  it("rejects wrong drivetrain", () => {
    const r = applyHardFilters([snap({ drivetrain: "RWD" })], cfg);
    expect(r.rejected[0]?.reason).toMatch(/drivetrain/);
  });

  it("routes a 2-owner car to verify-by-hand (owner flag unreliable; never hard-rejected)", () => {
    const r = applyHardFilters([snap({ ownerCount: 2 })], cfg);
    expect(r.rejected).toHaveLength(0);
    expect(r.unverified).toHaveLength(1);
    expect(r.passed).toHaveLength(0);
  });

  it("routes an unknown-owner car (owner flag absent) to verify-by-hand, not buyable", () => {
    const r = applyHardFilters([snap({ ownerCount: null })], cfg);
    expect(r.passed).toHaveLength(0);
    expect(r.unverified).toHaveLength(1);
  });

  it("rejects a service issue", () => {
    const r = applyHardFilters([snap({ serviceIssueFlag: true })], cfg);
    expect(r.rejected[0]?.reason).toMatch(/service issue/);
  });

  it("rejects a major accident", () => {
    const r = applyHardFilters([snap({ accidentSeverity: "major" })], cfg);
    expect(r.rejected[0]?.reason).toMatch(/accident_severity/);
  });

  it("accepts a minor accident", () => {
    const r = applyHardFilters([snap({ accidentSeverity: "minor" })], cfg);
    expect(r.passed).toHaveLength(1);
  });

  it("routes unverified-history to the unverified bucket (not dropped, not passed clean)", () => {
    const r = applyHardFilters(
      [snap({ historyStatus: "unverified", accidentSeverity: "unknown", ownerCount: null })],
      cfg,
    );
    expect(r.unverified).toHaveLength(1);
    expect(r.passed).toHaveLength(0);
    expect(r.rejected).toHaveLength(0);
  });
});

describe("verifiedClean promotion (PO hand-checked the dealer history report)", () => {
  const vin = "1GYKPSRL4RZ141136";

  it("promotes an unknown-accident car into buyable when its VIN is in verifiedClean", () => {
    const c = testConfig({ verifiedClean: { [vin]: "Hand-checked: clean" } });
    const r = applyHardFilters([snap({ vin, accidentSeverity: "unknown" })], c);
    expect(r.passed).toHaveLength(1);
    expect(r.unverified).toHaveLength(0);
    expect(r.passed[0]?.handVerified).toBe("Hand-checked: clean");
  });

  it("matches the VIN case-insensitively", () => {
    const c = testConfig({ verifiedClean: { [vin.toUpperCase()]: "ok" } });
    const r = applyHardFilters([snap({ vin: vin.toLowerCase(), accidentSeverity: "unknown" })], c);
    expect(r.passed).toHaveLength(1);
  });

  it("leaves an unknown-accident car in verify-by-hand when not listed", () => {
    const r = applyHardFilters([snap({ accidentSeverity: "unknown" })], testConfig());
    expect(r.unverified).toHaveLength(1);
    expect(r.passed).toHaveLength(0);
  });

  it("never bypasses a HARD filter — a wrong-trim car stays rejected even if verifiedClean-listed", () => {
    const c = testConfig({ verifiedClean: { [vin]: "clean" } });
    const r = applyHardFilters(
      [snap({ vin, trim: "Tech", accidentSeverity: "unknown" })],
      c,
    );
    expect(r.rejected).toHaveLength(1);
    expect(r.passed).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/trim/);
  });

  it("promotes a verifiedClean car whose ONLY issue is an unreliable 2-owner flag (PO confirmed 1-owner by CarFax)", () => {
    const c = testConfig({ verifiedClean: { [vin]: "CarFax says 1-owner" } });
    const r = applyHardFilters([snap({ vin, ownerCount: 2, accidentSeverity: "unknown" })], c);
    expect(r.passed.map((s) => s.vin)).toContain(vin);
    expect(r.rejected).toHaveLength(0);
  });
});

describe("dedupeByVin (lowest price wins; cross-source)", () => {
  it("keeps lowest-price snapshot as canonical, rest as alternates", () => {
    const a = snap({ vin: "1GYKPSRL2RZ100009", source: "source-a", price: 60000 });
    const b = snap({ vin: "1GYKPSRL2RZ100009", source: "source-c", price: 58000 });
    const c = snap({ vin: "1GYKPSRL2RZ100009", source: "source-b", price: 59000 });
    const out = dedupeByVin([a, b, c]);
    expect(out).toHaveLength(1);
    expect(out[0]?.canonical.price).toBe(58000);
    expect(out[0]?.canonical.source).toBe("source-c");
    expect(out[0]?.alternates).toHaveLength(2);
  });

  it("treats different VINs as distinct entries", () => {
    const out = dedupeByVin([
      snap({ vin: "1GYKPSRL2RZ100001" }),
      snap({ vin: "1GYKPSRL2RZ100002" }),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("rankByLandedPriceAsc", () => {
  it("orders by landed price ascending, null last", () => {
    const ranked = rankByLandedPriceAsc([
      snap({ vin: "A".repeat(17), landedPrice: 61000 }),
      snap({ vin: "B".repeat(17), landedPrice: null }),
      snap({ vin: "C".repeat(17), landedPrice: 59000 }),
    ]);
    expect(ranked.map((r) => r.landedPrice)).toEqual([59000, 61000, null]);
  });
});
