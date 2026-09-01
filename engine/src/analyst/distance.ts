/**
 * Offline distance estimate between two US ZIP codes.
 *
 * METHOD (documented, and it is an ESTIMATE — not a routed driving distance):
 *   1. Reduce each ZIP to its ZIP3 (first three digits = a "Sectional Center
 *      Facility" region) and look up an approximate lat/lon centroid for that
 *      ZIP3 from a compact bundled table.
 *   2. Great-circle (haversine) distance between the two centroids, in miles.
 *   3. Multiply by a 1.18 road-circuity factor so the band lands closer to
 *      real transport mileage than straight-line.
 *
 * FALLBACK: if a ZIP3 isn't in the bundled table, fall back to a coarse
 * first-digit (national region) centroid. If even that is unknown, return a
 * conservative national-average of 1500mi (lands a car in the top shipping
 * band rather than under-pricing shipping). All of this is intentionally
 * pragmatic: shipping is a banded cost, so we only need the right *band*, not
 * a precise odometer mile.
 *
 * No network, no external geocoder — bundled data only, so it is unit-testable
 * and works offline.
 */

interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Compact ZIP3 -> approximate centroid table. Not exhaustive — seeded with the
 * home region (48x = SE Michigan) and a spread of common dealer metros so the
 * estimate is meaningful for realistic dealer locations. Unknown ZIP3s
 * fall through to the first-digit region table below.
 */
const ZIP3_CENTROIDS: Record<string, LatLon> = {
  // Seeded metros. homeZip is a PARAMETER — any US ZIP works; unseeded ones
  // fall back to the first-digit region table below (coarser, still banded).
  "481": { lat: 42.33, lon: -83.05 }, // Detroit, MI
  "482": { lat: 42.33, lon: -83.05 },
  "483": { lat: 42.6, lon: -83.2 },
  "484": { lat: 43.0, lon: -83.7 }, // Flint, MI
  "490": { lat: 42.29, lon: -85.59 }, // Kalamazoo, MI
  "492": { lat: 42.96, lon: -85.67 }, // Grand Rapids, MI
  // Pacific NW — Pacific NW metros
  "970": { lat: 45.52, lon: -122.68 }, // Portland, OR
  "972": { lat: 45.52, lon: -122.68 }, // Portland, OR
  "980": { lat: 47.61, lon: -122.33 }, // Seattle, WA
  "981": { lat: 47.61, lon: -122.33 },
  // California
  "900": { lat: 34.05, lon: -118.24 }, // Los Angeles, CA
  "941": { lat: 37.77, lon: -122.42 }, // San Francisco, CA
  "945": { lat: 37.8, lon: -122.27 }, // Oakland, CA
  "921": { lat: 32.72, lon: -117.16 }, // San Diego, CA
  // Texas
  "750": { lat: 32.78, lon: -96.8 }, // Dallas, TX
  "770": { lat: 29.76, lon: -95.37 }, // Houston, TX
  "787": { lat: 30.27, lon: -97.74 }, // Austin, TX
  // Midwest / Great Lakes
  "606": { lat: 41.88, lon: -87.63 }, // Chicago, IL
  "432": { lat: 39.96, lon: -82.99 }, // Columbus, OH
  "441": { lat: 41.5, lon: -81.69 }, // Cleveland, OH
  "452": { lat: 39.1, lon: -84.51 }, // Cincinnati, OH
  "462": { lat: 39.77, lon: -86.16 }, // Indianapolis, IN
  // Northeast
  "100": { lat: 40.71, lon: -74.01 }, // New York, NY
  "021": { lat: 42.36, lon: -71.06 }, // Boston, MA
  "191": { lat: 39.95, lon: -75.17 }, // Philadelphia, PA
  "200": { lat: 38.9, lon: -77.04 }, // Washington, DC
  // Southeast
  "300": { lat: 33.75, lon: -84.39 }, // Atlanta, GA
  "331": { lat: 25.76, lon: -80.19 }, // Miami, FL
  "327": { lat: 28.54, lon: -81.38 }, // Orlando, FL
  "282": { lat: 35.23, lon: -80.84 }, // Charlotte, NC
  "372": { lat: 36.16, lon: -86.78 }, // Nashville, TN
  // Mountain West
  "802": { lat: 39.74, lon: -104.99 }, // Denver, CO
  "850": { lat: 33.45, lon: -112.07 }, // Phoenix, AZ
  "841": { lat: 40.76, lon: -111.89 }, // Salt Lake City, UT
};

/**
 * Coarse first-digit (national region) centroids. USPS first-digit zones run
 * roughly NE (0) -> West (9). Used when a ZIP3 isn't in the detailed table.
 */
const ZIP1_CENTROIDS: Record<string, LatLon> = {
  "0": { lat: 42.36, lon: -71.06 }, // New England
  "1": { lat: 40.71, lon: -74.01 }, // NY / NJ / PA-east
  "2": { lat: 38.9, lon: -77.04 }, // DC / mid-Atlantic / Carolinas
  "3": { lat: 33.75, lon: -84.39 }, // Southeast / FL
  "4": { lat: 39.96, lon: -82.99 }, // OH / IN / MI / KY
  "5": { lat: 44.98, lon: -93.27 }, // Upper Midwest (MN/IA/WI/Dakotas)
  "6": { lat: 39.1, lon: -94.58 }, // IL / MO / KS / NE
  "7": { lat: 32.78, lon: -96.8 }, // TX / OK / LA / AR
  "8": { lat: 39.74, lon: -104.99 }, // Mountain West
  "9": { lat: 37.77, lon: -122.42 }, // West Coast
};

const ROAD_CIRCUITY = 1.18;
const NATIONAL_FALLBACK_MI = 1500;
const EARTH_RADIUS_MI = 3958.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in miles between two lat/lon points. */
export function haversineMi(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

function centroidForZip(zip: string): LatLon | null {
  const z = zip.trim();
  if (z.length < 1) return null;
  const zip3 = z.slice(0, 3).padStart(3, "0");
  const direct = ZIP3_CENTROIDS[zip3];
  if (direct) return direct;
  const region = ZIP1_CENTROIDS[z[0] as string];
  return region ?? null;
}

/**
 * Estimate transport distance in miles between two ZIPs. Pragmatic, banded
 * estimate per the method documented above. Returns a non-negative integer.
 */
export function estimateDistanceMi(homeZip: string, listingZip: string | null): number {
  if (!listingZip) return NATIONAL_FALLBACK_MI;
  const home = centroidForZip(homeZip);
  const dest = centroidForZip(listingZip);
  if (!home || !dest) return NATIONAL_FALLBACK_MI;
  const straight = haversineMi(home, dest);
  return Math.round(straight * ROAD_CIRCUITY);
}
