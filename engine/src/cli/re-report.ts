import { loadConfig } from "../config.js";
import { Store } from "../store/store.js";
import { analyze } from "../analyst/analyst.js";
import { buildReports, writeReports } from "../reporter/reporter.js";
import { diffRuns } from "../analyst/changes.js";

/**
 * `npm run re-report` — re-render the reports from the LAST STORED run.
 *
 * No API calls and no re-search: it reads the run already in the database,
 * re-runs the analyst, and rewrites ranked.md / ranked.html / listings.csv.
 * Use it to see a reporter or config change (row caps, colors, filters) without
 * spending a full search — a wide search can take ten minutes and a few hundred
 * API calls.
 *
 * Read-only with respect to run history: it inserts NO run row, so the next
 * real search still diffs against the correct previous snapshot.
 */
function main(): void {
  const cfg = loadConfig(process.env.SEARCH_CONFIG);
  const store = Store.init(cfg.paths.dbFile);

  // "The run before an id larger than any real one" is the latest run.
  const last = store.getPreviousRun(Number.MAX_SAFE_INTEGER);
  if (!last) throw new Error("No stored run to re-render. Run `npm run search` first.");

  const snapshots = store.getListingsForRun(last.id);
  const result = analyze(snapshots, cfg);
  const prev = store.getPreviousRun(last.id);
  const diff = diffRuns(
    store.getCanonicalListingsForRun(last.id),
    prev ? store.getCanonicalListingsForRun(prev.id) : null,
  );

  writeReports(buildReports(result, diff, cfg), cfg);
  console.log(
    `Re-rendered run ${last.id}: ${snapshots.length} seen, ${result.buyable.length} buyable.`,
  );
}

try {
  main();
} catch (err) {
  console.error(`\n[re-report] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
}
