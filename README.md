# Vehicle Price Search

Shop a specific vehicle across the entire US market and rank every listing by
**landed price** — the listing price plus estimated shipping to your ZIP — not
by sticker.

A car $2,000 cheaper three states away is often not cheaper. Sticker-ordered
search results hide that. This does not.

Config-driven: adding a vehicle is editing JSON, never code. Ships as both a
runnable CLI and a [Claude Code](https://claude.com/claude-code) skill
(`SKILL.md`), so an agent can run the whole interview-to-published-page loop.

**[See a real run.](https://vehicle-price-search-example.vercel.app)** A 2024
Cadillac LYRIQ search published as a static page: the ranked buyable set, a
separate list of listings that need a human to verify owner count or title,
and every rejection with the filter that caused it. Point-in-time snapshot
from June 2026, not current pricing.

## What you get

A self-contained static HTML page plus a CSV:

- Every listing ranked by landed price, with monthly payments at your APRs
- Dropdown filters — year, color, trim, condition, state — with a live count
- Run-over-run diff: what is new, what dropped in price, what sold
- **Buyable** vs **verify by hand**, so an unconfirmed title is never presented
  as a clean one
- Per-VIN memory that survives re-runs: rule a car out, pin one the search
  misses, correct the feed from a real history report

## Quick start

```bash
cd engine
npm install
cp .env.example .env          # paste a MarketCheck API key
npm run init-db

cp config.json ~/my-search.json   # then edit it
SEARCH_CONFIG=~/my-search.json npm run search
SEARCH_CONFIG=~/my-search.json npm run publish
```

The bundle lands in `<outDir>/../publish` — `index.html`, `listings.csv`,
`robots.txt`. Deploy it anywhere static.

Needs Node 20+ and a [MarketCheck](https://www.marketcheck.com/apis) API key.

### Commands

| Command | What it does |
|---|---|
| `npm run search` | Query, filter, rank, write reports |
| `npm run publish` | Assemble the static bundle |
| `npm run re-report` | Re-render from the **stored** run — no API calls |
| `npm test` | 159 tests |

`re-report` matters more than it sounds: a wide search is several hundred API
calls and can take ten minutes. Use it whenever only the presentation changed.

## Configuring

```json
{
  "target": { "year": 2026, "make": "Jeep", "model": "Grand Cherokee L",
              "trim": "Limited", "drivetrain": "AWD",
              "exteriorColors": ["Silver", "Black"] },
  "extraTargets": [
    { "year": 2027, "make": "Jeep", "model": "Grand Cherokee L",
      "trim": "Limited", "drivetrain": "AWD",
      "exteriorColors": ["Gray", "Black"] }
  ],
  "carTypes": ["new", "used", "certified"],
  "allowUnknownMileage": true,
  "homeZip": "60601",
  "reportTopN": 400
}
```

Note the per-target colors. Manufacturers rename colors and add trims between
model years — that example is real, and the two years' "gray" are different
colors. Full field list in [`references/config-reference.md`](references/config-reference.md).

## Things that will bite you

Each of these produces a **plausible but wrong** result rather than an error.

- **The API returns at most 500 rows per query.** You cannot see a larger result
  set whole, only choose which 500. Queries sort cheapest-first so the visible
  ones are those that can win a landed-price ranking. Anything pricier is
  invisible — narrow the query to survey it.
- **New cars report `carfax_clean_title: false`.** A 4-mile car at a franchise
  dealer looks title-suspect. The adapter branches on `inventory_type` instead.
- **A mileage filter deletes cars reporting no mileage.** On one real search that
  hid the cheapest car in the country, ~$2,000 under the visible floor. Set
  `allowUnknownMileage: true` for new-car searches.
- **Filter colors server-side**, or the 500-row window fills with colors you are
  about to discard.

Details and probe recipes: [`references/marketcheck-api.md`](references/marketcheck-api.md).

## What this does not do

- **No scraping.** MarketCheck is a licensed API and the only source. The adapter
  interface is pluggable, but please do not add adapters that scrape retail
  listing sites — it breaks their terms and this project's posture.
- **Landed price is not out-the-door.** It excludes destination charge, dealer
  doc and filing fees, tax, title, and registration. Advertised prices often
  assume dealer financing or rebates you may not qualify for. Always confirm the
  total in writing.
- **It does not verify history.** The feed's owner and title flags are unreliable
  in both directions — it under-confirms clean titles *and* mis-flags genuine
  one-owner cars. Cars it cannot confirm go to "verify by hand," which is not a
  rejection: the cheapest car often lands there. Pull the real report before you
  buy.
- **Distance is banded, not routed.** A ZIP3 centroid table with a road-circuity
  factor, no geocoder, works offline. Good enough to pick a shipping band; not a
  driving distance.

## Publishing notes

The bundle sets `noindex` three ways (meta tag, robots.txt, `X-Robots-Tag`),
because these pages carry your shopping intent. That is **unlisted, not
private** — anyone with the link can read it.

On Vercel specifically: the project name comes from the deploy folder name, so
give each site its own folder, and never copy a `.vercel/` directory into it or
you will overwrite a different project.

## Layout

```
SKILL.md                    the agent-facing skill
references/                 config reference + API notes
engine/
  src/adapters/             pluggable sources (MarketCheck)
  src/analyst/              filters, ranking, distance, finance, diffing
  src/reporter/             HTML + Markdown + CSV output
  src/store/                SQLite snapshots, run history
  src/cli/                  search, publish, re-report, init-db
```

## Credits

Built by **[StrateGenix Solutions](https://github.com/strategenixsolutions-ux)**.

MIT licensed. Not affiliated with MarketCheck, or with any vehicle manufacturer
or dealer. Listing data belongs to its respective sources; you need your own
MarketCheck API key and are bound by their terms.
