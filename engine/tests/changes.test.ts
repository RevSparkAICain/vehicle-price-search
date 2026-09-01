import { describe, it, expect } from "vitest";
import { diffRuns } from "../src/analyst/changes.js";
import { snap } from "./helpers.js";

describe("diffRuns (NEW / PRICE DROP / GONE)", () => {
  const prev = [
    snap({ vin: "1GYKPSRL2RZ100001", price: 60000 }), // stays, no change
    snap({ vin: "1GYKPSRL2RZ100002", price: 62000 }), // will drop
    snap({ vin: "1GYKPSRL2RZ100003", price: 58000 }), // will be GONE
  ];
  const curr = [
    snap({ vin: "1GYKPSRL2RZ100001", price: 60000 }),
    snap({ vin: "1GYKPSRL2RZ100002", price: 59500 }), // price drop
    snap({ vin: "1GYKPSRL2RZ100004", price: 57000 }), // NEW
  ];

  it("baseline run when there is no previous", () => {
    const d = diffRuns(curr, null);
    expect(d.isBaselineRun).toBe(true);
    expect(d.added).toHaveLength(0);
  });

  it("detects NEW vins", () => {
    const d = diffRuns(curr, prev);
    expect(d.added.map((s) => s.vin)).toEqual(["1GYKPSRL2RZ100004"]);
  });

  it("detects PRICE DROP with old->new", () => {
    const d = diffRuns(curr, prev);
    expect(d.priceDrops).toHaveLength(1);
    expect(d.priceDrops[0]?.vin).toBe("1GYKPSRL2RZ100002");
    expect(d.priceDrops[0]?.oldPrice).toBe(62000);
    expect(d.priceDrops[0]?.newPrice).toBe(59500);
  });

  it("detects GONE vins", () => {
    const d = diffRuns(curr, prev);
    expect(d.gone.map((s) => s.vin)).toEqual(["1GYKPSRL2RZ100003"]);
  });

  it("does not flag a price INCREASE as a drop", () => {
    const d = diffRuns(
      [snap({ vin: "1GYKPSRL2RZ100001", price: 61000 })],
      [snap({ vin: "1GYKPSRL2RZ100001", price: 60000 })],
    );
    expect(d.priceDrops).toHaveLength(0);
  });
});
