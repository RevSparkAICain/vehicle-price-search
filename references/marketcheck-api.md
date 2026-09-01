# MarketCheck API notes

Endpoint: `https://api.marketcheck.com/v2/search/car/active`
Key: `api_key` query param, read from `MARKETCHECK_API_KEY`. Never log a raw
URL — use the adapter's `redactKey()`.

## Probe before you configure

Facet strings are exact-match. A wrong one returns zero rows and looks like "no
inventory" rather than an error. Always confirm against the live API first.

**Does the model name exist, and how much is there?**

```bash
curl -s "https://api.marketcheck.com/v2/search/car/active?api_key=$KEY\
&make=Jeep&model=Grand%20Cherokee%20L&year=2026&car_type=new&rows=0" | jq .num_found
```

**What trims / drivetrains / colors does this model year actually have?**

```bash
curl -s "https://api.marketcheck.com/v2/search/car/active?api_key=$KEY\
&make=Jeep&model=Grand%20Cherokee%20L&year=2026&car_type=new&rows=0\
&facets=trim,drivetrain,base_ext_color,exterior_color" | jq '.facets'
```

Run this **per model year**. Trims launch and get dropped; colors get renamed.
Real examples from one vehicle: the 2027 had no silver at all, the Limited
Reserve trim did not exist before 2026, and "gray" was a different color in each
year (Baltic Gray vs Sting-Gray).

## Fields that matter

| Field | Notes |
|---|---|
| `inventory_type` | `"new"` / `"used"`. The **only** reliable new-car signal. |
| `price` | Absent on ~25% of listings ("call for price"). |
| `msrp` | Present on new cars — discount off MSRP is the real new-car metric. |
| `miles` | Often absent on new inventory. See `miles_range` below. |
| `build.*` | year, make, model, trim, drivetrain, fuel_type, body. |
| `dealer.*` | name, city, state, zip. Also mirrored under `mc_dealership`. |
| `base_ext_color` | Normalized bucket (Silver / Gray / Black). **Filter on this.** |
| `exterior_color` | Marketing name. One bucket spanned seven spellings in one feed. |
| `carfax_1_owner` / `carfax_clean_title` | Unreliable both ways — see below. |
| `vdp_url` | Dealer detail page. |
| `in_transit` | Not yet on the lot. |

## Query params

| Param | Notes |
|---|---|
| `car_type` | `new` / `used` / `certified`. One pass each, merged by VIN. |
| `trim` | Exact facet. Omit for all trims. |
| `drivetrain` | Feed vocabulary (`4WD`, not `AWD`). |
| `base_ext_color` | Comma-separated for several: `Silver,Gray`. |
| `price_range` | `min-max`. |
| `miles_range` | `min-max`. **Excludes listings with no `miles` field.** |
| `fuel_type` | e.g. `Electric`. |
| `sort_by` / `sort_order` | `price` + `asc` — see the window limit. |
| `start` / `rows` | Paging, 50 per page. |
| `facets` | Comma-separated facet names; pair with `rows=0`. |

Omitting zip + radius returns nationwide results. The free tier caps `radius` at
100 miles, so do not send one — compute distance locally from the dealer ZIP.

## The three traps

**500-row window.** `start=500` returns HTTP 422. You cannot page past the first
500 rows of any query. Sort cheapest-first so those 500 are the ones that can win
a landed-price ranking, and narrow the query (state, price band, trim) when you
need to see further up the price curve.

**New cars report false history flags.** A 4-mile car at a franchise dealer comes
back `carfax_1_owner: false`, `carfax_clean_title: false`. Taken literally, every
new car is title-suspect. Branch on `inventory_type === "new"` and treat those as
zero-owner and clean — a factory-new vehicle has no history to verify.

**`miles_range` deletes no-odometer listings.** Common on new inventory. Skip the
param and enforce the cap locally instead.

## Rate and volume

Pace requests (the engine does, per domain). A wide multi-target search is
200-400 calls: 4 targets x 3 `car_type` passes x up to 10 pages. Check your tier
before running one, and prefer `npm run re-report` when only the presentation
changed.
