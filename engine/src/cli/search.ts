import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { runSearch, formatSummary } from "../orchestrator.js";
import { readApiKeyOrThrow } from "../adapters/marketcheck.adapter.js";

/**
 * `npm run search` — the deliverable entrypoint.
 *
 * Runs the full collector -> analyst -> reporter pipeline. Per the source design the
 * collection layer is now the MarketCheck listings API (HTTP, no browser); the
 * 5 scraper adapters are dormant fallbacks (disabled in config + code).
 *
 * SECRET LOADING: the MarketCheck API key is read from .env at the app
 * root via Node 24's built-in process.loadEnvFile(). The key is NEVER hardcoded,
 * NEVER in config.json, NEVER logged. If it is missing we exit non-zero with a
 * pointer to .env.example and DO NOT touch the network.
 *
 * `--filters-only` runs the walking skeleton: load config, log the resolved
 * filters, and exit cleanly WITHOUT any network call. Use it to verify config
 * wiring without a live API call (it still validates the key is present).
 */

/** Load the app-root .env into process.env (Node 24 built-in). No-op if absent. */
function loadDotEnv(): void {
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // src/cli -> app
  const envPath = join(appRoot, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig(process.env.SEARCH_CONFIG);
  const filtersOnly = process.argv.includes("--filters-only");

  // Fail fast (and key-free) if the MarketCheck key is missing — before any
  // network call, even in --filters-only, so wiring problems surface early.
  readApiKeyOrThrow();

  console.log("Vehicle Price Search — resolved filters:");
  console.log(
    JSON.stringify(
      {
        target: cfg.target,
        maxMileage: cfg.maxMileage,
        owners: cfg.owners,
        accidentsAllowed: cfg.accidentsAllowed,
        homeZip: cfg.homeZip,
        referenceVin: cfg.referenceVin,
        sources: cfg.sources,
      },
      null,
      2,
    ),
  );

  if (filtersOnly) {
    console.log(
      "\n[--filters-only] config + API key validated; exiting (no network call made).",
    );
    return;
  }

  console.log("\nStarting MarketCheck API run...");
  const summary = await runSearch(cfg);
  console.log("\n" + formatSummary(summary));
}

main().catch((err) => {
  console.error(`\n[search] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
