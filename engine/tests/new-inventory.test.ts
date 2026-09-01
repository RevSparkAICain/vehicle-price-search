import { describe, it, expect } from "vitest";
import {
  historyFromListing,
  isNewInventory,
  cardFromListing,
  buildSearchUrl,
  SERVICE_HISTORY_NEW,
  SERVICE_HISTORY_VERIFY,
} from "../src/adapters/marketcheck.adapter.js";
import { applyHardFilters } from "../src/analyst/filters.js";
import type { ListingSnapshot } from "../src/lib/types.js";

/**
 * Covers the new-car search path added for the Jeep Grand Cherokee L run:
 * car_type=new listings, multi-trim targets, and config-driven car_type passes.
 * The shapes below mirror a real 2026 GC L response (captured 2026-08-30).
 */

const NEW_LISTING = {
  vin: "1C4RJJBR5T8573441",
  price: 47455,
  msrp: 51730,
  miles: 4,
  inventory_type: "new",
  // MarketCheck reports BOTH of these as false on brand-new units — the trap
  // this mapping exists to avoid.
  carfax_1_owner: false,
  carfax_clean_title: false,
  build: { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited" },
  dealer: { name: "Ed Payne CDJR", city: "Weslaco", state: "TX", zip: "78599" },
};

const USED_LISTING = {
  ...NEW_LISTING,
  vin: "1C4RJJBR5T8000001",
  inventory_type: "used",
  miles: 18500,
};

describe("new-inventory history mapping", () => {
  it("treats a factory-new unit as zero-owner, clean, and verified", () => {
    expect(isNewInventory(NEW_LISTING)).toBe(true);
    expect(historyFromListing(NEW_LISTING)).toEqual({
      ownerCount: 0,
      accidentSeverity: "none",
      serviceIssueFlag: false,
      historyStatus: "verified",
    });
  });

  it("does NOT apply the new-car shortcut to used inventory", () => {
    expect(isNewInventory(USED_LISTING)).toBe(false);
    const h = historyFromListing(USED_LISTING);
    // carfax_clean_title=false means "not positively confirmed", not clean.
    expect(h.accidentSeverity).toBe("unknown");
    expect(h.ownerCount).toBe(2);
  });

  it("labels service history and badges per inventory type", () => {
    expect(cardFromListing(NEW_LISTING).serviceHistory).toBe(SERVICE_HISTORY_NEW);
    expect(cardFromListing(NEW_LISTING).badges).toContain("New");
    expect(cardFromListing(USED_LISTING).serviceHistory).toBe(SERVICE_HISTORY_VERIFY);
    expect(cardFromListing(USED_LISTING).badges).not.toContain("New");
  });
});

describe("config-driven car_type passes", () => {
  const filters = {
    year: 2026,
    make: "Jeep",
    model: "Grand Cherokee L",
    trim: "Limited",
    drivetrain: "AWD",
    maxMileage: 60000,
    homeZip: "60601",
  };

  it("sends the car_type it is given", () => {
    const url = buildSearchUrl(filters, "KEY", "new", 0);
    expect(url).toContain("car_type=new");
    expect(url).toContain("trim=Limited");
  });
});

describe("multi-trim hard filter", () => {
  const snap = (trim: string): ListingSnapshot =>
    ({
      vin: `1C4RJJBR5T85734${trim.length}1`,
      trim,
      drivetrain: "AWD",
      mileage: 4,
      price: 47455,
      ownerCount: 0,
      accidentSeverity: "none",
      serviceIssueFlag: false,
      historyStatus: "verified",
    }) as unknown as ListingSnapshot;

  const cfg = {
    target: { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" },
    extraTargets: [
      { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited Reserve", drivetrain: "AWD" },
    ],
    maxMileage: 60000,
    owners: 1,
    ownersAny: true,
  } as unknown as Parameters<typeof applyHardFilters>[1];

  it("passes every trim named across primary + extra targets", () => {
    const r = applyHardFilters([snap("Limited"), snap("Limited Reserve")], cfg);
    expect(r.passed.map((s) => s.trim).sort()).toEqual(["Limited", "Limited Reserve"]);
    expect(r.rejected).toHaveLength(0);
  });

  it("still rejects a trim nobody asked for", () => {
    const r = applyHardFilters([snap("Laredo")], cfg);
    expect(r.passed).toHaveLength(0);
    expect(r.rejected[0]?.reason).toContain("Laredo");
  });
});

describe("history survives a multi-target run", () => {
  // Regression: search() used to clear the VIN->history cache on every call.
  // The orchestrator searches EVERY target first and only then loops the merged
  // cards through captureHistory, so all but the last target lost their history
  // and silently fell into verify-by-hand.
  it("still knows target 1's history after target 2 is searched", async () => {
    const { adapter } = await import("../src/adapters/marketcheck.adapter.js");
    const ctx = { pacer: { beforeNavigate: async () => {} } } as never;

    const page = (listing: unknown) =>
      new Response(JSON.stringify({ num_found: 1, listings: [listing] }), { status: 200 });
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      // First pass returns the new car, later passes return the used one; empty
      // after that so paging stops.
      if (call === 1) return page(NEW_LISTING);
      if (call === 4) return page(USED_LISTING);
      return new Response(JSON.stringify({ num_found: 0, listings: [] }), { status: 200 });
    }) as typeof fetch;
    process.env.MARKETCHECK_API_KEY ??= "test-key";

    try {
      const base = {
        make: "Jeep",
        model: "Grand Cherokee L",
        drivetrain: "AWD",
        maxMileage: 60000,
        homeZip: "60601",
        carTypes: ["new"],
      };
      await adapter.search(ctx, { ...base, year: 2026, trim: "Limited" } as never);
      await adapter.search(ctx, { ...base, year: 2026, trim: "Limited Reserve" } as never);

      const h = await adapter.captureHistory!(ctx, { vin: NEW_LISTING.vin } as never);
      expect(h.accidentSeverity).toBe("none");
      expect(h.ownerCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("exterior-color filter", () => {
  const { applyHardFilters: hf } = { applyHardFilters };
  const snap = (color: string | null) =>
    ({
      vin: "1C4RJJBR5T8573441",
      trim: "Limited",
      drivetrain: "AWD",
      mileage: 4,
      price: 47455,
      exteriorColor: color,
      ownerCount: 0,
      accidentSeverity: "none",
      serviceIssueFlag: false,
      historyStatus: "verified",
    }) as unknown as ListingSnapshot;

  const cfg = {
    target: { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" },
    maxMileage: 60000,
    owners: 1,
    ownersAny: true,
    exteriorColors: ["Silver"],
  } as unknown as Parameters<typeof applyHardFilters>[1];

  it("keeps every marketing name inside the requested bucket", () => {
    // All four spellings seen in the live 2026 GC L feed.
    const names = ["Silver Zynith", "SILVER ZYNITH", "Silver", "Silver Zynith - Silver"];
    const r = hf(names.map(snap), cfg);
    expect(r.passed).toHaveLength(4);
  });

  it("rejects other colors", () => {
    const r = hf([snap("Bright White"), snap("Diamond Black Crystal Pearlcoat")], cfg);
    expect(r.passed).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]?.reason).toContain("exterior color");
  });

  it("does not reject a car whose color is unknown", () => {
    expect(hf([snap(null)], cfg).passed).toHaveLength(1);
  });

  it("is inert when no colors are configured", () => {
    const open = { ...cfg, exteriorColors: undefined } as typeof cfg;
    expect(hf([snap("Bright White")], open).passed).toHaveLength(1);
  });

  it("sends the color as a server-side facet", () => {
    const url = buildSearchUrl(
      {
        year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited",
        drivetrain: "AWD", maxMileage: 60000, homeZip: "60601",
        exteriorColors: ["Silver", "Gray"],
      } as never,
      "KEY", "new", 0,
    );
    expect(url).toContain("base_ext_color=Silver%2CGray");
  });
});

describe("allowUnknownMileage", () => {
  const base = {
    year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited",
    drivetrain: "AWD", maxMileage: 60000, homeZip: "60601",
  };
  it("sends miles_range by default", () => {
    expect(buildSearchUrl(base as never, "K", "new", 0)).toContain("miles_range=0-60000");
  });
  it("omits miles_range when unknown mileage is allowed", () => {
    // miles_range drops listings with no odometer — real new-car inventory.
    const url = buildSearchUrl({ ...base, allowUnknownMileage: true } as never, "K", "new", 0);
    expect(url).not.toContain("miles_range");
  });
  it("still enforces maxMileage locally on cars that report one", () => {
    const cfg = {
      target: { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" },
      maxMileage: 60000, owners: 1, ownersAny: true,
    } as unknown as Parameters<typeof applyHardFilters>[1];
    const mk = (mileage: number | null) =>
      ({
        vin: "1C4RJJBR5T8573441", trim: "Limited", drivetrain: "AWD", mileage,
        price: 47455, ownerCount: 0, accidentSeverity: "none",
        serviceIssueFlag: false, historyStatus: "verified",
      }) as unknown as ListingSnapshot;
    const r = applyHardFilters([mk(null), mk(4), mk(99000)], cfg);
    expect(r.passed).toHaveLength(2); // null + 4 miles
    expect(r.rejected[0]?.reason).toContain("mileage 99000");
  });
});

describe("per-target exterior colors", () => {
  // The 2026 GC L comes in Silver and the 2027 does not; the 2027's gray is
  // Sting-Gray, the 2026's is Baltic Gray. One global list cannot express that.
  const t2026 = { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" };
  const t2027 = { ...t2026, year: 2027, exteriorColors: ["Gray"] };
  const cfg = {
    target: t2026,
    extraTargets: [t2027],
    exteriorColors: ["Silver"],
    maxMileage: 60000,
    owners: 1,
    ownersAny: true,
  } as unknown as Parameters<typeof applyHardFilters>[1];

  it("sends each target its own color facet", () => {
    const mk = (t: Record<string, unknown>) =>
      buildSearchUrl(
        { ...t, maxMileage: 60000, homeZip: "60601",
          exteriorColors: (t.exteriorColors as string[]) ?? ["Silver"] } as never,
        "K", "new", 0,
      );
    expect(mk(t2026)).toContain("base_ext_color=Silver");
    expect(mk(t2027)).toContain("base_ext_color=Gray");
  });

  it("accepts both years' colors locally, rejects anything else", () => {
    const snap = (color: string) =>
      ({
        vin: "1C4RJKBR4T860423" + color.length, trim: "Limited", drivetrain: "AWD",
        mileage: 4, price: 47455, exteriorColor: color, ownerCount: 0,
        accidentSeverity: "none", serviceIssueFlag: false, historyStatus: "verified",
      }) as unknown as ListingSnapshot;
    const r = applyHardFilters(
      [snap("Silver Zynith"), snap("Sting-Gray Clearcoat"), snap("Bright White")],
      cfg,
    );
    expect(r.passed.map((s) => s.exteriorColor)).toEqual(["Silver Zynith", "Sting-Gray Clearcoat"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.snapshot.exteriorColor).toBe("Bright White");
  });
});

describe("multi-year report", () => {
  it("caps rows per year and offers a year toggle", async () => {
    const { renderRankedHtml } = await import("../src/reporter/reporter.js");
    const car = (year: number, rank: number, landed: number) =>
      ({
        rank, year, make: "Jeep", model: "Grand Cherokee L",
        vin: `VIN${year}${String(rank).padStart(3, "0")}`,
        landedPrice: landed, price: landed - 400, shippingEst: 400, mileage: 4,
        ownerCount: 0, accidentSeverity: "none", historyStatus: "verified",
        dealer: "D", location: "X, YZ", zip: "12345", exteriorColor: "C", monthly: [],
      }) as never;
    // 2026 is uniformly cheaper, so an overall top-2 cut would be all 2026.
    const buyable = [
      car(2026, 1, 40000), car(2026, 2, 41000), car(2026, 3, 42000),
      car(2027, 4, 50000), car(2027, 5, 51000),
    ];
    const cfg = {
      target: { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" },
      extraTargets: [{ year: 2027, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" }],
      reportTopN: 2, homeZip: "60601", financing: [],
    } as never;
    const html = renderRankedHtml(
      { buyable, unverified: [], rejected: [], ruledOut: [], changes: null } as never,
      cfg,
      "2026-08-30",
    );
    // Both years reach the page despite 2027 losing every price comparison.
    expect(html).toContain("VIN2026001");
    expect(html).toContain("VIN2027004");
    expect(html).not.toContain("VIN2026003"); // 3rd 2026 cut by the per-year cap
    expect(html).toContain('data-k="year"');
    expect(html).toContain('data-year="2027"');
  });
});

describe("dropdown filters", () => {
  it("builds a select per dimension from the rows actually present", async () => {
    const { renderRankedHtml } = await import("../src/reporter/reporter.js");
    const car = (o: Record<string, unknown>) =>
      ({
        rank: 1, make: "Jeep", model: "Grand Cherokee L", vin: "V" + JSON.stringify(o).length,
        landedPrice: 40000, price: 39600, shippingEst: 400, mileage: 4,
        accidentSeverity: "none", historyStatus: "verified", dealer: "D",
        zip: "12345", monthly: [], ...o,
      }) as never;
    const buyable = [
      car({ year: 2025, trim: "Limited", exteriorColor: "Silver Zynith", ownerCount: 1, location: "Toledo, OH" }),
      car({ year: 2026, trim: "Limited Reserve", exteriorColor: "Diamond Black Crystal Pearlcoat", ownerCount: 0, location: "Miami, FL" }),
      car({ year: 2027, trim: "Limited", exteriorColor: "Sting-Gray Clearcoat", ownerCount: 0, location: "Chillicothe, OH" }),
    ];
    const cfg = {
      target: { year: 2026, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" },
      extraTargets: [{ year: 2027, make: "Jeep", model: "Grand Cherokee L", trim: "Limited", drivetrain: "AWD" }],
      exteriorColors: ["Silver", "Black", "Gray"],
      reportTopN: 400, homeZip: "60601", financing: [],
    } as never;
    const html = renderRankedHtml(
      { buyable, unverified: [], rejected: [], ruledOut: [], changes: null } as never,
      cfg,
      "2026-08-30",
    );
    // One select per dimension that varies.
    for (const id of ["f-year", "f-color", "f-trim", "f-cond", "f-state"]) {
      expect(html).toContain(`id="${id}"`);
    }
    // Marketing names collapse into the configured buckets.
    expect(html).toContain('data-color="Silver"');
    expect(html).toContain('data-color="Black"');
    expect(html).toContain('data-color="Gray"');
    // Condition derives from ownerCount; state parses out of "City, ST".
    expect(html).toContain('data-cond="Used"');
    expect(html).toContain('data-cond="New"');
    expect(html).toContain('data-state="OH"');
    expect(html).toContain('data-state="FL"');
    // Duplicate values appear once in a dropdown (OH twice in the rows).
    expect(html.match(/<option value="OH">/g)).toHaveLength(1);
  });
});
