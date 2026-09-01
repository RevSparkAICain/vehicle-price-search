import type { ListingCard, HistoryCapture } from "../lib/types.js";
import type {
  SourceAdapter,
  CollectorContext,
  SearchFilters,
} from "../collector/adapter.js";

/**
 * MarketCheck adapter — the listings-API data source
 * that REPLACES the 5 headful scrapers after they hit hard bot walls.
 *
 * THIS IS AN HTTP ADAPTER, NOT A BROWSER ADAPTER.
 *   - usesBrowser = false: the orchestrator does NOT launch Chromium for it.
 *   - search() uses Node's global fetch (Node 24). No Playwright, no DOM, no
 *     stealth. Listing data + carfax_1_owner / carfax_clean_title come inline in
 *     the JSON response, so there is NO captureHistory() (the API has no free
 *     report to open).
 *
 * SPLIT FOR TESTABILITY (mirrors the scraper adapters):
 *   - LIVE: search() builds the URL, pages through results over the network,
 *     and hands each response's JSON TEXT to the PURE parsers.
 *   - PURE: parseListings(jsonText) / cardFromListing(obj) — no network, no env.
 *     Exported and unit-tested against a SYNTHETIC fixture (fake VINs/dealers).
 *
 * SERVICE HISTORY: owner + title are verified from the
 * API; the SERVICE section is NOT available via the API. We therefore do NOT
 * fabricate a service-clean signal: serviceIssueFlag stays false (we cannot
 * assert an issue), historyStatus is "verified" (owner+title genuinely known),
 * and a serviceHistory marker ("VERIFY via dealer CarFax") is attached so the
 * reporter surfaces a manual-check flag on each finalist.
 *
 * SECURITY:
 *   - The API key is the one secret. It is read from process.env
 *     (MARKETCHECK_API_KEY), loaded from C:\dev\vehicle-price-search\app\.env by the
 *     CLI entry — NEVER hardcoded, NEVER in config.json, NEVER committed.
 *   - The key is NEVER logged. Every URL that is logged is run through
 *     redactKey() first, which masks the api_key query param.
 *   - All HTTP is plain GET over HTTPS to the documented endpoint; no proxy,
 *     no fingerprint spoofing (compliant API-ToS use, not scraping-evasion).
 */

// ---------------------------------------------------------------------------
// CALIBRATE — every value here may need adjusting after the FIRST real key'd
// call. Centralized so calibration is an edit here, not a rewrite. Each is
// tagged `// CALIBRATE ON FIRST REAL CALL`.
// ---------------------------------------------------------------------------
export const CALIBRATE = {
  /**
   * Exact `trim` facet string MarketCheck expects. config.target.trim is
   * "Luxury 3"; MarketCheck may index it as "Luxury", "Luxury 3", "Lux3", etc.
   * Resolve against a known VIN from the live feed on the first real call.
   */
  trim: "Luxury 3", // CALIBRATE ON FIRST REAL CALL
  /**
   * Exact `drivetrain` facet string. config.target.drivetrain is "AWD";
   * MarketCheck commonly uses "AWD" but verify ("All Wheel Drive" / "4WD").
   */
  drivetrain: "4WD", // CALIBRATED 2026-06-15: MarketCheck labels one AWD model as "4WD" (values seen: 4WD|RWD). Inbound normDrivetrain maps 4WD->AWD for our model.
  /**
   * Nationwide radius convention. MarketCheck takes radius in MILES; a very
   * large value approximates "all US". Confirm the param NAME ("radius") and
   * whether an omit-radius / "0" sentinel means nationwide instead.
   */
  radius: "50000", // CALIBRATE ON FIRST REAL CALL
  /** Paging param names + page size. MarketCheck v2 uses start (offset) + rows. */
  pageStartParam: "start", // CALIBRATE ON FIRST REAL CALL
  pageRowsParam: "rows", // CALIBRATE ON FIRST REAL CALL
  pageSize: 50, // CALIBRATE ON FIRST REAL CALL (max rows per page on the eval tier)
  /**
   * car_type pass(es). Default: used AND certified. v2 accepts car_type=used /
   * car_type=certified; we run one pass per value and merge by VIN. Confirm the
   * accepted token set ("used","certified", maybe "cpo").
   */
  carTypes: ["used", "certified"] as const, // CALIBRATE ON FIRST REAL CALL
  /**
   * Field name carrying the listing detail-page URL on each listing object.
   * v2 typically nests it as listing.vdp_url; older/source variants use
   * "vdp_url" at top level, or build from "source"/"seller_url".
   */
  urlField: "vdp_url", // CALIBRATE ON FIRST REAL CALL
  /** Field name of the listings array in the response (v2: "listings"). */
  itemsField: "listings", // CALIBRATE ON FIRST REAL CALL
} as const;

