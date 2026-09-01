import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ListingSnapshot,
  RunRecord,
  AccidentSeverity,
  HistoryStatus,
} from "../lib/types.js";

/**
 * node:sqlite is a newer Node built-in. We load it via
 * process.getBuiltinModule (Node 22.3+/24) instead of a static
 * `import ... from "node:sqlite"` so bundler/test-runner module transforms
 * (Vite/Vitest) don't try to resolve it as an npm package. This is the
 * documented "node:sqlite via built-in" approach; no native compile step,
 * no better-sqlite3 fallback was needed.
 */
type DatabaseSyncCtor = new (path: string) => DatabaseSyncInstance;
interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

const sqliteModule = process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: DatabaseSyncCtor;
};
const DatabaseSync = sqliteModule.DatabaseSync;
type DatabaseSync = DatabaseSyncInstance;

/**
 * Store layer.
 *
 * Uses Node's built-in node:sqlite (DatabaseSync) — verified working on Node
 * 24.15.0, no native compile step. Fallback to better-sqlite3 was NOT needed.
 *
 * SECURITY (the security notes PII-minimization):
 *   - The schema stores ONLY the minimal filtered history fields
 *     (owner_count, accident_severity, service_issue_flag, history_status).
 *   - There is NO column for raw CarFax/AutoCheck report bodies, prior-owner
 *     names, or addresses. Any full report text is transient (handled in the
 *     collector, discarded after parse) and never reaches this layer.
 *   - All writes are parameterized (prepared statements) — no string-built SQL.
 *   - The DB file lives under C:\dev (outside OneDrive). init() will refuse a
 *     path that points inside OneDrive.
 */

const ACCIDENT_VALUES: AccidentSeverity[] = ["none", "minor", "major", "unknown"];
const HISTORY_VALUES: HistoryStatus[] = ["verified", "unverified"];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  source_set  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES runs(id),
  vin               TEXT NOT NULL,
  source            TEXT NOT NULL,
  make              TEXT,
  model             TEXT,
  year              INTEGER,
  price             REAL,
  mileage           INTEGER,
  dealer            TEXT,
  location          TEXT,
  zip               TEXT,
  drivetrain        TEXT,
  trim              TEXT,
  url               TEXT,
  exterior_color    TEXT,
  owner_count       INTEGER,
  accident_severity TEXT NOT NULL CHECK (accident_severity IN ('none','minor','major','unknown')),
  service_issue_flag INTEGER NOT NULL CHECK (service_issue_flag IN (0,1)),
  history_status    TEXT NOT NULL CHECK (history_status IN ('verified','unverified')),
  shipping_est      REAL,
  distance_mi       INTEGER,
  landed_price      REAL,
  captured_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_run ON listings(run_id);
