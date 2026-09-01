import { describe, it, expect } from "vitest";
import { Store } from "../src/store/store.js";
import { snap } from "./helpers.js";

describe("Store (node:sqlite, in-memory)", () => {
  it("creates a run and appends listings", () => {
    const store = Store.memory();
    const run = store.insertRun("source-a");
    expect(run.id).toBeGreaterThan(0);
    store.upsertListing(snap({ runId: run.id, vin: "1GYKPSRL2RZ100001" }));
    store.upsertListing(snap({ runId: run.id, vin: "1GYKPSRL2RZ100002", price: 61000 }));
    expect(store.getListingsForRun(run.id)).toHaveLength(2);
    store.close();
  });

  it("round-trips exterior_color through the listings table", () => {
    const store = Store.memory();
    const run = store.insertRun("marketcheck");
    store.upsertListing(snap({ runId: run.id, vin: "1GYKPSRL2RZ100001", exteriorColor: "Stellar Black Metallic" }));
    const row = store.getListingsForRun(run.id)[0]!;
    expect(row.exteriorColor).toBe("Stellar Black Metallic");
    store.close();
  });

  it("dedupes by VIN within a run (lowest price canonical)", () => {
    const store = Store.memory();
    const run = store.insertRun("source-a,cars");
    store.upsertListing(snap({ runId: run.id, vin: "1GYKPSRL2RZ100009", source: "source-a", price: 60000 }));
    store.upsertListing(snap({ runId: run.id, vin: "1GYKPSRL2RZ100009", source: "source-c", price: 58000 }));
    const canonical = store.getCanonicalListingsForRun(run.id);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.price).toBe(58000);
    expect(canonical[0]?.source).toBe("source-c");
    store.close();
  });

  it("getPreviousRun returns the prior run, history is appended not wiped", () => {
    const store = Store.memory();
    const r1 = store.insertRun("source-a");
    store.upsertListing(snap({ runId: r1.id }));
    const r2 = store.insertRun("source-a");
    store.upsertListing(snap({ runId: r2.id }));
    const prev = store.getPreviousRun(r2.id);
    expect(prev?.id).toBe(r1.id);
    // both runs still present
    expect(store.getListingsForRun(r1.id)).toHaveLength(1);
    expect(store.getListingsForRun(r2.id)).toHaveLength(1);
    store.close();
  });

  it("getPreviousRun SKIPS an empty/failed run (transient run must not poison the diff)", () => {
    const store = Store.memory();
    const r1 = store.insertRun("marketcheck");
    store.upsertListing(snap({ runId: r1.id, vin: "1GYKPSRL2RZ100001" }));
    const empty = store.insertRun("marketcheck"); // failed run: row created, 0 listings
    const r3 = store.insertRun("marketcheck");
    store.upsertListing(snap({ runId: r3.id, vin: "1GYKPSRL2RZ100001" }));
    // r3's previous must be r1 (the last POPULATED run), NOT the empty run.
    expect(store.getPreviousRun(r3.id)?.id).toBe(r1.id);
    // and the empty run alone has no earlier populated run
    expect(store.getPreviousRun(empty.id)?.id).toBe(r1.id);
    store.close();
  });

  it("rejects a malformed snapshot (missing vin) with a clear error", () => {
    const store = Store.memory();
    const run = store.insertRun("source-a");
    expect(() =>
      store.upsertListing(snap({ runId: run.id, vin: "" as unknown as string })),
    ).toThrow(/vin is required/);
    store.close();
  });

  it("rejects an invalid accident_severity at the validation layer", () => {
    const store = Store.memory();
    const run = store.insertRun("source-a");
    expect(() =>
      // @ts-expect-error deliberately invalid enum value
      store.upsertListing(snap({ runId: run.id, accidentSeverity: "totaled" })),
    ).toThrow(/accidentSeverity/);
    store.close();
  });

  it("getListingHistoryByVin returns snapshots across runs", () => {
    const store = Store.memory();
    const r1 = store.insertRun("source-a");
    store.upsertListing(snap({ runId: r1.id, vin: "1GYKPSRL2RZ100001", price: 60000 }));
    const r2 = store.insertRun("source-a");
    store.upsertListing(snap({ runId: r2.id, vin: "1GYKPSRL2RZ100001", price: 59000 }));
    const hist = store.getListingHistoryByVin("1GYKPSRL2RZ100001");
    expect(hist).toHaveLength(2);
    store.close();
  });

  it("refuses a DB path inside OneDrive (PII / sync guard)", () => {
    expect(() => Store.init("C:\\OneDrive\\stuff\\test.db")).toThrow(/OneDrive/);
  });

  it("schema has NO raw-report-body column (PII minimization)", () => {
    const store = Store.memory();
    // Reflect on the listings table columns via a sentinel insert + read.
    const run = store.insertRun("source-a");
    store.upsertListing(snap({ runId: run.id }));
    const row = store.getListingsForRun(run.id)[0]!;
    const keys = Object.keys(row);
    for (const forbidden of ["reportText", "carfax", "rawReport", "history_body", "ownerName", "ownerAddress"]) {
      expect(keys).not.toContain(forbidden);
    }
    store.close();
  });
});
