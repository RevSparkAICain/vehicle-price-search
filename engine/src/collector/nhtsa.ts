/**
 * NHTSA vPIC VIN decoder (free US-gov API, no key) — an AUTHORITATIVE cross-check
 * for VIN-ENCODED specs (drivetrain, trim, year, make/model).
 *
 * WHY: MarketCheck's drivetrain field is unreliable — it mislabeled a real 2024
 * the target vehicle Luxury 3 AWD as "RWD", which (with the drivetrain facet on the search)
 * silently excluded it. Drivetrain is encoded in the VIN, so NHTSA can settle it
 * definitively. We decode every collected VIN and treat NHTSA's DriveType as the
 * source of truth for the AWD hard filter; MarketCheck's value is only a fallback
 * when NHTSA has no answer (or is unreachable).
 *
 * WHAT THIS CANNOT DO: owner count, clean title, and accidents are NOT encoded in
 * the VIN — NHTSA cannot verify them. Those stay MarketCheck-relayed CarFax flags
 * (now routed to verify-by-hand, never hard-rejected) confirmed by a manual CarFax.
 *
 * SECURITY: the only datum sent out is the VIN — already public (printed on the
 * windshield + already on the published results page). No API key, no PII, no
 * secret leaves the process. Read-only POST to the documented batch endpoint.
 * Soft-fails closed: any error/!ok returns an empty map and the caller keeps the
 * existing (MarketCheck) drivetrain, so NHTSA being down never breaks a run.
 */

export type DriveClass = "AWD" | "RWD" | "FWD";

const BATCH_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesBatch/";
export const NHTSA_HOST = "vpic.nhtsa.dot.gov";
/** vPIC batch decode accepts up to 50 VINs per request. */
const BATCH_SIZE = 50;

/** Normalize an NHTSA DriveType string to AWD/RWD/FWD (4WD counts as AWD here). */
export function normalizeDrive(text: unknown): DriveClass | null {
  if (text == null) return null;
  const t = String(text).toUpperCase();
  if (/\bAWD\b|ALL[- ]?WHEEL|\b4WD\b|4X4|4[- ]?WHEEL/.test(t)) return "AWD";
  if (/\bRWD\b|REAR[- ]?WHEEL/.test(t)) return "RWD";
  if (/\bFWD\b|FRONT[- ]?WHEEL/.test(t)) return "FWD";
  return null;
}

/**
 * PURE: parse a vPIC DecodeVinValuesBatch JSON response into VIN(upper) ->
 * DriveClass. Tolerant: bad JSON / missing fields -> empty or partial map, never
 * throws. Unrecognized DriveType maps to null (caller keeps the source value).
 */
export function parseBatch(jsonText: string): Map<string, DriveClass | null> {
  const map = new Map<string, DriveClass | null>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return map;
  }
  const results = (parsed as { Results?: unknown })?.Results;
  if (!Array.isArray(results)) return map;
  for (const row of results) {
    const r = row as Record<string, unknown>;
    const vin = (r?.VIN == null ? "" : String(r.VIN)).toUpperCase();
    if (!vin) continue;
    map.set(vin, normalizeDrive(r?.DriveType));
  }
  return map;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Decode the drivetrain of each VIN via NHTSA vPIC (batched, <=50/request).
 * Returns VIN(upper) -> DriveClass|null. Soft-fails to an empty map on any
 * network/HTTP error so a vPIC outage never breaks the run (caller falls back to
 * the source-reported drivetrain). Injectable fetch keeps it unit-testable.
 */
export async function decodeDrivetrains(
  vins: Array<string | null | undefined>,
  doFetch: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<Map<string, DriveClass | null>> {
  const uniq = [...new Set(vins.filter((v): v is string => !!v).map((v) => v.toUpperCase()))];
  const out = new Map<string, DriveClass | null>();
  for (let i = 0; i < uniq.length; i += BATCH_SIZE) {
    const chunk = uniq.slice(i, i + BATCH_SIZE);
    try {
      const body = `format=json&data=${encodeURIComponent(chunk.join(";"))}`;
      const res = await doFetch(BATCH_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) continue; // soft-fail this chunk -> caller keeps source value
      for (const [vin, drive] of parseBatch(await res.text())) out.set(vin, drive);
    } catch {
      // network error -> soft-fail (empty for this chunk); run continues
    }
  }
  return out;
}
