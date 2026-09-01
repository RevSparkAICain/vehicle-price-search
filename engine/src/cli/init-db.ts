import { loadConfig } from "../config.js";
import { Store } from "../store/store.js";

/**
 * `npm run init-db` — create/migrate the SQLite store. Idempotent:
 * opening an existing DB appends, never wipes.
 */
function main(): void {
  const cfg = loadConfig(process.env.SEARCH_CONFIG);
  const store = Store.init(cfg.paths.dbFile);
  store.close();
  console.log(`Initialized / migrated SQLite store at: ${cfg.paths.dbFile}`);
}

main();
