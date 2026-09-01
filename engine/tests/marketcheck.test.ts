import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseListings,
  parseListingsWithHistory,
  cardFromListing,
  historyFromListing,
  ownerCountFromCarfax,
  accidentFromCarfax,
  parseNumber,
  extractVin,
  normDrivetrain,
  normTrim,
  buildSearchUrl,
  redactKey,
  readApiKeyOrThrow,
  totalFrom,
  adapter,
  SERVICE_HISTORY_VERIFY,
  CALIBRATE,
  type FetchLike,
} from "../src/adapters/marketcheck.adapter.js";
import { filtersFromConfig } from "../src/collector/adapter.js";
import type { CollectorContext } from "../src/collector/adapter.js";
import { Pacer } from "../src/collector/pacing.js";
import { applyHardFilters } from "../src/analyst/filters.js";
import { analyze } from "../src/analyst/analyst.js";
import { cardToSnapshot } from "../src/orchestrator.js";
import { testConfig } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

const cfg = testConfig();
const filters = filtersFromConfig(cfg);

// ---------------------------------------------------------------------------
// Pure field parsers
// ---------------------------------------------------------------------------
describe("marketcheck pure field parsers", () => {
  it("parseNumber strips junk / accepts numbers", () => {
    expect(parseNumber("57,990")).toBe(57990);
    expect(parseNumber(57990)).toBe(57990);
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
  it("extractVin pulls a 17-char VIN", () => {
    expect(extractVin("1GYKPSRL2RZ900001")).toBe("1GYKPSRL2RZ900001");
    expect(extractVin("nope")).toBeNull();
  });
  it("normDrivetrain / normTrim", () => {
    expect(normDrivetrain("AWD")).toBe("AWD");
    expect(normDrivetrain("All Wheel Drive")).toBe("AWD");
    expect(normTrim("Luxury 3")).toBe("Luxury 3");
    expect(normTrim("Lux3")).toBe("Luxury 3");
  });
});

describe("marketcheck carfax -> filter-field mapping", () => {
  it("carfax_1_owner true => 1; EXPLICIT false => 2 (known multi-owner); absent => null", () => {
    expect(ownerCountFromCarfax({ carfax_1_owner: true })).toBe(1);
    // Explicit false is a KNOWN not-1-owner car -> surface a concrete non-1
    // value (2) so the existing hard filter rejects it; null would let a known
    // multi-owner car slip through as "unknown" (required AC: 2-owner rejected).
    expect(ownerCountFromCarfax({ carfax_1_owner: false })).toBe(2);
    // Field absent => genuinely unknown -> null (permissive; filter won't reject).
    expect(ownerCountFromCarfax({})).toBeNull();
  });
  it("carfax_clean_title true => none; false/absent => unknown (false is an unreliable proxy, not branded)", () => {
    expect(accidentFromCarfax({ carfax_clean_title: true })).toBe("none");
    expect(accidentFromCarfax({ carfax_clean_title: false })).toBe("unknown");
    expect(accidentFromCarfax({})).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// parse/map against the synthetic fixture
// ---------------------------------------------------------------------------
describe("marketcheck parseListings — maps the documented v2 shape", () => {
  const cards = parseListings(fx("marketcheck-search.json"));

  it("parses all four listings", () => {
    expect(cards).toHaveLength(4);
  });

  it("maps the passing 2024 Lux3 AWD card's fields", () => {
    const c = cards.find((x) => x.vin === "1GYKPSRL2RZ900001")!;
    expect(c).toBeDefined();
    expect(c.price).toBe(57990);
    expect(c.mileage).toBe(7400);
    expect(c.trim).toBe("Luxury 3");
    expect(c.drivetrain).toBe("AWD");
    expect(c.dealer).toBe("Synthetic Cadillac of Detroit");
    expect(c.location).toBe("Detroit, MI");
    expect(c.zip).toBe("48226");
    expect(c.url).toBe("https://listings.example.test/vdp/1GYKPSRL2RZ900001");
    expect(c.exteriorColor).toBe("Stellar Black Metallic"); // top-level exterior_color
  });

  it("falls back to build.exterior_color when there's no top-level color", () => {
    const c = cards.find((x) => x.vin === "1GYKPSRL2RZ900002")!;
    expect(c.exteriorColor).toBe("Radiant Red Tintcoat");
  });

  it("sets the service-history-verify marker on every card (API can't confirm service)", () => {
    for (const c of cards) expect(c.serviceHistory).toBe(SERVICE_HISTORY_VERIFY);
  });

  it("invalid JSON => [] (never throws)", () => {
    expect(parseListings("{not json")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filter behavior — the four required scenarios, end-to-end through the
// EXISTING analyst hard filters (proving the mapping feeds them correctly).
// ---------------------------------------------------------------------------
describe("marketcheck cards through the existing hard filters", () => {
  // Build snapshots exactly as the orchestrator would: card + inline history.
  const pairs = parseListingsWithHistory(fx("marketcheck-search.json"));
  const snapshots = pairs.map((p) => cardToSnapshot(p.card, p.history, 1, "marketcheck"));

  const { passed, unverified, rejected } = applyHardFilters(snapshots, cfg);

  const reasonFor = (vin: string): string =>
    rejected.find((r) => r.snapshot.vin === vin)?.reason ?? "";

  it("a 1-owner clean-title low-miles Lux3 AWD car PASSES (and is not unverified)", () => {
    expect(passed.map((s) => s.vin)).toContain("1GYKPSRL2RZ900001");
    expect(unverified.map((s) => s.vin)).not.toContain("1GYKPSRL2RZ900001");
  });

  it("a not-clean-title car (carfax_clean_title=false, owner ok) routes to VERIFY-BY-HAND, not rejected (false is an unreliable proxy)", () => {
    expect(passed.map((s) => s.vin)).not.toContain("1GYKPSRL2RZ900002");
    expect(rejected.map((r) => r.snapshot.vin)).not.toContain("1GYKPSRL2RZ900002");
    expect(unverified.map((s) => s.vin)).toContain("1GYKPSRL2RZ900002");
  });

  it("a >15k-miles car is REJECTED on mileage", () => {
    expect(passed.map((s) => s.vin)).not.toContain("1GYKPSRL2RZ900003");
    expect(reasonFor("1GYKPSRL2RZ900003")).toMatch(/mileage 22800 >= max 15000/);
  });

  it("a carfax_1_owner=false car (owner_count 2) routes to VERIFY-BY-HAND, not rejected (the owner flag is unreliable both ways)", () => {
    expect(passed.map((s) => s.vin)).not.toContain("1GYKPSRL2RZ900004");
    expect(rejected.map((r) => r.snapshot.vin)).not.toContain("1GYKPSRL2RZ900004");
    expect(unverified.map((s) => s.vin)).toContain("1GYKPSRL2RZ900004");
  });

  it("the passing car keeps verified history + the verify-service marker (ranked, not unverified)", () => {
    const passing = passed.find((s) => s.vin === "1GYKPSRL2RZ900001")!;
    expect(passing.historyStatus).toBe("verified");
    expect(passing.serviceIssueFlag).toBe(false);
    expect(passing.serviceHistory).toBe(SERVICE_HISTORY_VERIFY);
  });

  it("the passing car appears in the analyst's BUYABLE bucket (full pipeline)", () => {
    const result = analyze(snapshots, cfg);
    expect(result.buyable.map((r) => r.vin)).toContain("1GYKPSRL2RZ900001");
  });
});

describe("marketcheck historyFromListing", () => {
  it("verified owner+title, no service issue, owner=1 on the passing listing", () => {
    const listing = JSON.parse(fx("marketcheck-search.json")).listings[0];
    const h = historyFromListing(listing);
    expect(h.ownerCount).toBe(1);
    expect(h.accidentSeverity).toBe("none");
    expect(h.serviceIssueFlag).toBe(false);
    expect(h.historyStatus).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// URL building + key redaction (key never logged)
// ---------------------------------------------------------------------------
describe("marketcheck URL build + key redaction", () => {
  const url = buildSearchUrl(filters, "fake-test-key-not-a-real-credential", "used", 0);

  it("includes the documented filter params", () => {
    expect(url).toContain("make=Cadillac");
    expect(url).toContain("model=LYRIQ");
    expect(url).toContain("year=2024");
    expect(url).toContain("miles_range=0-15000");
    expect(url).toContain("car_type=used");
    // drivetrain facet is intentionally OMITTED — MarketCheck mislabels some AWD
    // cars as RWD, so we pull all trims and let the NHTSA VIN decode drive the
    // AWD filter. The facet must NOT be on the query.
    expect(url).not.toContain("drivetrain=");
    expect(url).toContain(`${CALIBRATE.pageStartParam}=0`);
  });

  it("omits zip + radius (free tier caps radius at 100mi; omitting => nationwide)", () => {
    expect(url).not.toContain("zip=");
    expect(url).not.toContain("radius=");
  });

  it("redactKey masks the api_key value (safe to log)", () => {
    expect(url).toContain("api_key=fake-test-key-not-a-real-credential");
    const safe = redactKey(url);
    expect(safe).not.toContain("fake-test-key-not-a-real-credential");
    expect(safe).toContain("api_key=REDACTED");
    // everything else is preserved
    expect(safe).toContain("make=Cadillac");
  });
});

// ---------------------------------------------------------------------------
// Key-from-env discipline
// ---------------------------------------------------------------------------
describe("marketcheck readApiKeyOrThrow (env-only secret)", () => {
  it("returns the key when set", () => {
    expect(readApiKeyOrThrow({ MARKETCHECK_API_KEY: "abc123" })).toBe("abc123");
  });
  it("throws a key-free error when missing/empty", () => {
    expect(() => readApiKeyOrThrow({})).toThrow(/MARKETCHECK_API_KEY is not set/);
    expect(() => readApiKeyOrThrow({ MARKETCHECK_API_KEY: "   " })).toThrow(
      /not set/,
    );
  });
});

// ---------------------------------------------------------------------------
// LIVE search with a STUBBED fetch — no network. Proves paging + parse wiring.
// ---------------------------------------------------------------------------
describe("marketcheck adapter.search with a mocked fetch (no network)", () => {
  function makeCtx(): CollectorContext {
    // pacing intervals 0 so the test doesn't actually sleep.
    const fastCfg = testConfig({
      pacing: { minActionDelayMs: 0, maxActionDelayMs: 0, perDomainMinIntervalMs: 0 },
    });
    return { browser: null, pacer: new Pacer(fastCfg), config: fastCfg };
  }

  it("never launches a browser (usesBrowser=false, ctx.browser=null)", () => {
    expect(adapter.usesBrowser).toBe(false);
  });

  it("pages each car_type once, parses the stubbed body, and asserts the key reached the URL redacted-safely", async () => {
    process.env.MARKETCHECK_API_KEY = "fake-test-key-not-a-real-credential";
    const body = fx("marketcheck-search.json");
    const seenUrls: string[] = [];

    const stubFetch: FetchLike = async (url: string) => {
      seenUrls.push(url);
      // First call for each car_type returns the 4 listings; subsequent pages
      // (start>0) return an empty page so paging terminates.
      const isFirstPage = /[?&]start=0(&|$)/.test(url);
      return {
        ok: true,
        status: 200,
        text: async () => (isFirstPage ? body : '{"num_found":4,"listings":[]}'),
      };
    };

    // Swap global fetch for the stub for the duration of this call.
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: FetchLike }).fetch = stubFetch;
    try {
      const cards = await adapter.search(makeCtx(), filters);
      // 4 listings, de-duped by VIN across the used+certified passes -> still 4.
      expect(cards).toHaveLength(4);
      expect(cards.map((c) => c.vin).sort()).toEqual([
        "1GYKPSRL2RZ900001",
        "1GYKPSRL2RZ900002",
        "1GYKPSRL2RZ900003",
        "1GYKPSRL2RZ900004",
      ]);
      // The key WAS placed in the request URL...
      expect(seenUrls.some((u) => u.includes("fake-test-key-not-a-real-credential"))).toBe(true);
      // ...but a redacted form is what we log (no key leaks to logs).
      for (const u of seenUrls) {
        expect(redactKey(u)).not.toContain("fake-test-key-not-a-real-credential");
      }
    } finally {
      (globalThis as { fetch: typeof realFetch }).fetch = realFetch;
      delete process.env.MARKETCHECK_API_KEY;
    }
  });

  it("captureHistory returns the inline owner/title/service fields for a searched VIN", async () => {
    process.env.MARKETCHECK_API_KEY = "k";
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: FetchLike }).fetch = async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        /[?&]start=0(&|$)/.test(url) ? fx("marketcheck-search.json") : '{"listings":[]}',
    });
    try {
      const ctx = makeCtx();
      const cards = await adapter.search(ctx, filters);
      const passing = cards.find((c) => c.vin === "1GYKPSRL2RZ900001")!;
      const h = await adapter.captureHistory!(ctx, passing);
      expect(h.ownerCount).toBe(1);
      expect(h.accidentSeverity).toBe("none");
      expect(h.historyStatus).toBe("verified");
    } finally {
      (globalThis as { fetch: typeof realFetch }).fetch = realFetch;
      delete process.env.MARKETCHECK_API_KEY;
    }
  });
});

describe("marketcheck totalFrom", () => {
  it("reads num_found", () => {
    expect(totalFrom('{"num_found":12,"listings":[]}')).toBe(12);
    expect(totalFrom("garbage")).toBeNull();
  });
});

describe("marketcheck cardFromListing nesting tolerance", () => {
  it("handles a flat-ish object without build/dealer nesting", () => {
    const c = cardFromListing({
      vin: "1GYKPSRL2RZ900099",
      price: 60000,
      miles: 5000,
      heading: "2024 Cadillac LYRIQ Luxury 3 AWD",
      vdp_url: "https://x.test/v",
    });
    expect(c.vin).toBe("1GYKPSRL2RZ900099");
    expect(c.trim).toBe("Luxury 3");
    expect(c.drivetrain).toBe("AWD");
    expect(c.url).toBe("https://x.test/v");
  });
});
