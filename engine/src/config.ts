import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Typed config loader for Vehicle Price Search.
 *
 * Source of truth is config.json at the app root. We parse it through a zod
 * schema so a missing / malformed field produces a clear, field-named error
 * instead of a raw stack trace, and downstream code consumes a fully-typed
 * `Config` object. Config is read at RUNTIME (no values are hardcoded into the
 * pipeline) so tuning maxMileage / sources / bands etc. needs no code change.
 */

const accidentSeverityValues = ["none", "minor", "major", "unknown"] as const;

const TargetSchema = z.object({
  year: z.number().int(),
  make: z.string().min(1),
  model: z.string().min(1),
  trim: z.string().min(1),
  drivetrain: z.string().min(1),
  /** Optional fuel_type facet (e.g. "Electric"). Needed when the model name spans
   * HEV/PHEV/BEV (Kia "Niro") and only the BEV is wanted. Omit when the model name
   * is already EV-specific (Chevy "Equinox EV"). */
  fuelType: z.string().optional(),
  /** Per-target exterior colors, overriding the run-level `exteriorColors` for
   * THIS target only. Needed when a color exists in one model year but not
   * another: the 2026 Grand Cherokee L comes in Silver and the 2027 does not,
   * while the 2027's gray is Sting-Gray and the 2026's is Baltic Gray. Without
   * this, one global list either drops a year or floods the ranking with a
   * color that was only wanted for the other year. Omit => use the run-level
   * list (or no color filter at all). */
  exteriorColors: z.array(z.string().min(1)).min(1).optional(),
});

const SourceSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

const ShippingBandSchema = z.object({
  // `maxDistanceMi: null` means "no upper bound" — the catch-all top band.
  maxDistanceMi: z.number().positive().nullable(),
  cost: z.number().nonnegative(),
});

const FinancingTermSchema = z.object({
  apr: z.number().nonnegative(),
  months: z.number().int().positive(),
});

const PacingSchema = z.object({
  minActionDelayMs: z.number().int().nonnegative(),
  maxActionDelayMs: z.number().int().nonnegative(),
  perDomainMinIntervalMs: z.number().int().nonnegative(),
});

/**
 * An http(s)-only URL. Used wherever a config value renders as an href on the
 * public page (urlOverrides, pinnedListings.url). `.url()` alone accepts
 * `javascript:`/`data:`, so the protocol refine is the operative guard against
 * href injection.
 */
const HttpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:$/i.test(new URL(u).protocol), {
    message: "must be an http(s) URL (no javascript:/data:/etc.)",
  });

const PathsSchema = z.object({
  dbFile: z.string().min(1),
  profilesDir: z.string().min(1),
  outDir: z.string().min(1),
  scratchDir: z.string().min(1),
  resultsCopyDir: z.string().min(1),
});

/** Folders whose sync clients lock files mid-write — unsafe for a live DB. */
const CLOUD_SYNC_DIR = /onedrive|dropbox|google drive|googledrive|icloud|box sync/i;

