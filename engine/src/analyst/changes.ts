import type { ListingSnapshot, ChangesDiff } from "../lib/types.js";

/**
 * Pure run-over-run diff. Compares the current run's
 * canonical snapshots against the previous run's canonical snapshots, keyed by
 * VIN, and returns NEW / PRICE DROP / GONE sets.
 *
 *   NEW        — VIN in current, not in previous
 *   PRICE DROP — VIN in both, current price < previous price
 *   GONE       — VIN in previous, not in current
 *
 * If there is no previous run (null/empty), this is the baseline run.
 */
export function diffRuns(
  current: ListingSnapshot[],
  previous: ListingSnapshot[] | null,
): ChangesDiff {
  if (previous === null || previous.length === 0) {
    return { isBaselineRun: true, added: [], priceDrops: [], gone: [] };
  }

  const currByVin = mapByVin(current);
  const prevByVin = mapByVin(previous);

  const added: ListingSnapshot[] = [];
  const priceDrops: ChangesDiff["priceDrops"] = [];
  const gone: ListingSnapshot[] = [];

  for (const [vin, cur] of currByVin) {
    const prev = prevByVin.get(vin);
    if (!prev) {
      added.push(cur);
    } else if (
      cur.price !== null &&
      prev.price !== null &&
      cur.price < prev.price
    ) {
      priceDrops.push({
        vin: cur.vin as string,
        oldPrice: prev.price,
        newPrice: cur.price,
        snapshot: cur,
      });
    }
  }

  for (const [vin, prev] of prevByVin) {
    if (!currByVin.has(vin)) gone.push(prev);
  }

  return { isBaselineRun: false, added, priceDrops, gone };
}

/** Index snapshots by lowercased VIN; null-VIN snapshots are skipped. */
function mapByVin(snapshots: ListingSnapshot[]): Map<string, ListingSnapshot> {
  const m = new Map<string, ListingSnapshot>();
  for (const s of snapshots) {
    if (!s.vin) continue;
    m.set(s.vin.toLowerCase(), s);
  }
  return m;
}