const API = {
  searchUrl: "https://api.marketcheck.com/v2/search/car/active",
  host: "api.marketcheck.com",
} as const;

/** Upper bound for a price_range with no configured ceiling. */
const PRICE_CEILING = 9_999_999;

/**
 * Map our normalized drivetrain to the string MarketCheck's facet expects.
 * Our model says "AWD" for any all-/four-wheel-drive car; MarketCheck indexes
 * those as "4WD" (values seen: 4WD | RWD | FWD).
 */
export function marketcheckDrivetrain(drivetrain: string): string {
  return drivetrain.trim().toUpperCase() === "AWD" ? CALIBRATE.drivetrain : drivetrain;
}

/** Hard safety cap so paging can never loop forever. 250 x 50 rows = 12,500 per
 * car_type pass; the loop still exits early on an empty page / num_found. Raised
 * from 40 (=2,000) which silently truncated high-volume NEW-car passes. */
const MAX_PAGES = 250;

// ---------------------------------------------------------------------------
// PURE helpers + parsers (unit-tested against a synthetic fixture; no network).
// ---------------------------------------------------------------------------

/** Service-history manual-check marker. */
export const SERVICE_HISTORY_VERIFY = "VERIFY via dealer CarFax";

/** New-inventory counterpart: there is no prior history to go verify. */
export const SERVICE_HISTORY_NEW = "New - no prior history";

export function parseNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/[^0-9.]/g, "");
  if (digits === "" || digits === ".") return null;
  const n = Number(digits);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function extractVin(raw: unknown): string | null {
  if (raw == null) return null;
  const m = String(raw).toUpperCase().match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  return m ? m[1]! : null;
}

/** Normalize a MarketCheck drivetrain string to AWD/RWD/FWD when recognizable. */
export function normDrivetrain(text: unknown): string | null {
  if (text == null) return null;
  const t = String(text).toUpperCase();
  if (/\bAWD\b|ALL[- ]WHEEL|\b4WD\b|4X4/.test(t)) return "AWD";
  if (/\bRWD\b|REAR[- ]WHEEL/.test(t)) return "RWD";
  if (/\bFWD\b|FRONT[- ]WHEEL/.test(t)) return "FWD";
  return null;
}

/** Normalize a MarketCheck trim string to the "Luxury N" / Tech / Sport shape. */
export function normTrim(text: unknown): string | null {
  if (text == null) return null;
  const s = String(text);
  const m = s.match(/Luxury\s*[123]|Lux\s*[123]|Tech|Sport/i);
  if (!m) return s.trim() || null;
  return m[0]
    .replace(/\s+/g, " ")
    .replace(/lux(?:ury)?/i, "Luxury")
    .replace(/Luxury(\d)/, "Luxury $1");
}

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(obj: Json, key: string): string | null {
  const v = obj[key];
  if (v == null) return null;
  return typeof v === "string" ? v : String(v);
}

/**
 * PURE: read carfax_1_owner -> owner_count.
 *
 *   - true            => 1  (single owner; passes the owners==1 hard filter).
 *   - EXPLICIT false  => 2  (KNOWN not-single-owner). The ADR mapping gate is
 *                          "1-owner requires carfax_1_owner == true"; an explicit
 *                          false means we positively know it is NOT a 1-owner
 *                          car, so it must be REJECTED. The existing hard filter
 *                          only rejects a NON-null owner mismatch, so we surface
 *                          a concrete non-1 value (2 = "multiple owners") rather
 *                          than null — otherwise a known multi-owner car would
 *                          slip through as "unknown". (Required AC: a 2-owner car
 *                          is rejected.)
 *   - absent / unknown => null (genuinely unknown; permissive — the existing
 *                          filter does not reject a null owner count).
 */
export function ownerCountFromCarfax(obj: Json): number | null {
  const v = obj["carfax_1_owner"];
  if (v === true || v === "true" || v === 1 || v === "1") return 1;
  if (v === false || v === "false" || v === 0 || v === "0") return 2; // KNOWN not-1-owner
  return null; // field absent => unknown
}

