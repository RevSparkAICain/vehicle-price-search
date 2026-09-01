import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, defaultConfigPath } from "../src/config.js";

function writeTmpConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "vps-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

describe("config loader", () => {
  it("loads + validates the shipped example config.json", () => {
    // Asserts SHAPE, not one person's search. Edit config.json freely — the
    // only contract this test defends is that the shipped example still parses
    // and that every required field survives.
    const cfg = loadConfig(defaultConfigPath());
    expect(cfg.target.make).toBeTruthy();
    expect(cfg.target.model).toBeTruthy();
    expect(cfg.target.year).toBeGreaterThan(1980);
    expect(cfg.homeZip).toMatch(/^[0-9][0-9][0-9][0-9][0-9]$/);
    expect(cfg.maxMileage).toBeGreaterThan(0);
    expect(cfg.shippingBands.filter((b) => b.maxDistanceMi === null)).toHaveLength(1);
    expect(cfg.financing.length).toBeGreaterThan(0);
    // MarketCheck is the only source shipped in this repo.
    const mc = cfg.sources.find((s) => s.name === "marketcheck");
    expect(mc?.enabled).toBe(true);
  });

  it("rejects a working path inside any cloud-synced folder", () => {
    // Sync clients lock the SQLite file mid-run. OneDrive is not the only one.
    const base = loadConfig(defaultConfigPath());
    for (const dir of ["C:/OneDrive/x.db", "/home/u/Dropbox/x.db", "/Users/u/Google Drive/x.db", "/Users/u/iCloud/x.db"]) {
      const broken = { ...base, paths: { ...base.paths, dbFile: dir } };
      expect(() => loadConfig(writeTmpConfig(broken))).toThrow(/dbFile/);
    }
  });

  it("allows the results COPY dir to live in a synced folder", () => {
    // That target only ever receives finished artifacts — syncing it is the point.
    const base = loadConfig(defaultConfigPath());
    const ok = { ...base, paths: { ...base.paths, resultsCopyDir: "C:/OneDrive/results" } };
    expect(() => loadConfig(writeTmpConfig(ok))).not.toThrow();
  });

  it("names the offending field on a missing required value (not a raw stack)", () => {
    const bad = { target: { year: 2024 } };
    expect(() => loadConfig(writeTmpConfig(bad))).toThrow(/target\.make|maxMileage|homeZip/);
  });

  it("rejects a non-5-digit homeZip with a field-named message", () => {
    const base = loadConfig(defaultConfigPath());
    const broken = { ...base, homeZip: "ABC" };
    expect(() => loadConfig(writeTmpConfig(broken))).toThrow(/homeZip/);
  });

  it("rejects a non-http(s) urlOverrides value (no javascript:/data: href injection)", () => {
    const base = loadConfig(defaultConfigPath());
    const broken = {
      ...base,
      urlOverrides: { "1GYKPSRL6RZ105867": "javascript:alert(1)" },
    };
    expect(() => loadConfig(writeTmpConfig(broken))).toThrow(/urlOverrides|http/i);
  });

  it("rejects a non-http(s) pinnedListings url (same href-injection guard)", () => {
    const base = loadConfig(defaultConfigPath());
    const broken = {
      ...base,
      pinnedListings: { "1GYKPSRL6RZ106372": { url: "javascript:alert(1)" } },
    };
    expect(() => loadConfig(writeTmpConfig(broken))).toThrow(/http|url/i);
  });

  it("rejects a working path that points inside OneDrive", () => {
    const base = loadConfig(defaultConfigPath());
    const broken = {
      ...base,
      paths: { ...base.paths, dbFile: "C:\\OneDrive\\test.db" },
    };
    expect(() => loadConfig(writeTmpConfig(broken))).toThrow(/OneDrive/);
  });

  it("clear error when file is missing", () => {
    expect(() => loadConfig("C:\\definitely\\not\\here\\config.json")).toThrow(/not found|unreadable/);
  });
});
