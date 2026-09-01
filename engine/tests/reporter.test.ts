import { describe, it, expect } from "vitest";
import { analyze } from "../src/analyst/analyst.js";
import { diffRuns } from "../src/analyst/changes.js";
import {
  renderRankedMd,
  renderRankedHtml,
  renderListingsCsv,
  renderChangesMd,
  csvCell,
  buildReports,
} from "../src/reporter/reporter.js";
import { testConfig, snap } from "./helpers.js";

const cfg = testConfig();

function sampleResult() {
  return analyze(
    [
      snap({ vin: "1GYKPSRL2RZ100001", zip: "48226", price: 58000, dealer: "A, with comma" }),
      snap({ vin: "1GYKPSRL2RZ100004", historyStatus: "unverified", accidentSeverity: "unknown", ownerCount: null }),
    ],
    cfg,
  );
}

describe("reporter renderers", () => {
  it("ranked.md has a buyable table + a separate unverified section", () => {
    const md = renderRankedMd(sampleResult(), cfg);
    expect(md).toContain("## Buyable");
    expect(md).toContain("## Verify by hand");
    expect(md).toContain("1GYKPSRL2RZ100001");
    expect(md).toContain("$/mo@60");
    expect(md).toContain(cfg.referenceVin); // baseline noted in header
  });

  it("listings.csv has a header row + escapes commas", () => {
    const csv = renderListingsCsv(sampleResult());
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("vin");
    expect(lines[0]).toContain("landed_price");
    // dealer "A, with comma" must be quoted
    expect(csv).toContain('"A, with comma"');
  });

  it("csvCell quotes commas/quotes/newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("changes-<date>.md states baseline on first run", () => {
    const md = renderChangesMd(diffRuns([snap()], null));
    expect(md).toContain("baseline run — no prior run to diff");
  });

  it("changes-<date>.md lists NEW/DROP/GONE on a real diff", () => {
    const prev = [snap({ vin: "1GYKPSRL2RZ100002", price: 62000 }), snap({ vin: "1GYKPSRL2RZ100003" })];
    const curr = [snap({ vin: "1GYKPSRL2RZ100002", price: 60000 }), snap({ vin: "1GYKPSRL2RZ100009" })];
    const md = renderChangesMd(diffRuns(curr, prev));
    expect(md).toMatch(/## NEW \(1\)/);
    expect(md).toMatch(/## PRICE DROP \(1\)/);
    expect(md).toMatch(/## GONE \(1\)/);
  });

  it("renders a PO-hand-verified car in the buyable section with its note", () => {
    const vin = "1GYKPSRL2RZ100009";
    const c = { ...cfg, verifiedClean: { [vin]: "Hand-checked 2026-06-21: clean, CPO" } };
    // accidentSeverity "unknown" would normally route to verify-by-hand;
    // verifiedClean promotes it into buyable.
    const res = analyze([snap({ vin, accidentSeverity: "unknown" })], c);
    expect(res.buyable.map((b) => b.vin)).toContain(vin);
    expect(res.unverified.map((u) => u.vin)).not.toContain(vin);
    const md = renderRankedMd(res, c);
    expect(md).toContain("Hand-checked 2026-06-21: clean, CPO");
    expect(md).toContain("hand-verified");
  });

  it("carries the hand-verified note into the CSV service_history_note column (escaped), for the buyable row", () => {
    // Regression: the verifiedClean note reaches listings.csv
    // via the shared serviceHistoryNote() helper. This pins that as an asserted,
    // note-level decision (RFC-4180 escaped, in the buyable bucket) rather than an
    // untested side effect.
    const vin = "1GYKPSRL2RZ100009";
    const note = "Hand-checked 2026-06-21: clean, CPO";
    const c = { ...cfg, verifiedClean: { [vin]: note } };
    const res = analyze([snap({ vin, accidentSeverity: "unknown" })], c);
    const csv = renderListingsCsv(res);
    const row = csv.trim().split("\n").find((l) => l.includes(vin));
    expect(row).toBeDefined();
    expect(row).toContain(",buyable,"); // promoted into the buyable bucket
    // note has a comma -> RFC-4180 quoted
    expect(csv).toContain(`"${note}"`);
  });

  it("marks a pinned car with a visible tag + note line in the HTML (no service column on the page)", () => {
    const c = {
      ...cfg,
      pinnedListings: {
        "1GYKPSRL6RZ106372": {
          price: 45791, mileage: 12661, dealer: "Germain Cadillac Of Easton",
          location: "Columbus, OH", zip: "43219", drivetrain: "AWD", trim: "Luxury 3",
          url: "https://www.germaincadillacofeaston.com/inventory/x/",
          exteriorColor: "Opulent Blue Metallic", ownerCount: 1,
          accidentSeverity: "unknown" as const,
          note: "ADDED BY YOU. VERIFY drivetrain (MarketCheck said RWD).",
        },
      },
    };
    const res = analyze([snap({ vin: "1GYKPSRL2RZ100001", price: 58000 })], c);
    const html = renderRankedHtml(res, c, "2026-06-21");
    expect(html).toContain('class="tag pin">pinned</span>'); // visible pinned tag
    expect(html).toContain("ADDED BY YOU. VERIFY drivetrain (MarketCheck said RWD)."); // visible note line
    expect(html).toContain("pinnote");
  });

  it("escapes a hostile pinned note in the HTML (no stored XSS)", () => {
    const c = {
      ...cfg,
      pinnedListings: {
        "1GYKPSRL6RZ106372": {
          price: 45791, dealer: "X", location: "Columbus, OH", drivetrain: "AWD", trim: "Luxury 3",
          accidentSeverity: "unknown" as const,
          note: "<script>alert(1)</script>",
        },
      },
    };
    const html = renderRankedHtml(analyze([snap()], c), c, "2026-06-21");
    expect(html).not.toContain("<script>alert(1)</script>"); // rendered inert
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders a 'Ruled out by you' section only when there are ruled-out VINs", () => {
    // none -> no section
    expect(renderRankedMd(sampleResult(), cfg)).not.toContain("Ruled out by you");
    // present -> section with the reason
    const c = { ...cfg, ruledOut: { "1GYKPSRL2RZ100009": "branded — NO GO" } };
    const res = analyze([snap({ vin: "1GYKPSRL2RZ100009", ownerCount: 2 })], c);
    const md = renderRankedMd(res, c);
    expect(md).toContain("## Ruled out by you");
    expect(md).toContain("branded — NO GO");
    expect(md).toContain("1GYKPSRL2RZ100009");
  });

  it("makes the dealer name a Google Maps link (md + html), URL-encoded, dealer label carries the state", () => {
    const res = analyze(
      [snap({ vin: "1GYKPSRL2RZ100001", dealer: "Germain Cadillac Of Easton", location: "Columbus, OH", zip: "43219" })],
      cfg,
    );
    const md = renderRankedMd(res, cfg);
    // markdown link form [name, ST](url) with an encoded query (state folded into the label)
    expect(md).toContain("[Germain Cadillac Of Easton, OH](https://www.google.com/maps/search/?api=1&query=");
    expect(md).toContain("Germain%20Cadillac%20Of%20Easton");
    expect(md).toContain("Columbus%2C%20OH"); // comma encoded -> no broken md table cell
    expect(md).toContain("43219");

    const html = renderRankedHtml(res, cfg, "2026-06-21");
    expect(html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query='); // & escaped in attr
    expect(html).toContain('rel="noopener"');
    expect(html).toContain("Show dealership on Google Maps");
    expect(html).toContain("Germain Cadillac Of Easton, OH"); // state in the dealer cell
  });

  it("folds state into the dealer cell and repurposes the location column as Color (md + html)", () => {
    const res = analyze(
      [snap({ vin: "1GYKPSRL2RZ100001", dealer: "Germain Cadillac Of Easton", location: "Columbus, OH", exteriorColor: "Stellar Black Metallic" })],
      cfg,
    );
    const md = renderRankedMd(res, cfg);
    // header column is now Color, not Location
    expect(md).toContain("| Dealer | Color | Source | Link |");
    expect(md).not.toContain("| Dealer | Location | Source | Link |");
    // color shows in the row; dealer carries the state
    expect(md).toContain("Stellar Black Metallic");
    expect(md).toContain("Germain Cadillac Of Easton, OH");

    const html = renderRankedHtml(res, cfg, "2026-06-21");
    expect(html).toContain("<th>Color</th>");
    expect(html).toContain("Stellar Black Metallic");
  });

  it("output carries no raw report text (PII boundary)", () => {
    const md = renderRankedMd(sampleResult(), cfg);
    const csv = renderListingsCsv(sampleResult());
    for (const banned of ["CARFAX", "prior owner", "owner address", "report body"]) {
      expect(md.toLowerCase()).not.toContain(banned.toLowerCase());
      expect(csv.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("buildReports produces the dated changes filename", () => {
    const files = buildReports(sampleResult(), diffRuns([snap()], null), cfg, "2026-06-15");
    expect(files.changesFileName).toBe("changes-2026-06-15.md");
  });
});