/**
 * PURE: read carfax_clean_title -> accident severity gate.
 *   - clean title (true)  => "none" (acceptable; clean title permits minor
 *     accidents and passes the {none, minor} filter).
 *   - branded/not-clean (false) => "major" (branded/salvage => filter rejects).
 *   - absent/unknown => "unknown" (filter rejects unknown, by design — we do
 *     not pass an unconfirmed title as clean).
 */
export function accidentFromCarfax(obj: Json): "none" | "major" | "unknown" {
  const v = obj["carfax_clean_title"];
  if (v === true || v === "true" || v === 1 || v === "1") return "none";
  // CALIBRATED 2026-06-15: carfax_clean_title=false does NOT mean branded/major.
  // Across the live Lux3 4WD set, 25 of 32 (78%) are false — including 1-owner,
  // 9.7k-mile cars at franchise dealers (e.g. the reference VIN). So false means
  // "not positively confirmed clean", NOT salvage. Map false AND absent to
  // "unknown" -> the analyst routes these to the manual-verify bucket (open the
  // real dealer CarFax), never hard-rejected and never passed as clean.
  return "unknown";
}

/**
 * PURE: map one MarketCheck listing object -> ListingCard.
 *
 * MarketCheck v2 nests vehicle attributes under `build` and dealer attributes
 * under `dealer`; price/miles/vin/vdp_url sit at the top level. We read both the
 * nested and a few flat aliases so the parser is robust to response variants
 * (the exact shape is CALIBRATE-confirmed on the first real call).
 */
export function cardFromListing(listing: Json): ListingCard {
  const build = asObj(listing["build"]) ?? {};
  const dealer = asObj(listing["dealer"]) ?? {};

  const vin = extractVin(str(listing, "vin") ?? str(build, "vin"));

  // Title fallback for trim/drivetrain inference if structured fields are thin.
  const heading =
    str(listing, "heading") ??
    [str(build, "year"), str(build, "make"), str(build, "model"), str(build, "trim")]
      .filter(Boolean)
      .join(" ");

  const url =
    str(listing, CALIBRATE.urlField) ??
    str(listing, "vdp_url") ??
    str(listing, "source") ??
    str(dealer, "website") ??
    null;

  return {
    vin,
    make: str(build, "make"),
    model: str(build, "model"),
    year: parseNumber(str(build, "year")),
    price: parseNumber(listing["price"] ?? listing["msrp"]),
    mileage: parseNumber(listing["miles"] ?? listing["mileage"]),
    dealer: str(dealer, "name") ?? str(listing, "seller_name"),
    location: locationOf(dealer),
    zip: str(dealer, "zip") ?? str(dealer, "postal_code"),
    drivetrain:
      normDrivetrain(str(build, "drivetrain")) ??
      normDrivetrain(heading) ??
      str(build, "drivetrain"),
    trim: normTrim(str(build, "trim")) ?? normTrim(heading),
    url,
    exteriorColor:
      str(listing, "exterior_color") ??
      str(build, "exterior_color") ??
      str(listing, "base_ext_color") ??
      null,
    badges: badgesOf(listing),
    // The API can't confirm the service section -> always flag for manual
    // verification. owner + title ARE verified (handled in historyFromListing).
    serviceHistory: isNewInventory(listing) ? SERVICE_HISTORY_NEW : SERVICE_HISTORY_VERIFY,
  };
}

function locationOf(dealer: Json): string | null {
  const city = str(dealer, "city");
  const state = str(dealer, "state");
  if (city && state) return `${city}, ${state}`;
  return city ?? state ?? null;
}

/** Collect any inline badge-ish flags so downstream display can use them. */
function badgesOf(listing: Json): string[] {
  const out: string[] = [];
  if (isNewInventory(listing)) out.push("New");
  if (listing["in_transit"] === true) out.push("In transit");
  if (listing["carfax_1_owner"] === true) out.push("1-Owner");
  if (listing["carfax_clean_title"] === true) out.push("Clean Title");
  const dealer = asObj(listing["dealer"]);
  if (dealer && (dealer["certified"] === true || listing["is_certified"] === true)) {
    out.push("Certified Pre-Owned");
  }
  if (listing["is_certified"] === true && !out.some((b) => /certified/i.test(b))) {
    out.push("Certified Pre-Owned");
  }
  return out;
}