export const ConfigSchema = z
  .object({
    target: TargetSchema,
    /** Additional vehicles to query in the SAME run (multi-vehicle search). Each
     * is queried by its own make/model/year/(fuelType); results merge into one
     * ranked list. The hard filter's trim/drivetrain come from `target` (shared),
     * so multi-vehicle works cleanly when all targets share trim="*" + drivetrain. */
    extraTargets: z.array(TargetSchema).optional(),
    maxMileage: z.number().int().positive(),
    owners: z.number().int().positive(),
    /** Optional max LISTING price (USD). Cars over this are rejected, and the
     * MarketCheck query is price-capped server-side (price_range). Omit = no cap. */
    maxPrice: z.number().positive().optional(),
    /** When true, owner count does NOT gate "buyable" — any owner passes as long
     * as title is clean + accident in {none,minor}. Omit/false = owner == owners. */
    ownersAny: z.boolean().optional(),
    /** MarketCheck `car_type` passes to run — one query pass per value. Omit =>
     * ["used","certified"]. A NEW-car search (e.g. a
     * current-model-year Jeep, where 98% of live inventory is new) sets
     * ["new","used","certified"]; without "new" the run sees a rounding error of
     * the real market. */
    carTypes: z.array(z.enum(["new", "used", "certified"])).min(1).optional(),
    /** Optional MINIMUM listing price (USD) — server-side price_range floor.
     * Its real job is excluding "call for price" listings (price absent), which
     * sort FIRST under price-ascending and would otherwise consume the API's
     * 500-row result window with cars that carry no price to rank on. Omit =>
     * no floor (back-compat). */
    minPrice: z.number().nonnegative().optional(),
    /** Send `drivetrain` as a server-side facet instead of pulling every
     * drivetrain and letting the NHTSA VIN decode sort it out downstream.
     * Default (omit/false) is the original permissive behavior, which exists
     * because MarketCheck mislabels some AWD cars. Turn it ON only for a
     * high-volume search where the API's 500-row window matters: on the 2026
     * Grand Cherokee L, 38 of the 50 cheapest listings are RWD, so pulling
     * unfiltered burns most of the window on cars the hard filter rejects.
     * NHTSA still cross-checks whatever comes back. */
    useDrivetrainFacet: z.boolean().optional(),
    /** Restrict to these NORMALIZED exterior colors (MarketCheck's
     * `base_ext_color` bucket: Silver, Gray, White, Black, Blue, Red, Gold...).
     * Use the bucket, not the marketing name — one bucket spans many of those
     * ("Silver" covers "Silver Zynith", "SILVER ZYNITH", "Silver Zynith - Silver").
     * Note Gray is a SEPARATE bucket from Silver. Sent as a server-side facet so
     * the API's 500-row window fills with the requested color, and re-checked in
     * the hard filter. Omit => any color. */
    exteriorColors: z.array(z.string().min(1)).min(1).optional(),
    /** Keep listings whose mileage the feed does not report. MarketCheck's
     * `miles_range` filter drops any listing with no `miles` field, which on a
     * NEW-car search silently deletes real inventory — on the 2026 Grand
     * Cherokee L it hid 32 silver cars including the cheapest in the country,
     * ~$2,000 under the visible floor. The hard filter already ignores a null
     * mileage, so turning this on just stops the SERVER pre-filtering them out;
     * maxMileage is still enforced locally on every car that reports a number.
     * Omit/false => original behavior (server-side miles_range). */
    allowUnknownMileage: z.boolean().optional(),
    /** Optional cap on how many ranked rows the HTML report renders (cheapest
     * landed first). The CSV always carries every car. Omit => render all
     * (back-compat). Needed for high-volume new-car searches where the raw result
     * set is thousands of near-identical units. */
    reportTopN: z.number().int().positive().optional(),
    /** Optional report/title label. Omit => "Vehicle Price Search" (back-compat). */
    title: z.string().optional(),
    /** Optional fee/tax disclaimer line rendered under the report header (md + html).
     * Landed price = listing + estimated shipping only; this clarifies that dealer
     * doc/filing fees + taxes are NOT included. Omit = no line (back-compat). */
    feeDisclaimer: z.string().optional(),
    accidentsAllowed: z.enum(["none", "minor"]),
    homeZip: z.string().regex(/^\d{5}$/, "homeZip must be a 5-digit ZIP code"),
    referenceVin: z.string().min(11),
    sources: z.array(SourceSchema).min(1),
    shippingBands: z.array(ShippingBandSchema).min(1),
    financing: z.array(FinancingTermSchema).min(1),
    /**
     * Optional per-VIN firm shipping cost (USD). When a VIN is listed here, the
     * analyst uses this exact amount instead of the distance-band estimate and
     * marks the row's shipping "firm". Key = uppercase VIN. Empty by default.
     */
    shippingOverrides: z.record(z.string(), z.number().nonnegative()).optional(),
    /**
     * Per-VIN listing-URL override. Key = uppercase VIN, value = the exact VDP /
     * checkout URL the PO wants that car's VIN link (and CSV url) to point at —
     * e.g. a dealer's express-checkout page the MarketCheck feed doesn't carry.
     * Overrides the data-source URL for that VIN and survives every re-run.
     * SECURITY: the value renders as an href on the public page, so it is
     * scheme-allowlisted to http(s) only (a javascript:/data: URL is rejected at
     * config load). Empty by default.
     */
    urlOverrides: z.record(z.string(), HttpUrl).optional(),
    /**
     * Per-VIN accident-severity correction. Key = uppercase VIN, value = the
     * severity the PO confirmed from the actual dealer history report (e.g.
     * "minor" for a repaired fender-bender). Overrides the data source's value —
     * which is often only "unknown" because MarketCheck can't positively confirm
     * the title. With accidentsAllowed="minor", correcting unknown -> minor lets a
     * PO-verified car pass into buyable AND shows the true "minor" in the report
     * (not a false "clean"). Enum-constrained (none/minor/major/unknown). Empty by
     * default.
     */
    accidentOverrides: z.record(z.string(), z.enum(accidentSeverityValues)).optional(),
    /**
     * PO-pinned manual listings the feed doesn't surface — e.g. a car the
     * MarketCheck facet search excludes (wrong drivetrain label, off-facet trim)
     * that the PO still wants in the comparison. Key = uppercase VIN; the value
     * carries the listing fields (retrieved by Pilot) so the car ranks alongside
     * the feed results. `note` renders in the Service-history column (use it to
     * flag why it was pinned / what to verify). `url` is http(s)-allowlisted.
     * Injected at analysis time ONLY — pinned cars do NOT enter the store or the
     * NEW/GONE diff (config-driven, not feed-driven). Empty by default.
     */
    pinnedListings: z
      .record(
        z.string(),
        z.object({
          price: z.number().nonnegative().nullable().optional(),
          mileage: z.number().nonnegative().nullable().optional(),
          dealer: z.string().nullable().optional(),
          location: z.string().nullable().optional(),
          zip: z.string().nullable().optional(),
          drivetrain: z.string().nullable().optional(),
          trim: z.string().nullable().optional(),
          url: HttpUrl.nullable().optional(),
          exteriorColor: z.string().nullable().optional(),
          ownerCount: z.number().int().nullable().optional(),
          accidentSeverity: z.enum(accidentSeverityValues).optional(),
          note: z.string().optional(),
        }),
      )
      .optional(),
    /**
     * Per-VIN "ruled out by you" memory. Key = uppercase VIN, value = the PO's
     * reason (branded title, sold, didn't like it, etc.). A ruled-out VIN is
     * pulled out of the run BEFORE filtering/ranking/diff and shown in its own
     * "Ruled out by you" section — it never re-surfaces in buyable /
     * verify-by-hand / rejected / changes. Empty by default.
     */
    ruledOut: z.record(z.string(), z.string()).optional(),
    /**
     * Per-VIN "hand-verified clean" memory. Key = uppercase VIN, value = the
     * PO's note (e.g. "Hand-checked 2026-06-21: 1-owner, clean title, CPO").
     * When a car would otherwise route to "verify by hand" because the data
     * source can't positively confirm its title/accident (accidentSeverity
     * "unknown"), listing its VIN here promotes it into the buyable list and
     * records the note. It ONLY promotes a car that already passes every other
     * hard filter (owner/mileage/trim) — it never overrides those. Empty by
     * default.
     * SECURITY: the note is PO free-text rendered (HTML-escaped) in the md/html
     * reports and kept OUT of the CSV — it must stay note-level (no
     * names/plates/phone/email/address), same rule as ruledOut reasons.
     */
    verifiedClean: z.record(z.string(), z.string()).optional(),
    pacing: PacingSchema,
    paths: PathsSchema,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.pacing.maxActionDelayMs < cfg.pacing.minActionDelayMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pacing", "maxActionDelayMs"],
        message: "pacing.maxActionDelayMs must be >= pacing.minActionDelayMs",
      });
    }
    // Exactly one catch-all (null) band, and it should be last.
    const nullBands = cfg.shippingBands.filter((b) => b.maxDistanceMi === null);
    if (nullBands.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shippingBands"],
        message:
          "shippingBands must contain exactly one catch-all band with maxDistanceMi: null",
      });
    }
    // No WORKING path may sit in a cloud-synced folder — sync locks the SQLite
    // file mid-run and can corrupt it. The results COPY target is exempt: that is
    // the whole point of it, and it only ever receives finished artifacts.
    for (const key of ["dbFile", "profilesDir", "outDir", "scratchDir"] as const) {
      if (CLOUD_SYNC_DIR.test(cfg.paths[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paths", key],
          message: `paths.${key} must NOT point inside OneDrive (working data lives under C:\\dev) — see the security notes in README`,
        });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;
export type ShippingBand = z.infer<typeof ShippingBandSchema>;
export type FinancingTerm = z.infer<typeof FinancingTermSchema>;
export type AccidentSeverity = (typeof accidentSeverityValues)[number];

/** Resolve the default config.json path relative to this module (app root). */
export function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> app root
  return join(here, "..", "config.json");
}

/**
 * Load + validate config from a JSON file. On a schema violation, throws an
 * Error whose message names the offending field(s) — never a raw zod dump.
 */
export function loadConfig(path: string = defaultConfigPath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Config file not found or unreadable at "${path}": ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Config file at "${path}" is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${field}: ${issue.message}`;
    });
    throw new Error(
      `Config validation failed for "${path}":\n${lines.join("\n")}`,
    );
  }
  return result.data;
}
