/**
 * Shared domain types for the Vehicle Price Search pipeline.
 *
 * These flow collector -> store -> analyst -> reporter. Kept framework-free
 * (no Playwright, no node:sqlite imports) so the pure logic layers can import
 * them without dragging in browser/db deps.
 */

export type AccidentSeverity = "none" | "minor" | "major" | "unknown";
export type HistoryStatus = "verified" | "unverified";

/**
 * A raw result card as extracted from a source's search page (collector
 * output, pre-history-capture). Fields that aren't present on a card are
 * `null` rather than throwing — extraction is best-effort and debuggable.
 */
export interface ListingCard {
  vin: string | null;
  /** Vehicle identity (from MarketCheck build.*). Optional so existing card-producers compile. */
  make?: string | null;
  model?: string | null;
  year?: number | null;
  price: number | null;
  mileage: number | null;
  dealer: string | null;
  location: string | null;
  zip: string | null;
  drivetrain: string | null;
  trim: string | null;
  url: string | null;
  /** Exterior color, when the source carries it (MarketCheck exterior_color). Optional so existing card-producers compile. */
  exteriorColor?: string | null;
  /** Free-text badges off the card, e.g. "1-Owner", "No Accidents". */
  badges: string[];
  /**
   * Optional manual-check marker: owner + title come
   * inline from the listings API, but the service-history SECTION cannot be
   * confirmed via the API. When set (e.g. "VERIFY via dealer CarFax"), the
   * reporter surfaces it so the operator hand-checks service history on
   * finalists. Browser-scraped sources (which read the actual report) leave it
   * undefined. Optional so existing card-producers are unaffected.
   */
  serviceHistory?: string;
}

/**
 * Result of parsing a captured free vehicle-history report. NOTE: the raw
 * report text is NOT part of this type — only the minimal extracted fields
 * are kept (PII minimization, the security notes). The raw text is transient.
 */
export interface HistoryCapture {
  ownerCount: number | null;
  accidentSeverity: AccidentSeverity;
  serviceIssueFlag: boolean;
  historyStatus: HistoryStatus;
}

/**
 * A fully-resolved listing snapshot, as persisted to the store. This is the
 * union of card fields + history fields + run/source tagging + computed
 * landed-cost fields. It mirrors the `listings` table columns.
 */
export interface ListingSnapshot {
  vin: string;
  runId: number;
  source: string;
  /** Vehicle identity (persisted columns; from the source's build.*). */
  make?: string | null;
  model?: string | null;
  year?: number | null;
  price: number | null;
  mileage: number | null;
  dealer: string | null;
  location: string | null;
  zip: string | null;
  drivetrain: string | null;
  trim: string | null;
  url: string | null;
  /** Exterior color (persisted in the listings table; from the source's exterior_color). */
  exteriorColor?: string | null;
  ownerCount: number | null;
  accidentSeverity: AccidentSeverity;
  serviceIssueFlag: boolean;
  historyStatus: HistoryStatus;
  shippingEst: number | null;
  distanceMi: number | null;
  landedPrice: number | null;
  /** True when shippingEst came from a per-VIN firm override in config (not the distance band). In-memory only; not a DB column. */
  shippingFirm?: boolean;
  capturedAt: string;
  /**
   * Optional manual-check marker carried through from ListingCard. Not a DB column — it travels in-memory from card -> snapshot
   * -> ranked row so the reporter can render it; the store ignores it. Undefined
   * for browser-scraped sources that read the real history report.
   */
  serviceHistory?: string;
  /**
   * True when this snapshot was injected from config.pinnedListings (a PO manual
   * add the feed doesn't surface), so the reporter can mark it + surface its note
   * visibly. In-memory only; recomputed from config each run.
   */
  pinned?: boolean;
  /**
   * Optional "PO hand-verified clean" note (config.verifiedClean). Set by the
   * analyst when a verify-by-hand car's VIN is in config.verifiedClean — it
   * promotes the car into the buyable bucket and carries the PO's note for the
   * reporter to render. In-memory only (not a DB column); recomputed from config
   * each run, like shippingFirm / landedPrice. Undefined for every other car.
   */
  handVerified?: string;
}

export interface RunRecord {
  id: number;
  startedAt: string;
  sourceSet: string;
}

/** Monthly payment for one financing term applied to a principal. */
export interface MonthlyPaymentRow {
  apr: number;
  months: number;
  payment: number;
}

/** Analyst output for one buyable (or unverified) listing. */
export interface RankedListing extends ListingSnapshot {
  /** Lower is better; 1-based after ranking. */
  rank: number;
  monthly: MonthlyPaymentRow[];
  /** Other sources that carried this same VIN (deduped away). */
  alternates: ListingSnapshot[];
  isReferenceBaseline: boolean;
}

/** A listing the analyst rejected, with a recorded reason. */
export interface RejectedListing {
  snapshot: ListingSnapshot;
  reason: string;
}

/**
 * A listing the PO has personally ruled out (NO GO), with their reason. Pulled
 * out of the run BEFORE filtering/ranking/diff and surfaced in its own section —
 * it never re-appears in buyable / verify-by-hand / rejected / changes.
 */
export interface RuledOutListing {
  snapshot: ListingSnapshot;
  reason: string;
}

export interface AnalystResult {
  buyable: RankedListing[];
  /** history_status = unverified — surfaced separately, not ranked as clean. */
  unverified: RankedListing[];
  rejected: RejectedListing[];
  /** VINs the PO marked NO GO (config.ruledOut) — kept out of all buckets above. */
  ruledOut: RuledOutListing[];
}

/** Run-over-run diff (changes-<date>.md). */
export interface ChangesDiff {
  isBaselineRun: boolean;
  added: ListingSnapshot[];
  priceDrops: Array<{ vin: string; oldPrice: number; newPrice: number; snapshot: ListingSnapshot }>;
  gone: ListingSnapshot[];
}