/**
 * PURE: derive the HistoryCapture from an inline MarketCheck listing.
 *
 * owner + title come from carfax_1_owner / carfax_clean_title. The service
 * section is NOT in the API:
 *   - historyStatus = "verified" — owner + title ARE verified from the API, so
 *     these cars are eligible for the ranked (buyable) list.
 *   - serviceIssueFlag = false — we have no evidence of a service issue and must
 *     NOT silently invent one; the manual-check marker (on the card) carries the
 *     "go confirm by hand" signal instead.
 */
export function historyFromListing(listing: Json): HistoryCapture {
  // A NEW car has no history to report: MarketCheck emits carfax_1_owner=false
  // and carfax_clean_title=false on brand-new units (verified 2026-08-30 against
  // a 4-mile 2026 GC L at a franchise dealer). Running those through the CarFax
  // mapping below would route EVERY new car to verify-by-hand on a phantom title
  // doubt. A factory-new vehicle is zero-owner and clean by definition, so we say
  // so — this asserts nothing the inventory_type does not already establish.
  if (isNewInventory(listing)) {
    return {
      ownerCount: 0,
      accidentSeverity: "none",
      serviceIssueFlag: false,
      historyStatus: "verified",
    };
  }
  return usedHistoryFromListing(listing);
}

/** PURE: true when MarketCheck flags this listing as factory-new inventory. */
export function isNewInventory(listing: Json): boolean {
  return String(listing["inventory_type"] ?? "").trim().toLowerCase() === "new";
}

function usedHistoryFromListing(listing: Json): HistoryCapture {
  return {
    ownerCount: ownerCountFromCarfax(listing),
    accidentSeverity: accidentFromCarfax(listing),
    serviceIssueFlag: false, // API has no service section; never auto-assert an issue
    historyStatus: "verified", // owner + title verified inline (service flagged separately)
  };
}

/**
 * PURE: parse a MarketCheck search response's JSON TEXT into ListingCards.
 * Tolerates the documented `{ listings: [...] }` shape and a bare array.
 * Missing fields -> null, never a throw; invalid JSON -> [].
 */
export function parseListings(jsonText: string): ListingCard[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return pickListings(parsed).map((l) => cardFromListing(l));
}

/**
 * PURE companion: parse JSON TEXT into [card, history] pairs (history from the
 * SAME inline object). Used by the live path so card + history stay aligned.
 */
export function parseListingsWithHistory(
  jsonText: string,
): Array<{ card: ListingCard; history: HistoryCapture }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  return pickListings(parsed).map((l) => ({
    card: cardFromListing(l),
    history: historyFromListing(l),
  }));
}

function pickListings(parsed: unknown): Json[] {
  const obj = asObj(parsed);
  if (obj) {
    for (const key of [CALIBRATE.itemsField, "listings", "results", "data"]) {
      const v = obj[key];
      if (Array.isArray(v)) return v.filter((x): x is Json => !!asObj(x));
    }
  }
  if (Array.isArray(parsed)) return parsed.filter((x): x is Json => !!asObj(x));
  return [];
}

// ---------------------------------------------------------------------------
// URL building + key redaction (key-handling: NEVER log the raw key).
// ---------------------------------------------------------------------------

/**
 * Build a MarketCheck search URL for one car_type pass + page offset.
 * `apiKey` is injected (read from env by the caller) — this function never
 * touches process.env, so it is unit-testable without a key in the environment.
 */
