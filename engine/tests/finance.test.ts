import { describe, it, expect } from "vitest";
import {
  monthlyPayment,
  shippingEst,
  landedPrice,
} from "../src/analyst/finance.js";
import { testConfig } from "./helpers.js";

describe("monthlyPayment (standard amortization, assert within a cent)", () => {
  it("4.74% / 60mo on $60,000 principal = $1125.14", () => {
    // r = 0.0474/12; M = P*r/(1-(1+r)^-60). Verified value: 1125.14.
    expect(monthlyPayment(4.74, 60, 60000)).toBeCloseTo(1125.14, 2);
  });

  it("5.24% / 84mo on $60,000 principal = $854.82", () => {
    // r = 0.0524/12; n=84. Verified value: 854.82.
    expect(monthlyPayment(5.24, 84, 60000)).toBeCloseTo(854.82, 2);
  });

  it("0% APR is principal / months", () => {
    expect(monthlyPayment(0, 60, 60000)).toBeCloseTo(1000.0, 2);
  });

  it("rejects non-positive months and negative principal", () => {
    expect(() => monthlyPayment(4.74, 0, 1000)).toThrow();
    expect(() => monthlyPayment(4.74, 60, -1)).toThrow();
  });
});

describe("shippingEst band boundaries", () => {
  const bands = testConfig().shippingBands;
  it("under 500mi -> $400", () => {
    expect(shippingEst(0, bands)).toBe(400);
    expect(shippingEst(499, bands)).toBe(400);
  });
  it("exactly 500mi falls into the 500-1500 band -> $900 (boundary is < upper)", () => {
    expect(shippingEst(500, bands)).toBe(900);
    expect(shippingEst(1499, bands)).toBe(900);
  });
  it("1500-2500 -> $1300", () => {
    expect(shippingEst(1500, bands)).toBe(1300);
    expect(shippingEst(2499, bands)).toBe(1300);
  });
  it("2500+ catch-all -> $1500", () => {
    expect(shippingEst(2500, bands)).toBe(1500);
    expect(shippingEst(9999, bands)).toBe(1500);
  });
  it("rejects negative distance", () => {
    expect(() => shippingEst(-1, bands)).toThrow();
  });
});

describe("landedPrice", () => {
  it("adds shipping to listing price", () => {
    expect(landedPrice(58995, 900)).toBe(59895);
    expect(landedPrice(60000.5, 400)).toBe(60400.5);
  });
});