CREATE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin);
`;

export class Store {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Open (creating if needed) the SQLite store and run idempotent migrations.
   * Refuses any path inside OneDrive (the security notes).
   */
  static init(dbFile: string): Store {
    if (/onedrive/i.test(dbFile)) {
      throw new Error(
        `Refusing to open DB inside OneDrive: "${dbFile}". The store must live under C:\\dev (the security notes).`,
      );
    }
    mkdirSync(dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
    migrate(db);
    return new Store(db);
  }

  /** In-memory store for tests. */
  static memory(): Store {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA_SQL);
    migrate(db);
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a new run and return its id + started_at. */
  insertRun(sourceSet: string): RunRecord {
    if (!sourceSet || typeof sourceSet !== "string") {
      throw new Error("insertRun: sourceSet is required (non-empty string)");
    }
    const startedAt = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO runs (started_at, source_set) VALUES (?, ?)",
    );
    const info = stmt.run(startedAt, sourceSet);
    return { id: Number(info.lastInsertRowid), startedAt, sourceSet };
  }

  finishRun(runId: number): void {
    this.db
      .prepare("UPDATE runs SET finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), runId);
  }

  getPreviousRun(beforeRunId: number): RunRecord | null {
    // Return the most recent EARLIER run that actually stored listings. Skipping
    // empty runs is deliberate: a transient/failed run (it created a run row but
    // crashed before storing any listing) must NOT become the diff baseline —
    // otherwise the next run mis-reports as "baseline" and the run after diffs
    // against an empty set (everything looks NEW). Diff only ever compares two
    // real, populated runs.
    const row = this.db
      .prepare(
        `SELECT r.id, r.started_at, r.source_set
           FROM runs r
          WHERE r.id < ?
            AND EXISTS (SELECT 1 FROM listings l WHERE l.run_id = r.id)
          ORDER BY r.id DESC
          LIMIT 1`,
      )
      .get(beforeRunId) as
      | { id: number; started_at: string; source_set: string }
      | undefined;
    if (!row) return null;
    return { id: row.id, startedAt: row.started_at, sourceSet: row.source_set };
  }

  /**
   * Insert a listing snapshot. Validates required fields and uses a
   * parameterized statement. Throws a clear error on a malformed/missing
   * required field rather than writing garbage.
   */
  upsertListing(s: ListingSnapshot): void {
    this.validateSnapshot(s);
    this.db
      .prepare(
        `INSERT INTO listings
          (run_id, vin, source, make, model, year, price, mileage, dealer, location, zip, drivetrain, trim, url,
           exterior_color, owner_count, accident_severity, service_issue_flag, history_status,
           shipping_est, distance_mi, landed_price, captured_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.runId,
        s.vin,
        s.source,
        s.make ?? null,
        s.model ?? null,
        s.year ?? null,
        s.price,
        s.mileage,
        s.dealer,
        s.location,
        s.zip,
        s.drivetrain,
        s.trim,
        s.url,
        s.exteriorColor ?? null,
        s.ownerCount,
        s.accidentSeverity,
        s.serviceIssueFlag ? 1 : 0,
        s.historyStatus,
        s.shippingEst,
        s.distanceMi,
        s.landedPrice,
        s.capturedAt,
      );
  }

  /** All raw snapshots for a run (no dedupe). */
  getListingsForRun(runId: number): ListingSnapshot[] {
    const rows = this.db
      .prepare("SELECT * FROM listings WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as Record<string, unknown>[];
    return rows.map(rowToSnapshot);
  }

  /**
   * Canonical (deduped) snapshots for a run — lowest price per VIN wins. Uses a
   * correlated subquery to pick the min-price row per VIN within the run.
   */
  getCanonicalListingsForRun(runId: number): ListingSnapshot[] {
    const all = this.getListingsForRun(runId);
    const byVin = new Map<string, ListingSnapshot>();
    for (const s of all) {
      const key = s.vin.toLowerCase();
      const existing = byVin.get(key);
      if (!existing) {
        byVin.set(key, s);
      } else {
        const cur = s.price ?? Number.POSITIVE_INFINITY;
        const prev = existing.price ?? Number.POSITIVE_INFINITY;
        if (cur < prev) byVin.set(key, s);
      }
    }
    return [...byVin.values()];
  }

  /** Full snapshot history for a VIN across all runs (newest run first). */
  getListingHistoryByVin(vin: string): ListingSnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM listings WHERE LOWER(vin) = LOWER(?) ORDER BY run_id DESC, id DESC",
      )
      .all(vin) as Record<string, unknown>[];
    return rows.map(rowToSnapshot);
  }

  private validateSnapshot(s: ListingSnapshot): void {
    if (!Number.isInteger(s.runId)) {
      throw new Error("upsertListing: runId must be an integer");
    }
    if (!s.vin || typeof s.vin !== "string") {
      throw new Error("upsertListing: vin is required (non-empty string)");
    }
    if (!s.source || typeof s.source !== "string") {
      throw new Error("upsertListing: source is required (non-empty string)");
    }
    if (!ACCIDENT_VALUES.includes(s.accidentSeverity)) {
      throw new Error(
        `upsertListing: accidentSeverity "${s.accidentSeverity}" not in ${ACCIDENT_VALUES.join("/")}`,
      );
    }
    if (!HISTORY_VALUES.includes(s.historyStatus)) {
      throw new Error(
        `upsertListing: historyStatus "${s.historyStatus}" not in ${HISTORY_VALUES.join("/")}`,
      );
    }
    if (typeof s.serviceIssueFlag !== "boolean") {
      throw new Error("upsertListing: serviceIssueFlag must be a boolean");
    }
    if (!s.capturedAt || typeof s.capturedAt !== "string") {
      throw new Error("upsertListing: capturedAt is required (ISO string)");
    }
  }
}

/**
 * Idempotent column migrations for DBs created before a column existed. Fresh
 * DBs already have every column from SCHEMA_SQL, so each guard is a no-op there;
 * an older database (pre-exterior_color) gets the column added in place. Uses
 * PRAGMA table_info so we never double-add (which would throw).
 */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("exterior_color")) {
    db.exec("ALTER TABLE listings ADD COLUMN exterior_color TEXT");
  }
  if (!have.has("make")) db.exec("ALTER TABLE listings ADD COLUMN make TEXT");
  if (!have.has("model")) db.exec("ALTER TABLE listings ADD COLUMN model TEXT");
  if (!have.has("year")) db.exec("ALTER TABLE listings ADD COLUMN year INTEGER");
}

function rowToSnapshot(r: Record<string, unknown>): ListingSnapshot {
  return {
    runId: Number(r.run_id),
    vin: String(r.vin),
    source: String(r.source),
    make: r.make === null || r.make === undefined ? null : String(r.make),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    year: r.year === null || r.year === undefined ? null : Number(r.year),
    price: r.price === null ? null : Number(r.price),
    mileage: r.mileage === null ? null : Number(r.mileage),
    dealer: r.dealer === null ? null : String(r.dealer),
    location: r.location === null ? null : String(r.location),
    zip: r.zip === null ? null : String(r.zip),
    drivetrain: r.drivetrain === null ? null : String(r.drivetrain),
    trim: r.trim === null ? null : String(r.trim),
    url: r.url === null ? null : String(r.url),
    exteriorColor:
      r.exterior_color === null || r.exterior_color === undefined
        ? null
        : String(r.exterior_color),
    ownerCount: r.owner_count === null ? null : Number(r.owner_count),
    accidentSeverity: String(r.accident_severity) as AccidentSeverity,
    serviceIssueFlag: Number(r.service_issue_flag) === 1,
    historyStatus: String(r.history_status) as HistoryStatus,
    shippingEst: r.shipping_est === null ? null : Number(r.shipping_est),
    distanceMi: r.distance_mi === null ? null : Number(r.distance_mi),
    landedPrice: r.landed_price === null ? null : Number(r.landed_price),
    capturedAt: String(r.captured_at),
  };
}