export function buildSearchUrl(
  filters: SearchFilters,
  apiKey: string,
  carType: string,
  start: number,
): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    make: filters.make, // "Cadillac" | "Chevrolet"
    model: filters.model, // "the target vehicle" | "Equinox EV"
    year: String(filters.year),
    // NOTE: the drivetrain facet is intentionally OMITTED. MarketCheck mislabels
    // some AWD cars (verified against NHTSA), so filtering server-side on
    // drivetrain silently drops them. We pull every match and let the NHTSA VIN
    // decode (authoritative) drive the AWD hard filter downstream.

    car_type: carType, // used | certified (one pass each)
    // Free tier caps radius at 100mi; omitting zip+radius returns NATIONWIDE
    // results. Shipping distance is computed by the analyst from dealer.zip vs
    // config.homeZip — no query zip needed.
    [CALIBRATE.pageStartParam]: String(start),
    [CALIBRATE.pageRowsParam]: String(CALIBRATE.pageSize),
  });
  // Trim facet is CONFIG-DRIVEN (filters.trim). A concrete trim ("Luxury 3") is
  // sent as the facet; a wildcard "*" (or empty) pulls ALL trims (the Equinox-EV
  // case wants every trim). Previously hardcoded to CALIBRATE.trim.
  // miles_range drops every listing with no `miles` field — real new-car
  // inventory. allowUnknownMileage omits it and leans on the hard filter, which
  // already ignores a null mileage and still enforces maxMileage on the rest.
  if (!filters.allowUnknownMileage) {
    params.set("miles_range", `0-${filters.maxMileage}`);
  }
    const wantTrim = (filters.trim ?? "").trim();
  if (wantTrim && wantTrim !== "*") params.set("trim", wantTrim);
  // Optional server-side price cap (config.maxPrice) — mirrors miles_range so we
  // don't pull cars over budget. Omitted when no cap is set.
  // price_range carries BOTH bounds. The floor (filters.minPrice) exists to drop
  // "call for price" listings: MarketCheck sorts a null price FIRST under
  // price-ascending, so without a floor they eat the 500-row window.
  if (filters.maxPrice != null || filters.minPrice != null) {
    const lo = filters.minPrice ?? 0;
    const hi = filters.maxPrice ?? PRICE_CEILING;
    params.set("price_range", `${lo}-${hi}`);
  }
  // Cheapest-first. The API window is capped at start+rows <= 500 (HTTP 422
  // beyond it), so on any result set larger than that we cannot see every car —
  // we can only choose WHICH 500. Ranking is by landed price ascending, so the
  // 500 cheapest are exactly the ones that can place. Harmless on small sets,
  // where the whole result fits inside the window regardless of order.
  params.set("sort_by", "price");
  params.set("sort_order", "asc");
  // Optional server-side drivetrain facet (cfg.useDrivetrainFacet). Off by
  // default: MarketCheck mislabels some AWD cars, so we normally pull everything
  // and let the NHTSA decode decide. On, for high-volume searches where an
  // unfiltered pull would spend the 500-row window on the wrong drivetrain.
  if (filters.useDrivetrainFacet) {
    params.set("drivetrain", marketcheckDrivetrain(filters.drivetrain));
  }
  // Normalized exterior color (base_ext_color). Comma-separated for several.
  // Server-side so the 500-row window fills with the colors actually wanted —
  // filtering only client-side would spend the window on rejects.
  if (filters.exteriorColors?.length) {
    params.set("base_ext_color", filters.exteriorColors.join(","));
  }
  // Optional fuel_type facet — e.g. Kia "Niro" spans HEV/PHEV/BEV; "Electric"
  // narrows to the BEV. Omitted when not set (model name already EV-specific).
  if (filters.fuelType) params.set("fuel_type", filters.fuelType);
  return `${API.searchUrl}?${params.toString()}`;
}

/**
 * Redact the api_key in a URL so it is SAFE to log. Replaces the key value with
 * "REDACTED" while leaving the rest of the URL intact for debugging. Used on
 * EVERY URL before it reaches a log line.
 */
export function redactKey(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/i, "$1REDACTED");
}

