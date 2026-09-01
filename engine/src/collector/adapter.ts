import type { BrowserContext } from "playwright";
import type { Config } from "../config.js";
import type { ListingCard, HistoryCapture } from "../lib/types.js";
import type { Pacer } from "./pacing.js";

/**
 * Source adapter contract.
 *
 * Every source implements this. Adding a source means adding one file that
 * exports an `adapter` — the registry discovers it by directory scan, so no
 * shared file needs editing.
 *
 * TESTABILITY (critical): each adapter is split into
 *   (a) LIVE methods (search / captureHistory) that drive the real browser, and
 *   (b) PURE parsers (parseListings / parseHistory) that take a string and
 *       return structured data, with ZERO browser/network dependency.
 * The pure parsers are exported so they can be unit-tested against fixture
 * strings (proving parser logic independent of live selectors).
 */

/** What an adapter receives to do its work. */
export interface CollectorContext {
  /**
   * The persistent headful browser context for this source, or `null` for
   * HTTP/API adapters (usesBrowser=false, the source design MarketCheck) which never
   * touch a browser. Browser-backed adapters can assume it is non-null.
   */
  browser: BrowserContext | null;
  /** Shared pacing + per-domain rate limiter (never bypassed). */
  pacer: Pacer;
  /** Full app config (filters, target, home zip, ...). */
  config: Config;
}

/** Filters distilled from config that an adapter applies to a site's search. */
export interface SearchFilters {
  year: number;
  make: string;
  model: string;
  trim: string;
  drivetrain: string;
  maxMileage: number;
  homeZip: string;
  /** Optional max listing price (USD) — server-side price_range cap. */
  maxPrice?: number | null;
  /** Optional fuel_type facet (e.g. "Electric") — narrows a multi-powertrain model
   * (Kia "Niro") to the BEV. */
  fuelType?: string | null;
  /** Optional MarketCheck car_type passes (run-level, from cfg.carTypes). Omit =>
   * the adapter's default ["used","certified"]. */
  carTypes?: readonly string[] | null;
  /** Optional server-side price floor (run-level, from cfg.minPrice). */
  minPrice?: number | null;
  /** Send the drivetrain facet server-side (run-level, from cfg.useDrivetrainFacet). */
  useDrivetrainFacet?: boolean;
  /** Optional normalized exterior-color filter (run-level, from cfg.exteriorColors). */
  exteriorColors?: readonly string[] | null;
  /** Do not send miles_range, so listings with no odometer survive (run-level). */
  allowUnknownMileage?: boolean;
}

/** Build SearchFilters for ONE target + the shared run-level limits. */
export function filtersForTarget(target: Config["target"], cfg: Config): SearchFilters {
  return {
    year: target.year,
    make: target.make,
    model: target.model,
    trim: target.trim,
    drivetrain: target.drivetrain,
    fuelType: target.fuelType ?? null,
    maxMileage: cfg.maxMileage,
    homeZip: cfg.homeZip,
    maxPrice: cfg.maxPrice ?? null,
    carTypes: cfg.carTypes ?? null,
    minPrice: cfg.minPrice ?? null,
    useDrivetrainFacet: cfg.useDrivetrainFacet ?? false,
    // Per-target colors win over the run-level list (model-year palettes differ).
    exteriorColors: target.exteriorColors ?? cfg.exteriorColors ?? null,
    allowUnknownMileage: cfg.allowUnknownMileage ?? false,
  };
}

/** Back-compat: filters for the primary target. */
export function filtersFromConfig(cfg: Config): SearchFilters {
  return filtersForTarget(cfg.target, cfg);
}

export interface SourceAdapter {
  /** Stable source key, e.g. "marketcheck". Matches a config.sources[].name. */
  name: string;
  /** Whether this adapter is wired for live runs (the shipped source). */
  enabled: boolean;
  /**
   * Whether this adapter drives the headful browser (default: true). HTTP/API
   * adapters set this false so the orchestrator does NOT
   * launch Chromium for them — they fetch over the network and ignore
   * ctx.browser. Omitted => treated as true (browser-backed, the scraper case).
   */
  usesBrowser?: boolean;
  /**
   * Live: apply filters in the site's own search, paginate, and return parsed
   * result cards. Internally calls navigate() then the pure parseListings().
   */
  search(ctx: CollectorContext, filters: SearchFilters): Promise<ListingCard[]>;
  /**
   * Live (optional): open a card's VDP, follow the free history report when
   * present, capture the text TRANSIENTLY, run parseHistory(), and return the
   * minimal extracted fields. Raw text is never persisted.
   */
  captureHistory?(ctx: CollectorContext, card: ListingCard): Promise<HistoryCapture>;
}

/** Marker an adapter module exports so auto-discovery can pick it up. */
export interface AdapterModule {
  adapter: SourceAdapter;
}

/**
 * Narrow `ctx.browser` to a non-null BrowserContext for browser-backed adapters.
 * The orchestrator only ever passes a null browser to usesBrowser=false adapters
 * (which never call this), so a null here is a wiring bug — fail loud, not silent.
 */
export function requireBrowser(ctx: CollectorContext): BrowserContext {
  if (!ctx.browser) {
    throw new Error(
      "CollectorContext.browser is null — a browser-backed adapter was run without a browser context (wiring bug).",
    );
  }
  return ctx.browser;
}
