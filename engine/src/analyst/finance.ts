import type { ShippingBand, FinancingTerm } from "../config.js";
import type { MonthlyPaymentRow } from "../lib/types.js";

/**
 * Pure finance + shipping math for the analyst. No I/O, no config
 * reads — caller passes the config slices in. Heavily unit-tested.
 */

/**
 * Standard fixed-rate amortizing monthly payment.
 *
 *   M = P * r / (1 - (1 + r)^-n)
 *
 * where r = monthly rate (apr% / 100 / 12), n = months, P = principal.
 * When apr is 0, payment is simply P / n. Returns dollars rounded to the cent.
 */
export function monthlyPayment(apr: number, months: number, principal: number): number {
  if (months <= 0) throw new Error("months must be > 0");
  if (principal < 0) throw new Error("principal must be >= 0");
  let raw: number;
  if (apr === 0) {
    raw = principal / months;
  } else {
    const r = apr / 100 / 12;
    raw = (principal * r) / (1 - Math.pow(1 + r, -months));
  }
  return Math.round(raw * 100) / 100;
}

/** Compute every financing term's monthly payment for a principal. */
export function monthlyPaymentsForTerms(
  terms: FinancingTerm[],
  principal: number,
): MonthlyPaymentRow[] {
  return terms.map((t) => ({
    apr: t.apr,
    months: t.months,
    payment: monthlyPayment(t.apr, t.months, principal),
  }));
}

/**
 * Estimated shipping cost for a distance, using the configured bands. Bands are
 * "max distance -> cost"; the single catch-all band has maxDistanceMi = null.
 * Bands are evaluated in ascending order of maxDistanceMi (catch-all last).
 */
export function shippingEst(distanceMi: number, bands: ShippingBand[]): number {
  if (distanceMi < 0) throw new Error("distanceMi must be >= 0");
  const sorted = [...bands].sort((a, b) => {
    if (a.maxDistanceMi === null) return 1;
    if (b.maxDistanceMi === null) return -1;
    return a.maxDistanceMi - b.maxDistanceMi;
  });
  for (const band of sorted) {
    if (band.maxDistanceMi === null) return band.cost;
    if (distanceMi < band.maxDistanceMi) return band.cost;
  }
  // Should be unreachable given a catch-all band, but stay safe.
  const last = sorted[sorted.length - 1];
  return last ? last.cost : 0;
}

/** Landed price = listing price + estimated shipping. */
export function landedPrice(price: number, ship: number): number {
  return Math.round((price + ship) * 100) / 100;
}
