import type { Config } from "./config.js";
import type { ListingSnapshot, ListingCard, HistoryCapture } from "./lib/types.js";
import { Store } from "./store/store.js";
import { discoverAdapters, enabledAdapters } from "./collector/registry.js";
import { openSourceContext } from "./collector/context.js";
import { filtersForTarget } from "./collector/adapter.js";
import { decodeDrivetrains, NHTSA_HOST } from "./collector/nhtsa.js";
import { analyze } from "./analyst/analyst.js";
import { diffRuns } from "./analyst/changes.js";
import { buildReports, writeReports } from "./reporter/reporter.js";

/**
 * Orchestrator. Wires the whole run: load config -> open store/new
 * run -> for each ENABLED adapter (MarketCheck only): search +
 * captureHistory on badge-passing cards -> store snapshots -> analyst -> reporter.
 *
 * Headful + pause-for-captcha are wired in the collector layer the adapters use.
 * Per-source failures are ISOLATED (one source breaking doesn't kill the run);
 * each failure is collected and reported, not swallowed.
 *
 * The CLI (`npm run search`) is the entry point; a wrapper command
 * slash-command is a thin wrapper over runSearch() in a follow-up.
 */

export interface RunSummary {
  runId: number;
  sourcesRan: string[];
  sourcesFailed: Array<{ source: string; error: string }>;
  totalSeen: number;
  buyableCount: number;
  unverifiedCount: number;
  rejectedCount: number;
  ruledOutCount: number;
  top3: Array<{ vin: string; landed: number | null; dealer: string | null }>;
  changes: { isBaseline: boolean; added: number; priceDrops: number; gone: number };
  outPaths: string[];
  copyPaths: string[];
}

export async function runSearch(cfg: Config): Promise<RunSummary> {
  const store = Store.init(cfg.paths.dbFile);
  const sourcesFailed: Array<{ source: string; error: string }> = [];
  const sourcesRan: string[] = [];

  try {
    const all = await discoverAdapters();
    const active = enabledAdapters(all, cfg.sources);
    const sourceSet = active.map((a) => a.name).join(",") || "(none)";
    const run = store.insertRun(sourceSet);
    // Multi-vehicle: query the primary target + any extraTargets, merge results.
    const targets = [cfg.target, ...(cfg.extraTargets ?? [])];

    for (const adapter of active) {
      try {
        // HTTP/API adapters (usesBrowser=false, the source design MarketCheck) skip the
        // Chromium launch; browser-backed scrapers default to true.
        const { ctx, close } = await openSourceContext(
          adapter.name,
          cfg,
          adapter.usesBrowser ?? true,
        );
        try {
          const cards: ListingCard[] = [];
          for (const t of targets) {
            const tc = await adapter.search(ctx, filtersForTarget(t, cfg));
            cards.push(...tc);
          }
          // Authoritative drivetrain cross-check (NHTSA vPIC): correct the source's
          // unreliable drivetrain field before filtering, so an AWD car the feed
          // mislabels "RWD" is not wrongly rejected. One paced batch call; soft-fails
          // to the source value if vPIC is unreachable (decodeDrivetrains returns []).
          try {
            await ctx.pacer.beforeNavigate(NHTSA_HOST);
            const driveByVin = await decodeDrivetrains(cards.map((c) => c.vin));
            for (const card of cards) {
              const d = card.vin ? driveByVin.get(card.vin.toUpperCase()) : undefined;
              if (d) card.drivetrain = d; // NHTSA wins when it has a definitive answer
            }
          } catch (err) {
            console.warn(`[orchestrator] NHTSA drivetrain check skipped: ${(err as Error).message}`);
          }
          for (const card of cards) {
            if (!card.vin) continue; // can't snapshot without a VIN key
            let history: HistoryCapture = {
              ownerCount: null,
              accidentSeverity: "unknown",
              serviceIssueFlag: false,
              historyStatus: "unverified",
            };
            if (adapter.captureHistory) {
              history = await adapter.captureHistory(ctx, card).catch(() => history);
            }
            store.upsertListing(cardToSnapshot(card, history, run.id, adapter.name));
          }
          sourcesRan.push(adapter.name);
        } finally {
          await close();
        }
      } catch (err) {
        sourcesFailed.push({ source: adapter.name, error: (err as Error).message });
        console.warn(`[orchestrator] source "${adapter.name}" failed: ${(err as Error).message}`);
      }
    }

    // Analyst over this run's raw snapshots.
    const rawSnapshots = store.getListingsForRun(run.id);
    const result = analyze(rawSnapshots, cfg);

    // Diff canonical current vs previous run's canonical. PO ruled-out VINs are
    // filtered from BOTH sides so a NO-GO car never shows up as NEW/DROP/GONE
    // noise (e.g. a branded car cutting its price is irrelevant to the PO).
    const ruledVins = new Set(
      Object.keys(cfg.ruledOut ?? {}).map((v) => v.toUpperCase()),
    );
    const notRuled = (s: ListingSnapshot): boolean =>
      !(s.vin && ruledVins.has(s.vin.toUpperCase()));
    const prevRun = store.getPreviousRun(run.id);
    const currentCanonical = store.getCanonicalListingsForRun(run.id).filter(notRuled);
    const prevCanonical = prevRun
      ? store.getCanonicalListingsForRun(prevRun.id).filter(notRuled)
      : null;
    const diff = diffRuns(currentCanonical, prevCanonical);

    // Reporter.
    const files = buildReports(result, diff, cfg);
    const written = writeReports(files, cfg);

    store.finishRun(run.id);

    return {
      runId: run.id,
      sourcesRan,
      sourcesFailed,
      totalSeen: rawSnapshots.length,
      buyableCount: result.buyable.length,
      unverifiedCount: result.unverified.length,
      rejectedCount: result.rejected.length,
      ruledOutCount: result.ruledOut.length,
      top3: result.buyable.slice(0, 3).map((r) => ({
        vin: r.vin,
        landed: r.landedPrice,
        dealer: r.dealer,
      })),
      changes: {
        isBaseline: diff.isBaselineRun,
        added: diff.added.length,
        priceDrops: diff.priceDrops.length,
        gone: diff.gone.length,
      },
      outPaths: written.outPaths,
      copyPaths: written.copyPaths,
    };
  } finally {
    store.close();
  }
}

