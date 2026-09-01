---
name: vehicle-price-search
description: Use when someone wants to shop for a specific vehicle across the whole US market - "find me the cheapest X", "track prices on a Y", "build me a car search" - or wants to refresh, refine, or re-host an existing vehicle search. Ranks real listings by LANDED price (listing + estimated shipping to their ZIP) and publishes a filterable static page.
---

# Vehicle Price Search

Turn "I want to buy a 2026 Grand Cherokee L Limited 4x4 in silver" into a live,
filterable, national price ranking — ordered by what the car actually costs to
get into their driveway, not by sticker.

The engine is config-driven. **Adding a vehicle is editing JSON, never code.**

## The one thing that makes this different

Everything ranks by **landed price** = listing price + estimated shipping from
the dealer's ZIP to the buyer's. A $2,000-cheaper car three states away is often
not cheaper. Sticker rankings hide that; this does not.

## Workflow

1. **Interview** — get vehicle, years, trims, drivetrain, budget, home ZIP, and
   which colors (if any). Ask about colors explicitly: it is the filter people
   forget and it changes the whole result set.
2. **Probe before configuring.** Never guess a facet string. Run the probes in
   `references/marketcheck-api.md` to confirm the model name, trims, drivetrain
   label, and color buckets *for those model years*. Manufacturers rename colors
   and add trims between years — assuming last year's palette produces a search
   that silently returns nothing.
3. **Write the config** — copy `engine/config.json`, edit, save it outside the
   repo. See `references/config-reference.md` for every knob.
4. **Run** — `SEARCH_CONFIG=/path/to/config.json npm run search`
5. **Report** — `npm run publish` assembles a static bundle in `<outDir>/../publish`.
6. **Host** (optional) — any static host. See "Publishing" below.
7. **Refine** — each change is a config edit plus a re-run. For a *reporter-only*
   change, use `npm run re-report`: it re-renders from the stored run with no API
   calls.

## Setup

```bash
cd engine
npm install
cp .env.example .env      # paste a MarketCheck API key
npm run init-db
SEARCH_CONFIG=/path/to/your-config.json npm run search
```

Requires a [MarketCheck](https://www.marketcheck.com/apis) API key. That is the
only data source, and it is a licensed API — this repo does not scrape retail
sites, and you should not add adapters that do.

## Traps that will cost you a run

These are learned from real searches. Each one silently produces a *plausible
but wrong* result, which is the dangerous kind.

**The API returns at most 500 rows per query.** `start=500` yields HTTP 422. On
any result set larger than that you cannot see every car — you can only choose
*which* 500. Queries therefore sort cheapest-first, so the visible 500 are the
ones that can actually win a landed-price ranking. Anything above that price
point is invisible to the run. To survey an expensive segment, narrow each pass
(by state, price band, or trim) so more of the market fits through the window.

**New cars have no vehicle history, and the feed says so misleadingly.**
MarketCheck reports `carfax_1_owner: false` and `carfax_clean_title: false` on a
4-mile car at a franchise dealer. Read literally, every new car looks
title-suspect and lands in "verify by hand." The adapter detects
`inventory_type: "new"` and maps it to zero-owner / clean / verified. If you add
a source, replicate that.

**A mileage filter deletes cars that report no mileage.** `miles_range` drops any
listing with no `miles` field — common on new inventory. On one real search that
hid 32 cars *including the cheapest in the country*, about $2,000 under the
visible floor. Set `allowUnknownMileage: true` on any new-car search; the local
filter still enforces `maxMileage` on every car that reports one.

**"Call for price" listings sort first under a cheapest-first sort** and will eat
the 500-row window. Set `minPrice` (e.g. 1000) to exclude them.

**Filtering colors client-side wastes the window.** Send colors as a server-side
facet (`exteriorColors`), or the 500 rows fill with colors you are discarding.
On one search, 38 of the 50 cheapest listings were a drivetrain the buyer did not
want — `useDrivetrainFacet` exists for exactly that.

**Colors and trims change between model years.** Use the normalized bucket
(Silver / Gray / Black), never a marketing name — one bucket spanned *seven*
spellings in a single feed. And set colors **per target** when years differ: one
model year had no silver at all, and two years' "gray" were different colors.

**A global row cap hides a uniformly-pricier group.** With one cap across a
multi-year search, the cheapest car of the priciest year ranked #315 — so a
top-200 page showed *zero* of that year. `reportTopN` caps **per model year** for
this reason. The same trap applies to any grouping you add.

## What the report gives them

A single self-contained HTML page: every car ranked by landed price, with
monthly payments at the configured APRs, dealer links, a run-over-run diff
(new / price drop / gone), and a dropdown filter bar (year, color, trim,
condition, state) with a live count. Plus a CSV of the complete result set —
the page is capped, the CSV never is.

Cars split into **buyable** (passes every hard filter, history confirmed) and
**verify by hand** (owner count or title not positively confirmed). Always tell
the user the second group is not a rejection — the cheapest car often lands
there, and used cars mostly do.

## Publishing

The bundle is plain static files, so any host works. Two notes learned the hard
way with Vercel:

- The project name comes from the **deploy folder name**, so give each site its
  own distinctly-named folder.
- Copy only the bundle files into that folder — never a `.vercel/` link
  directory, or the deploy overwrites a different project.

The bundle ships `noindex` three ways (meta tag, robots.txt, `X-Robots-Tag`),
because these pages carry someone's shopping intent. That is *unlisted*, not
private — anyone with the link can read it. Say so plainly rather than implying
it is protected.

## Honesty rules

- **Landed price excludes** destination charge, dealer doc/filing fees, tax,
  title, and registration. Advertised prices often assume dealer financing or
  rebates the buyer may not qualify for. The config carries a `feeDisclaimer`
  that renders on the page — keep it accurate.
- **The feed's history flags are unreliable in both directions.** It has
  under-confirmed clean titles and mis-flagged genuine one-owner cars. Never
  present a car as verified clean on feed data alone.
- **Never hide how much of the market you could not see.** If the 500-row window
  truncated a pass, say which segment is invisible.

## Reference

- `references/config-reference.md` — every config field
- `references/marketcheck-api.md` — probe recipes, facet names, response quirks
- `engine/` — the TypeScript engine, `npm test` for the suite
