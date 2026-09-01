import { describe, it, expect } from "vitest";
import { normalizeDrive, parseBatch, decodeDrivetrains } from "../src/collector/nhtsa.js";

describe("nhtsa normalizeDrive", () => {
  it("maps AWD / 4WD variants to AWD", () => {
    expect(normalizeDrive("AWD/All-Wheel Drive")).toBe("AWD");
    expect(normalizeDrive("4WD/4-Wheel Drive")).toBe("AWD");
    expect(normalizeDrive("All Wheel Drive")).toBe("AWD");
  });
  it("maps RWD / FWD", () => {
    expect(normalizeDrive("RWD/ Rear Wheel Drive")).toBe("RWD");
    expect(normalizeDrive("FWD/Front Wheel Drive")).toBe("FWD");
  });
  it("returns null for empty / unrecognized", () => {
    expect(normalizeDrive("")).toBeNull();
    expect(normalizeDrive(null)).toBeNull();
    expect(normalizeDrive("Unknown")).toBeNull();
  });
});

describe("nhtsa parseBatch", () => {
  const json = JSON.stringify({
    Results: [
      { VIN: "1GYKPSRL6RZ106372", DriveType: "AWD/All-Wheel Drive", Trim: "Lux-3" },
      { VIN: "1gykpsrl0rz999999", DriveType: "RWD/ Rear Wheel Drive" },
      { VIN: "", DriveType: "AWD" },
    ],
  });

  it("maps VIN(upper) -> DriveClass, skips blank VINs", () => {
    const m = parseBatch(json);
    expect(m.get("1GYKPSRL6RZ106372")).toBe("AWD");
    expect(m.get("1GYKPSRL0RZ999999")).toBe("RWD"); // upper-cased
    expect(m.has("")).toBe(false);
  });

  it("bad JSON -> empty map (never throws)", () => {
    expect(parseBatch("{not json").size).toBe(0);
  });
});

describe("nhtsa decodeDrivetrains", () => {
  it("batches VINs and returns the decoded map", async () => {
    let captured = "";
    const fakeFetch = async (_url: string, init?: { body?: string }) => {
      captured = init?.body ?? "";
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ Results: [{ VIN: "1GYKPSRL6RZ106372", DriveType: "AWD/All-Wheel Drive" }] }),
      };
    };
    const m = await decodeDrivetrains(["1GYKPSRL6RZ106372", "1gykpsrl6rz106372"], fakeFetch);
    expect(m.get("1GYKPSRL6RZ106372")).toBe("AWD");
    expect(captured).toContain("1GYKPSRL6RZ106372"); // deduped + sent
  });

  it("soft-fails to an empty map on HTTP error (run continues on source value)", async () => {
    const fail = async () => ({ ok: false, status: 503, text: async () => "" });
    const m = await decodeDrivetrains(["1GYKPSRL6RZ106372"], fail);
    expect(m.size).toBe(0);
  });

  it("soft-fails to an empty map on a thrown network error", async () => {
    const boom = async () => {
      throw new Error("network down");
    };
    const m = await decodeDrivetrains(["1GYKPSRL6RZ106372"], boom);
    expect(m.size).toBe(0);
  });

  it("empty input -> empty map, no fetch", async () => {
    let called = false;
    const f = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const m = await decodeDrivetrains([null, undefined, ""], f);
    expect(m.size).toBe(0);
    expect(called).toBe(false);
  });
});
