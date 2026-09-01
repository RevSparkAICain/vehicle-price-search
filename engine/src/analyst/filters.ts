import type { Config } from "../config.js";
import type { ListingSnapshot, RejectedListing } from "../lib/types.js";

/**
 * Pure hard-filter + dedupe + rank logic. No I/O.
 *
 * Hard filters (brief.md): year=2024, trim=Luxury 3, drivetrain=AWD,
 * mileage<15000, owners==1, accident in {none, minor}, no service issues.
 *
 * KEY RULE: a listing whose history_status is `unverified` is NOT silently
 * dropped and NOT passed as clean — it is routed into a separate "unverified"
 * bucket for manual check. Only listings with verified history are eligible to
 * be ranked as buyable.
 *
 * GENERALIZED for multi-vehicle reuse (a multi-vehicle search): trim "*" matches ANY
 * trim; cfg.ownersAny=true makes owner count non-gating; cfg.maxPrice rejects
 * over-budget cars. All three are backward-compatible (a concrete trim, no
 * ownersAny, no maxPrice => the original single-vehicle behavior).
 */

export interface HardFilterResult {
  /** Verified + passes every hard filter — eligible for the ranked list. */
  passed: ListingSnapshot[];
  /** history_status = unverified — surfaced separately, never ranked clean. */
  unverified: ListingSnapshot[];
  /** Failed a hard filter, each with a recorded reason. */
  rejected: RejectedListing[];
}

const ACCIDENT_OK = new Set(["none", "minor"]);

/** Normalize for trim/drivetrain comparison (case + whitespace tolerant). */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Apply the hard filters to a set of snapshots. Pure: returns three buckets.
 * `target` comes from config (year/trim/drivetrain), thresholds from config
 * (maxMileage, owners, maxPrice). Nothing is hardcoded.
 */
export function applyHardFilters(
  snapshots: ListingSnapshot[],
  cfg: Pick<
    Config,
    | "target"
    | "extraTargets"
    | "maxMileage"
    | "owners"
    | "verifiedClean"
    | "maxPrice"
    | "ownersAny"
    | "exteriorColors"
  >,
): HardFilterResult {
  const passed: ListingSnapshot[] = [];
  const unverified: ListingSnapshot[] = [];
  const rejected: RejectedListing[] = [];

  // Trim gate accepts the UNION of every target's trim, not just the primary's.
  // A multi-trim search (Jeep GC L "Limited" + "Limited Reserve") queries each
  // trim as its own target; gating on the primary alone rejected every row from
  // the others. A "*" anywhere in the set means all-trims (wildcard wins).
  const wantTrims = new Set(
    [cfg.target, ...(cfg.extraTargets ?? [])].map((t) => norm(t.trim)),
  );
  const anyTrim = wantTrims.has("*");
  // Exterior-color gate. The query already asks the API for these colors; this
  // re-checks locally so a pinned or non-API listing cannot slip past. Matching
  // is substring + case-insensitive because snapshots carry the MARKETING name
  // ("Silver Zynith") while config names the normalized bucket ("Silver").
  // ponytail: substring match, not the base_ext_color bucket itself — capturing
  // that would need a store migration. Upgrade if a marketing name ever spans
  // two buckets (e.g. a "Silver-Gray" that is bucketed Gray).
  // Union of the run-level list and every target's override. The per-target
  // FACET is what actually selects each year's color server-side; this local
  // gate only has to know the full set of acceptable colors, so a 2027 gray car
  // is not rejected by a run-level "Silver".
  const wantColors = [
    ...new Set(
      [
        ...(cfg.exteriorColors ?? []),
        ...[cfg.target, ...(cfg.extraTargets ?? [])].flatMap((t) => t.exteriorColors ?? []),
      ].map(norm),
    ),
  ].filter(Boolean);
  const wantDrivetrain = norm(cfg.target.drivetrain);
  const verifiedCleanMap = cfg.verifiedClean ?? {};

  for (const s of snapshots) {
    // No history at all (e.g. a scraped listing with no free report) -> manual
    // bucket: never auto-pass, never drop.
    if (s.historyStatus === "unverified") {
      unverified.push(s);
      continue;
    }

    // HARD filters = the RELIABLE specs only. Trim is cross-checkable, drivetrain
    // is now NHTSA-authoritative, mileage is exact, a flagged service issue is
    // concrete. A failure here is a real, trustworthy reject.
    const reasons: string[] = [];

    // trim "*" (wildcard) matches any trim — used by all-trims searches.
    if (!anyTrim && s.trim !== null && !wantTrims.has(norm(s.trim))) {
      reasons.push(`trim "${s.trim}" not in {${[...wantTrims].join(", ")}}`);
    }
    if (s.drivetrain !== null && norm(s.drivetrain) !== wantDrivetrain) {
      reasons.push(`drivetrain "${s.drivetrain}" != "${cfg.target.drivetrain}"`);
    }
    if (s.mileage !== null && s.mileage >= cfg.maxMileage) {
      reasons.push(`mileage ${s.mileage} >= max ${cfg.maxMileage}`);
    }
    // Optional price ceiling (config.maxPrice) — over-budget cars are rejected.
    if (cfg.maxPrice != null && s.price !== null && s.price > cfg.maxPrice) {
      reasons.push(`price ${s.price} > max ${cfg.maxPrice}`);
    }
    // A null color is NOT a reject — same permissive rule as trim/drivetrain.
    if (
      wantColors.length > 0 &&
      s.exteriorColor != null &&
      !wantColors.some((w) => norm(s.exteriorColor).includes(w))
    ) {
      reasons.push(`exterior color "${s.exteriorColor}" not in {${cfg.exteriorColors?.join(", ")}}`);
    }
    if (s.serviceIssueFlag) {
      reasons.push("service issue flagged in history");
    }

    if (reasons.length > 0) {
      rejected.push({ snapshot: s, reason: reasons.join("; ") });
      continue;
    }

    // OWNER COUNT and ACCIDENT/TITLE are MarketCheck-relayed CarFax flags that have
    // proven UNRELIABLE in BOTH directions (it has under-confirmed clean titles AND
    // mis-flagged a genuine 1-owner car as 2-owner). So we NEVER hard-reject on
    // them — a car is only "buyable" when owner is positively confirmed (== target,
    // OR ownersAny=true => owner ignored) AND the accident/title is clean
    // (none/minor). Anything short of that goes to verify-by-hand, not the reject
    // pile.
    const ownerConfirmed = cfg.ownersAny ? true : s.ownerCount === cfg.owners;
    const accidentClean = ACCIDENT_OK.has(s.accidentSeverity); // none / minor

    if (ownerConfirmed && accidentClean) {
      passed.push(s); // owner ok + clean title -> buyable
    } else if (s.accidentSeverity === "major") {
      // An explicitly-reported major accident (from a real history report, e.g. a
      // scraped source) is concrete enough to reject. MarketCheck never emits this.
      rejected.push({
        snapshot: s,
        reason: `accident_severity "${s.accidentSeverity}" not in {none, minor}`,
      });
    } else {
      // Owner not positively confirmed (null / 2+) OR title/accident unconfirmed
      // ("unknown"). Route to verify-by-hand. PO hand-check shortcut
      // (config.verifiedClean): a VIN the PO has personally cleared via the dealer
      // report is promoted straight to buyable with their note. Reached only after
      // every reliable hard filter already passed.
      const note = s.vin ? verifiedCleanMap[s.vin.toUpperCase()] : undefined;
      if (note !== undefined) {
        passed.push({ ...s, handVerified: note });
      } else {
        unverified.push(s);
      }
    }
  }

  return { passed, unverified, rejected };
}

