import type { Config } from "../config.js";
import type {
  ListingSnapshot,
  AnalystResult,
  RankedListing,
  RuledOutListing,
} from "../lib/types.js";
import { applyHardFilters, dedupeByVin, rankByLandedPriceAsc } from "./filters.js";
import { estimateDistanceMi } from "./distance.js";
import { shippingEst, landedPrice, monthlyPaymentsForTerms } from "./finance.js";

/**
 * Analyst orchestration. Pure-ish: takes raw snapshots + config, runs
 * the deterministic math (distance -> shipping -> landed -> monthly), applies
 * hard filters, dedupes by VIN, and ranks by landed price ascending. No I/O.
 *
 * Returns three buckets: buyable (verified + passes filters), unverified
 * (history_status=unverified, surfaced separately), and rejected (with reasons).
 *
 * NOTE on the ADR's "Claude analyst pass": fuzzy report interpretation
 * (reading the CarFax service section, judging accident severity) happens at
 * capture/parse time in parseHistory(). This module is the deterministic math +
 * filtering that the judgment feeds into, and is fully unit-testable.
 */
export function analyze(snapshots: ListingSnapshot[], cfg: Config): AnalystResult {
  // 0. PO ruled-out memory: pull any VIN the PO marked NO GO (config.ruledOut)
  //    OUT of the run before anything else. It never reaches filtering, ranking,
  //    or the diff — it only appears in its own "Ruled out by you" bucket. Keyed
  //    by uppercase VIN; matched case-insensitively; one row per VIN.
  const ruledMap = cfg.ruledOut ?? {};
  const pinnedMap = cfg.pinnedListings ?? {};
  const pinnedKeys = new Set(Object.keys(pinnedMap).map((v) => v.toUpperCase()));
  const ruledOut: RuledOutListing[] = [];
  const seenRuled = new Set<string>();
  const active: ListingSnapshot[] = [];
  for (const s of snapshots) {
    const key = s.vin ? s.vin.toUpperCase() : "";
    const reason = key ? ruledMap[key] : undefined;
    if (reason !== undefined) {
      if (!seenRuled.has(key)) {
        ruledOut.push({ snapshot: s, reason });
        seenRuled.add(key);
      }
      continue;
    }
    // A pinned VIN's PO-corrected copy SUPERSEDES the feed copy (the feed value
    // is often why it was excluded — e.g. a wrong carfax_1_owner flag). Drop the
    // feed copy so the car isn't double-listed (once rejected, once pinned).
    if (key && pinnedKeys.has(key)) continue;
    active.push(s);
  }

  // 0b. PO-pinned manual listings (config.pinnedListings): cars the feed doesn't
  //     surface OR mis-classifies (wrong drivetrain/owner flag) that the PO still
  //     wants compared. Injected here with PO-corrected data so they rank
  //     alongside the feed; they never touch the store or the NEW/GONE diff. A
  //     pinned VIN that is also ruled out stays ruled out (ruledOut wins).
  for (const [vin, p] of Object.entries(pinnedMap)) {
    const key = vin.toUpperCase();
    if (ruledMap[key] !== undefined) continue; // ruledOut wins
    active.push(pinnedToSnapshot(key, p));
  }

  // 1. Compute landed cost on every remaining snapshot (distance -> shipping -> landed).
  const costed = active.map((s) => withLandedCost(s, cfg));

  // 2. Hard filters split into passed / unverified / rejected.
  const { passed, unverified, rejected } = applyHardFilters(costed, cfg);

  // 3. Dedupe + rank the buyable set.
  const buyable = buildRanked(passed, cfg);

  // 4. Dedupe + rank the unverified set too (so it is presentable), but it is
  //    kept SEPARATE from buyable and never treated as clean.
  const unverifiedRanked = buildRanked(unverified, cfg);

  return { buyable, unverified: unverifiedRanked, rejected, ruledOut };
}

type PinnedEntry = NonNullable<Config["pinnedListings"]>[string];