/** Map a collected card + parsed history into a persistable snapshot. */
export function cardToSnapshot(
  card: ListingCard,
  history: HistoryCapture,
  runId: number,
  source: string,
): ListingSnapshot {
  return {
    vin: card.vin as string,
    runId,
    source,
    make: card.make ?? null,
    model: card.model ?? null,
    year: card.year ?? null,
    price: card.price,
    mileage: card.mileage,
    dealer: card.dealer,
    location: card.location,
    zip: card.zip,
    drivetrain: card.drivetrain,
    trim: card.trim,
    url: card.url,
    exteriorColor: card.exteriorColor ?? null,
    ownerCount: history.ownerCount,
    accidentSeverity: history.accidentSeverity,
    serviceIssueFlag: history.serviceIssueFlag,
    historyStatus: history.historyStatus,
    // landed-cost fields are computed by the analyst; null at capture time.
    shippingEst: null,
    distanceMi: null,
    landedPrice: null,
    capturedAt: new Date().toISOString(),
    // Manual-check marker. Travels in-memory only — the
    // store has no column for it; the reporter reads it off the ranked row.
    ...(card.serviceHistory !== undefined ? { serviceHistory: card.serviceHistory } : {}),
  };
}

export function formatSummary(s: RunSummary): string {
  const lines: string[] = [];
  lines.push(`Vehicle Price Search — run #${s.runId}`);
  lines.push(`Sources ran: ${s.sourcesRan.join(", ") || "(none)"}`);
  if (s.sourcesFailed.length > 0) {
    lines.push(
      `Sources FAILED: ${s.sourcesFailed.map((f) => `${f.source} (${f.error})`).join("; ")}`,
    );
  }
  lines.push(`Listings seen: ${s.totalSeen}`);
  lines.push(`Buyable after filters: ${s.buyableCount}`);
  lines.push(`History unverified: ${s.unverifiedCount}`);
  lines.push(`Rejected: ${s.rejectedCount}`);
  if (s.ruledOutCount > 0) {
    lines.push(`Ruled out by you: ${s.ruledOutCount}`);
  }
  if (s.top3.length > 0) {
    lines.push("Top 3 by landed price:");
    for (const t of s.top3) {
      lines.push(`  - ${t.vin} · ${t.landed === null ? "?" : `$${t.landed.toLocaleString()}`} · ${t.dealer ?? "?"}`);
    }
  }
  if (s.changes.isBaseline) {
    lines.push("Changes: baseline run — no prior run to diff");
  } else {
    lines.push(
      `Changes: NEW ${s.changes.added} · PRICE DROP ${s.changes.priceDrops} · GONE ${s.changes.gone}`,
    );
  }
  lines.push(`Output: ${s.outPaths.join(", ")}`);
  lines.push(`Copies: ${s.copyPaths.join(", ")}`);
  return lines.join("\n");
}