/**
 * Dedupe by VIN. Among snapshots sharing a VIN (possibly cross-source), keep
 * the one with the lowest price as canonical; the rest become `alternates`.
 * Snapshots with a null VIN are treated as individually distinct (cannot be
 * deduped) and returned as their own canonical entries with no alternates.
 */
export function dedupeByVin(snapshots: ListingSnapshot[]): Array<{
  canonical: ListingSnapshot;
  alternates: ListingSnapshot[];
}> {
  const byVin = new Map<string, ListingSnapshot[]>();
  const noVin: ListingSnapshot[] = [];

  for (const s of snapshots) {
    if (!s.vin) {
      noVin.push(s);
      continue;
    }
    const key = s.vin.toLowerCase();
    const arr = byVin.get(key);
    if (arr) arr.push(s);
    else byVin.set(key, [s]);
  }

  const out: Array<{ canonical: ListingSnapshot; alternates: ListingSnapshot[] }> = [];

  for (const arr of byVin.values()) {
    const sorted = [...arr].sort((a, b) => priceForSort(a) - priceForSort(b));
    const [canonical, ...alternates] = sorted;
    out.push({ canonical: canonical as ListingSnapshot, alternates });
  }
  for (const s of noVin) {
    out.push({ canonical: s, alternates: [] });
  }
  return out;
}

/** Null price sorts last (treated as +Infinity). */
function priceForSort(s: ListingSnapshot): number {
  return s.price ?? Number.POSITIVE_INFINITY;
}

/**
 * Rank canonical snapshots by landed price ascending. Null landed price sorts
 * last. Ties are broken by lower listing price, then by VIN for determinism.
 */
export function rankByLandedPriceAsc(snapshots: ListingSnapshot[]): ListingSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const la = a.landedPrice ?? Number.POSITIVE_INFINITY;
    const lb = b.landedPrice ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    const pa = a.price ?? Number.POSITIVE_INFINITY;
    const pb = b.price ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return (a.vin ?? "").localeCompare(b.vin ?? "");
  });
}