/**
 * Build a ListingSnapshot from a PO-pinned config entry. source is "marketcheck"
 * (the data came from there even though the facet search excluded it);
 * historyStatus is "verified" (owner/title known); the PO note rides in the
 * serviceHistory field so the reporter shows it in the Service-history column.
 * runId 0 + a synthetic capturedAt — pinned snapshots are never persisted.
 */
export function pinnedToSnapshot(vin: string, p: PinnedEntry): ListingSnapshot {
  return {
    vin,
    runId: 0,
    source: "marketcheck",
    price: p.price ?? null,
    mileage: p.mileage ?? null,
    dealer: p.dealer ?? null,
    location: p.location ?? null,
    zip: p.zip ?? null,
    drivetrain: p.drivetrain ?? null,
    trim: p.trim ?? null,
    url: p.url ?? null,
    exteriorColor: p.exteriorColor ?? null,
    ownerCount: p.ownerCount ?? null,
    accidentSeverity: p.accidentSeverity ?? "unknown",
    serviceIssueFlag: false,
    historyStatus: "verified",
    shippingEst: null,
    distanceMi: null,
    landedPrice: null,
    capturedAt: new Date().toISOString(),
    pinned: true,
    ...(p.note !== undefined ? { serviceHistory: p.note } : {}),
  };
}

/** Attach distanceMi / shippingEst / landedPrice to a snapshot (immutably). */
export function withLandedCost(s: ListingSnapshot, cfg: Config): ListingSnapshot {
  const distanceMi = estimateDistanceMi(cfg.homeZip, s.zip);
  // Per-VIN firm override (config.shippingOverrides, keyed by uppercase VIN)
  // wins over the distance-band estimate when present.
  const override = s.vin ? cfg.shippingOverrides?.[s.vin.toUpperCase()] : undefined;
  const firm = override !== undefined && override !== null;
  const ship = firm ? override : shippingEst(distanceMi, cfg.shippingBands);
  const landed = s.price !== null ? landedPrice(s.price, ship) : null;
  // Per-VIN listing-URL override (config.urlOverrides) wins over the data-source
  // URL — lets the PO point a VIN at a dealer's express-checkout page the feed
  // doesn't carry. Scheme-validated (http(s)) at config load.
  const urlOverride = s.vin ? cfg.urlOverrides?.[s.vin.toUpperCase()] : undefined;
  const url = urlOverride ?? s.url;
  // Per-VIN accident-severity correction (config.accidentOverrides): the PO has
  // read the actual dealer history report and confirmed the true severity (e.g.
  // a repaired minor fender-bender), which the feed could only mark "unknown".
  const accOverride = s.vin ? cfg.accidentOverrides?.[s.vin.toUpperCase()] : undefined;
  const accidentSeverity = accOverride ?? s.accidentSeverity;
  return { ...s, url, accidentSeverity, distanceMi, shippingEst: ship, landedPrice: landed, shippingFirm: firm };
}

function buildRanked(snapshots: ListingSnapshot[], cfg: Config): RankedListing[] {
  const deduped = dedupeByVin(snapshots);
  const canonical = deduped.map((d) => d.canonical);
  const ranked = rankByLandedPriceAsc(canonical);

  // index alternates by canonical VIN for re-attachment
  const altByVin = new Map<string, ListingSnapshot[]>();
  for (const d of deduped) {
    if (d.canonical.vin) altByVin.set(d.canonical.vin.toLowerCase(), d.alternates);
  }

  const refVin = cfg.referenceVin.toLowerCase();

  return ranked.map((snap, i): RankedListing => {
    const principal = snap.landedPrice ?? snap.price ?? 0;
    return {
      ...snap,
      rank: i + 1,
      monthly: monthlyPaymentsForTerms(cfg.financing, principal),
      alternates: snap.vin ? altByVin.get(snap.vin.toLowerCase()) ?? [] : [],
      isReferenceBaseline: snap.vin?.toLowerCase() === refVin,
    };
  });
}