/** Read total result count from a response object, if present (paging stop). */
export function totalFrom(jsonText: string): number | null {
  try {
    const obj = asObj(JSON.parse(jsonText));
    if (!obj) return null;
    const n = obj["num_found"] ?? obj["total"] ?? obj["count"];
    return parseNumber(n);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal injectable fetch seam (so tests can stub the network).
// ---------------------------------------------------------------------------
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/**
 * Read the API key from the environment. Throws a clear, key-free error if it is
 * missing/empty. The error NEVER contains the key (there is no key to contain).
 */
export function readApiKeyOrThrow(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.MARKETCHECK_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "MARKETCHECK_API_KEY is not set. Add it to C:\\dev\\vehicle-price-search\\app\\.env " +
        "(see .env.example), then re-run. The key is read only from the environment, never from config.json.",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// LIVE search (HTTP). Pages through every car_type pass, merges by VIN.
// ---------------------------------------------------------------------------

/**
 * Run the full MarketCheck search over HTTP. Injectable env + fetch keep it
 * testable without a real key or network. Returns ListingCards with their
 * inline-derived history stashed on the card via serviceHistory + badges; the
 * orchestrator reads history through the adapter's captureHistory-less path
 * (see the adapter object below, which exposes the aligned history).
 */
async function runSearch(
  ctx: CollectorContext,
  filters: SearchFilters,
  apiKey: string,
  doFetch: FetchLike,
): Promise<Array<{ card: ListingCard; history: HistoryCapture }>> {
  const byVin = new Map<string, { card: ListingCard; history: HistoryCapture }>();
  const noVin: Array<{ card: ListingCard; history: HistoryCapture }> = [];

  // car_type passes are CONFIG-driven (cfg.carTypes -> filters.carTypes). Falls
  // back to the default ["used","certified"] when unset.
  const carTypes = filters.carTypes?.length ? filters.carTypes : CALIBRATE.carTypes;
  for (const carType of carTypes) {
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // Pace API calls like every other source (no bypass).
      await ctx.pacer.beforeNavigate(API.host);

      const url = buildSearchUrl(filters, apiKey, carType, start);
      let body = "";
      try {
        const res = await doFetch(url);
        if (!res.ok) {
          // Log the REDACTED url + status only — never the key.
          console.warn(
            `[marketcheck] ${carType} page ${page + 1}: HTTP ${res.status} for ${redactKey(url)}`,
          );
          break;
        }
        body = await res.text();
      } catch (err) {
        console.warn(
          `[marketcheck] ${carType} page ${page + 1}: fetch failed for ${redactKey(url)}: ${(err as Error).message}`,
        );
        break;
      }

      const pairs = parseListingsWithHistory(body);
      if (pairs.length === 0) {
        if (page === 0) {
          console.warn(
            `[marketcheck] ${carType}: 0 listings parsed — facet strings / response shape likely need calibration (CALIBRATE ON FIRST REAL CALL): ${redactKey(url)}`,
          );
        }
        break; // empty page => no more results for this car_type
      }

      for (const pair of pairs) {
        if (pair.card.vin) {
          const key = pair.card.vin.toLowerCase();
          const existing = byVin.get(key);
          // Keep the lower-priced duplicate (e.g. used vs certified same VIN).
          if (
            !existing ||
            (pair.card.price ?? Infinity) < (existing.card.price ?? Infinity)
          ) {
            byVin.set(key, pair);
          }
        } else {
          noVin.push(pair);
        }
      }

      const total = totalFrom(body);
      start += CALIBRATE.pageSize;
      if (pairs.length < CALIBRATE.pageSize) break; // short page => last page
      if (total !== null && start >= total) break; // consumed all results
    }
  }

  return [...byVin.values(), ...noVin];
}

export const adapter: SourceAdapter = {
  name: "marketcheck",
  enabled: true, // the source design: MarketCheck is the SOLE enabled source
  usesBrowser: false, // HTTP/API — orchestrator must NOT launch Chromium

  async search(ctx: CollectorContext, filters: SearchFilters): Promise<ListingCard[]> {
    const apiKey = readApiKeyOrThrow();
    const pairs = await runSearch(ctx, filters, apiKey, globalThis.fetch as FetchLike);
    // The orchestrator re-derives history from the inline card via the
    // captureHistory hook below, so we expose both consistently.
    //
    // DO NOT clear this map here. A multi-vehicle run calls search() once per
    // target and only THEN loops the merged cards through captureHistory, so
    // clearing per-search left every target but the last with no history — those
    // cards fell back to owner=null/title=unknown and were dumped into
    // verify-by-hand. The map is process-scoped (one process = one run) and
    // keyed by VIN, so accumulating across targets is correct: a VIN seen twice
    // is the same car, and the later write carries the same inline fields.
    for (const p of pairs) {
      if (p.card.vin) lastHistoryByVin.set(p.card.vin.toLowerCase(), p.history);
    }
    return pairs.map((p) => p.card);
  },

  /**
   * "History" for MarketCheck is INLINE (no browser, no report to open). This
   * hook just hands back the owner/title/service fields already derived from the
   * same listing object during search(), keyed by VIN. It performs no network
   * I/O. Implementing the hook (rather than letting the orchestrator default to
   * an all-unknown unverified capture) is what lets these cards rank as buyable.
   */
  async captureHistory(_ctx: CollectorContext, card: ListingCard): Promise<HistoryCapture> {
    const fallback: HistoryCapture = {
      ownerCount: null,
      accidentSeverity: "unknown",
      serviceIssueFlag: false,
      historyStatus: "verified",
    };
    if (!card.vin) return fallback;
    return lastHistoryByVin.get(card.vin.toLowerCase()) ?? fallback;
  },
};

/**
 * Per-run cache aligning each VIN's inline history with the card the
 * orchestrator passes back to captureHistory(). Cleared at the start of every
 * search(). In-memory only — holds nothing but the minimal HistoryCapture
 * fields (no raw report text, no PII).
 */
const lastHistoryByVin = new Map<string, HistoryCapture>();
