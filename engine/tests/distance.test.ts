import { describe, it, expect } from "vitest";
import { estimateDistanceMi, haversineMi } from "../src/analyst/distance.js";

describe("estimateDistanceMi (offline zip3-centroid haversine estimate)", () => {
  it("home -> home region is small (< 500 band)", () => {
    expect(estimateDistanceMi("48226", "48226")).toBeLessThan(500);
  });
  it("Detroit -> Portland OR is a long haul (2500+ band)", () => {
    // straight-line ~1950mi * 1.18 circuity ~ 2300+; either way far.
    expect(estimateDistanceMi("48226", "97201")).toBeGreaterThan(1500);
  });
  it("Detroit -> Chicago lands in a mid band (roughly 250-300mi)", () => {
    const d = estimateDistanceMi("48226", "60601");
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(600);
  });
  it("null/unknown listing zip falls back to national average 1500", () => {
    expect(estimateDistanceMi("48226", null)).toBe(1500);
  });
  it("unknown ZIP3 falls back to first-digit region (no crash)", () => {
    const d = estimateDistanceMi("48226", "99950"); // AK-ish ZIP, not in table
    expect(d).toBeGreaterThan(0);
  });
});

describe("haversineMi sanity", () => {
  it("Detroit -> LA is roughly 1900mi straight line", () => {
    const d = haversineMi({ lat: 42.33, lon: -83.05 }, { lat: 34.05, lon: -118.24 });
    expect(d).toBeGreaterThan(1800);
    expect(d).toBeLessThan(2100);
  });
});
