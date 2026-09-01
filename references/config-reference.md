# Config reference

One JSON file describes a search. Point the CLI at it with `SEARCH_CONFIG`;
with no env var it falls back to `engine/config.json` (the shipped example).

```bash
SEARCH_CONFIG=/path/to/my-search.json npm run search
```

Keep your config **outside this repo** — it holds your home ZIP and your
shortlist.

## Required

| Field | Type | Notes |
|---|---|---|
| `target` | object | The primary vehicle. See Target below. |
| `maxMileage` | int | Upper bound. A listing reporting no mileage is never rejected by it. |
| `owners` | int | Expected owner count. Inert when `ownersAny` is true. |
| `accidentsAllowed` | `"none"` \| `"minor"` | Worst acceptable severity. |
| `homeZip` | 5-digit string | Shipping distance is measured from here. |
| `referenceVin` | string | Tagged "baseline" in the report if present in results. |
| `sources` | array | `[{ name, enabled }]`. This repo ships `marketcheck`. |
| `shippingBands` | array | `{ maxDistanceMi, cost }`; exactly one band with `null` = catch-all. |
| `financing` | array | `{ apr, months }` — one monthly-payment column each. |
| `pacing` | object | `minActionDelayMs`, `maxActionDelayMs`, `perDomainMinIntervalMs`. |
| `paths` | object | `dbFile`, `profilesDir`, `outDir`, `scratchDir`, `resultsCopyDir`. |

### Target

```json
{ "year": 2026, "make": "Jeep", "model": "Grand Cherokee L",
  "trim": "Limited", "drivetrain": "AWD",
  "fuelType": "Electric", "exteriorColors": ["Silver", "Black"] }
```

- `trim: "*"` matches all trims (omits the facet, skips the local check).
- `drivetrain` uses your vocabulary (`AWD`); the adapter maps it to the feed's
  (`4WD`) when the facet is enabled.
- `fuelType` narrows a model name that spans powertrains (a "Niro" is HEV, PHEV,
  and BEV).
- `exteriorColors` here **overrides** the run-level list for this target only.

## Optional

| Field | Default | What it does |
|---|---|---|
| `extraTargets` | — | More vehicles in the same run; results merge into one ranking. |
| `carTypes` | `["used","certified"]` | Which inventory to query. **Add `"new"` for a current-model-year search** or you will see a rounding error of the real market. |
| `maxPrice` / `minPrice` | — | Server-side price bounds. Set `minPrice` (e.g. 1000) to drop "call for price" listings, which sort first and eat the 500-row window. |
| `ownersAny` | false | Owner count stops gating "buyable". |
| `allowUnknownMileage` | false | Stop sending `miles_range`, which deletes listings with no odometer. **Set true on new-car searches.** |
| `useDrivetrainFacet` | false | Filter drivetrain server-side. Off by default because feeds mislabel drivetrain; on when the 500-row window matters. |
| `exteriorColors` | — | Run-level color buckets (`["Silver","Black"]`). Sent as a server-side facet. |
| `reportTopN` | all | Rows the HTML renders — **per model year** on a multi-year search. CSV always has everything. |
| `title` | generic | Report heading. |
| `feeDisclaimer` | — | Renders under the header. Keep it accurate. |

## Per-VIN memory

All keyed by uppercase VIN, all survive re-runs:

- `ruledOut` — `{ VIN: "why" }`. Pulled before filtering and shown separately; never resurfaces in the diff.
- `verifiedClean` — `{ VIN: "note" }`. Promotes a hand-checked car to buyable. Only for a car that already passes every other filter.
- `accidentOverrides` — `{ VIN: severity }`. Corrects the feed from a real history report.
- `shippingOverrides` — `{ VIN: dollars }`. A firm quote instead of the band estimate.
- `urlOverrides` — `{ VIN: url }`. http(s) only, enforced at load.
- `pinnedListings` — a car the facet search misses but you want ranked anyway.

Notes render on a public page, so keep them note-level: no names, plates, phone
numbers, or addresses.

## Validation

Config is parsed through a schema at load. A bad field produces a message naming
that field, not a stack trace. Two rules are enforced beyond types: exactly one
catch-all shipping band, and no working path inside a cloud-synced folder
(sync locks the database mid-run).
