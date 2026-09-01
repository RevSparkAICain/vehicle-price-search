import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type {
  AnalystResult,
  RankedListing,
  ChangesDiff,
  ListingSnapshot,
} from "../lib/types.js";

/**
 * Reporter. Writes ranked.md + listings.csv + changes-<date>.md to
 * out/, then copies read-only snapshots into the results-copy dir.
 *
 * SECURITY: output carries ONLY the minimal listing/history fields. There is no
 * code path that writes raw report bodies, prior-owner names, or addresses —
 * those never reach a snapshot (PII minimization, the security notes). The live DB
 * is never copied into the results-copy dir.
 */

export interface ReportFiles {
  rankedMd: string;
  rankedHtml: string;
  listingsCsv: string;
  changesMd: string;
  changesFileName: string;
}

/** Build all three report file contents (pure — no I/O). */
export function buildReports(
  result: AnalystResult,
  diff: ChangesDiff,
  cfg: Config,
  dateStr: string = today(),
): ReportFiles {
  return {
    rankedMd: renderRankedMd(result, cfg),
    rankedHtml: renderRankedHtml(result, cfg, dateStr),
    listingsCsv: renderListingsCsv(result),
    changesMd: renderChangesMd(diff),
    changesFileName: `changes-${dateStr}.md`,
  };
}

/** Write reports to out/ then copy into the results-copy dir. */
export function writeReports(files: ReportFiles, cfg: Config): {
  outPaths: string[];
  copyPaths: string[];
} {
  mkdirSync(cfg.paths.outDir, { recursive: true });
  mkdirSync(cfg.paths.resultsCopyDir, { recursive: true });

  const outRanked = join(cfg.paths.outDir, "ranked.md");
  const outHtml = join(cfg.paths.outDir, "ranked.html");
  const outCsv = join(cfg.paths.outDir, "listings.csv");
  const outChanges = join(cfg.paths.outDir, files.changesFileName);

  writeFileSync(outRanked, files.rankedMd, "utf8");
  writeFileSync(outHtml, files.rankedHtml, "utf8");
  writeFileSync(outCsv, files.listingsCsv, "utf8");
  writeFileSync(outChanges, files.changesMd, "utf8");

  const odRanked = join(cfg.paths.resultsCopyDir, "ranked.md");
  const odHtml = join(cfg.paths.resultsCopyDir, "ranked.html");
  const odCsv = join(cfg.paths.resultsCopyDir, "listings.csv");
  const odChanges = join(cfg.paths.resultsCopyDir, files.changesFileName);

  copyFileSync(outRanked, odRanked);
  copyFileSync(outHtml, odHtml);
  copyFileSync(outCsv, odCsv);
  copyFileSync(outChanges, odChanges);

  return {
    outPaths: [outRanked, outHtml, outCsv, outChanges],
    copyPaths: [odRanked, odHtml, odCsv, odChanges],
  };
}

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

function money(n: number | null): string {
  if (n === null) return "-";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function moneyCents(n: number | null): string {
  if (n === null) return "-";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function paymentFor(row: RankedListing, months: number): string {
  const p = row.monthly.find((m) => m.months === months);
  return p ? moneyCents(p.payment) : "-";
}

/**
 * Service-history manual-check note. The MarketCheck
 * listings API gives owner + title but NOT the service section, so each such row
 * carries a "verify by hand" flag. Prefer the in-memory marker when present;
 * otherwise derive it for marketcheck-sourced rows (the marker is dropped when a
 * snapshot round-trips through the store, which has no column for it).
 */
function serviceHistoryNote(r: RankedListing): string {
  // A PO hand-check (config.verifiedClean) is the strongest signal — show their
  // note instead of the generic "verify by hand" prompt.
  if (r.handVerified) return r.handVerified;
  if (r.serviceHistory) return r.serviceHistory;
  if (r.source === "marketcheck") return "VERIFY via dealer CarFax";
  return "-";
}

/**
 * Where owner + accident/title came from. MarketCheck supplies owner + title
 * inline (carfax_1_owner / carfax_clean_title); browser-scraped sources read the
 * actual free history report. Surfaced so the PO knows the provenance.
 */
function ownerTitleSource(r: RankedListing): string {
  if (r.source === "marketcheck") return "API: carfax_1_owner + carfax_clean_title";
  return "free history report";
}

/**
 * Google Maps search link for a dealership, so the PO can click the dealer name
 * and see where it is. Built ONLY from already-public listing fields (dealer
 * business name + city/state + zip) — no PII, no new data. Returns null when
 * there's no dealer name. The query is URL-encoded; callers HTML-escape the href.
 */
function dealerMapUrl(
  dealer: string | null,
  location: string | null,
  zip: string | null,
): string | null {
  if (!dealer) return null;
  const q = [dealer, location, zip].filter((p) => p && p.trim()).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Trailing state token from a "City, ST" location string (e.g. "Columbus, OH" -> "OH"). */
function stateAbbr(location: string | null | undefined): string | null {
  if (!location) return null;
  const parts = location.split(",");
  const last = parts[parts.length - 1]?.trim();
  return last || null;
}

/** Dealer label with its state folded in: "Germain Cadillac Of Easton, OH". */
function dealerLabel(dealer: string | null, location: string | null | undefined): string | null {
  if (!dealer) return null;
  const st = stateAbbr(location);
  return st ? `${dealer}, ${st}` : dealer;
}

/**
 * Bucket a listing's marketing color name ("Silver Zynith", "Sting-Gray
 * Clearcoat") into one of the configured buckets ("Silver", "Gray"). Same
 * substring rule the hard filter uses. Falls back to the raw name so a row is
 * never silently unlabelled.
 */
function colorBucketOf(raw: string | null | undefined, buckets: string[]): string {
  const t = (raw ?? "").toLowerCase();
  if (!t) return "Unknown";
  return buckets.find((b) => t.includes(b.toLowerCase())) ?? (raw as string);
}

/** Two-letter state out of a "City, ST" location string. */
function stateOf(location: string | null | undefined): string {
  const parts = (location ?? "").split(",");
  if (parts.length < 2) return "";
  const last = parts[parts.length - 1]!.trim();
  return /^[A-Za-z][A-Za-z]$/.test(last) ? last.toUpperCase() : "";
}

/**
 * New vs used. Our MarketCheck mapping assigns ownerCount 0 to factory-new
 * inventory and never to a used car, so this reads the same signal the buyable
 * gate does rather than re-deriving it from the feed.
 */
function conditionOf(row: RankedListing): string {
  return row.ownerCount === 0 ? "New" : "Used";
}

/** Every color bucket the config asks for, across run level and each target. */
function configuredColors(cfg: Config): string[] {
  return [
    ...new Set([
      ...(cfg.exteriorColors ?? []),
      ...[cfg.target, ...(cfg.extraTargets ?? [])].flatMap((t) => t.exteriorColors ?? []),
    ]),
  ];
}

/** Distinct model years across the targets, ascending; [] when there is only one. */
function multiYears(targets: ReadonlyArray<{ year: number }>): number[] {
  const ys = [...new Set(targets.map((t) => t.year))].sort((a, b) => a - b);
  return ys.length > 1 ? ys : [];
}

/**
 * Cap the rows a section renders. On a single-year search this is just the
 * cheapest `topN`. On a multi-year search it is the cheapest `topN` OF EACH
 * YEAR, keeping overall rank order — otherwise a year that is uniformly pricier
 * (2027 Sting-Gray starts ~$10k above 2026 Silver) never reaches the page at
 * all and its toggle button shows an empty table.
 */
function capForDisplay(
  list: RankedListing[],
  topN: number | undefined,
  years: number[],
): RankedListing[] {
  if (topN == null) return list;
  if (years.length === 0) return list.slice(0, topN);
  const used = new Map<number | null, number>();
  return list.filter((r) => {
    const k = r.year ?? null;
    const n = used.get(k) ?? 0;
    if (n >= topN) return false;
    used.set(k, n + 1);
    return true;
  });
}

/** Cap a ranked list to cfg.reportTopN rows (unset => the whole list). */
function capRows(list: RankedListing[], cfg: Config): RankedListing[] {
  return cfg.reportTopN != null ? list.slice(0, cfg.reportTopN) : list;
}

export function renderRankedMd(result: AnalystResult, cfg: Config): string {
  const lines: string[] = [];
  lines.push(`# ${cfg.title ?? "Vehicle Price Search"} — Ranked`);
  lines.push("");
  lines.push(
    `Target: ${[cfg.target, ...(cfg.extraTargets ?? [])].map((t) => `${t.year} ${t.make} ${t.model}`).join(" + ")} · ${cfg.target.drivetrain} · home ZIP ${cfg.homeZip} · ranked by landed price (listing + estimated shipping).`,
  );
  lines.push(`Reference baseline VIN: ${cfg.referenceVin}`);
  if (cfg.feeDisclaimer) lines.push(`_${cfg.feeDisclaimer}_`);
  lines.push("");

  lines.push(`## Buyable (verified history, passes hard filters)`);
  lines.push("");
  if (result.buyable.length === 0) {
    lines.push("_No buyable listings this run._");
  } else {
    lines.push(rankedTableHeader());
    for (const r of capRows(result.buyable, cfg)) lines.push(rankedRow(r, cfg));
    if (cfg.reportTopN != null && result.buyable.length > cfg.reportTopN) {
      lines.push("", `_Showing the ${cfg.reportTopN} cheapest of ${result.buyable.length}. Full set in listings.csv._`);
    }
  }
  lines.push("");

  lines.push(`## Verify by hand — single-owner, title/accident unconfirmed`);
  lines.push("");
  lines.push(
    "_The data source can't positively confirm owner count and/or a clean title / no major accident — its history flags are unreliable (they've both under-confirmed clean titles AND mis-flagged a real 1-owner car as 2-owner). NOT counted as clean — open the dealer's vehicle-history report before buying. Ranked by landed price; the cheapest overall can land here._",
  );
  lines.push("");
  if (result.unverified.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(rankedTableHeader());
    for (const r of capRows(result.unverified, cfg)) lines.push(rankedRow(r, cfg));
    if (cfg.reportTopN != null && result.unverified.length > cfg.reportTopN) {
      lines.push("", `_Showing the ${cfg.reportTopN} cheapest of ${result.unverified.length}. Full set in listings.csv._`);
    }
  }
  lines.push("");

  if (result.rejected.length > 0) {
    lines.push(`## Rejected (failed a hard filter)`);
    lines.push("");
    lines.push("| VIN | Source | Reason |");
    lines.push("| --- | --- | --- |");
    for (const rej of result.rejected) {
      lines.push(`| ${rej.snapshot.vin} | ${rej.snapshot.source} | ${rej.reason} |`);
    }
    lines.push("");
  }

  if (result.ruledOut.length > 0) {
    lines.push(`## Ruled out by you (NO GO)`);
    lines.push("");
    lines.push(
      "_VINs you marked NO GO — kept out of every list above (and out of the change diff) so they don't resurface._",
    );
    lines.push("");
    lines.push("| VIN | Reason | Dealer | Location |");
    lines.push("| --- | --- | --- | --- |");
    for (const ro of result.ruledOut) {
      lines.push(
        `| ${ro.snapshot.vin} | ${ro.reason} | ${dealerMd(ro.snapshot.dealer, ro.snapshot.location, ro.snapshot.zip)} | ${ro.snapshot.location ?? "-"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

/**
 * Render the run as a self-contained, double-clickable HTML report. Dark theme,
 * three sections (Buyable / Verify by hand / Rejected), click a column header to
 * sort. No external assets, no network, no JS frameworks. Carries only the same
 * minimal fields as ranked.md (no PII; dealer is a business entity).
 */
export function renderRankedHtml(
  result: AnalystResult,
  cfg: Config,
  dateStr: string = today(),
): string {
  const esc = (v: unknown): string =>
    String(v ?? "").replace(/[&<>"]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
    );

  const accCell = (r: RankedListing): string => {
    // PO hand-checked the dealer history report (config.verifiedClean): show a
    // clean + hand-checked marker, with the note in the tooltip. This wins over
    // the raw data-source severity (still "unknown" on the snapshot).
    if (r.handVerified) {
      return `<span class="ok" title="${esc(r.handVerified)}">clean &#10003; hand-checked</span>`;
    }
    const sev = r.accidentSeverity;
    return sev === "none"
      ? `<span class="ok">clean title</span>`
      : sev === "unknown"
        ? `<span class="warn">unconfirmed</span>`
        : `<span class="bad">${esc(sev)}</span>`;
  };

  const dealerCell = (
    dealer: string | null,
    location: string | null,
    zip: string | null,
  ): string => {
    if (!dealer) return "&mdash;";
    const label = dealerLabel(dealer, location) ?? dealer;
    const mapUrl = dealerMapUrl(dealer, location, zip);
    return mapUrl
      ? `<a href="${esc(mapUrl)}" target="_blank" rel="noopener" title="Show dealership on Google Maps">${esc(label)} &#128205;</a>`
      : esc(label);
  };

  const dataRows = (list: RankedListing[]): string =>
    list
      .map((r) => {
        const base = r.isReferenceBaseline ? ` <span class="tag">baseline</span>` : "";
        const vinCell = r.url
          ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" title="Open dealer listing">${esc(r.vin)} &#8599;</a>`
          : esc(r.vin);
        const pin = r.pinned ? ` <span class="tag pin">pinned</span>` : "";
        return (
          `<tr data-make="${esc((r.make ?? "").toLowerCase())}" data-year="${esc(String(r.year ?? ""))}" data-color="${esc(colorBucketOf(r.exteriorColor, colorBuckets))}" data-trim="${esc(r.trim ?? "")}" data-cond="${esc(conditionOf(r))}" data-state="${esc(stateOf(r.location))}">` +
          `<td class="num">${r.rank}${base}</td>` +
          `<td class="vin">${vinCell}${pin}</td>` +
          `<td class="num strong" data-sort="${r.landedPrice ?? ""}">${esc(money(r.landedPrice))}</td>` +
          `<td class="num" data-sort="${r.price ?? ""}">${esc(money(r.price))}</td>` +
          `<td class="num">${esc(money(r.shippingEst))}${r.shippingFirm ? ' <span class="firm">firm</span>' : ""}</td>` +
          `<td class="num" data-sort="${r.mileage ?? ""}">${r.mileage == null ? "&mdash;" : esc(r.mileage.toLocaleString("en-US"))}</td>` +
          `<td class="num">${r.ownerCount == null ? "&mdash;" : r.ownerCount}</td>` +
          `<td>${accCell(r)}</td>` +
          `<td class="num">${esc(paymentFor(r, 60))}</td>` +
          `<td class="num">${esc(paymentFor(r, 84))}</td>` +
          `<td>${dealerCell(r.dealer, r.location, r.zip)}</td>` +
          `<td>${esc(r.exteriorColor ?? "—")}</td>` +
          `</tr>`
        );
      })
      .join("");

  const headRow =
    `<tr>` +
    ["#", "VIN (↗ dealer)", "Landed", "Price", "Ship", "Miles", "Owner", "Accident", "$/mo&middot;60", "$/mo&middot;84", "Dealer", "Color"]
      .map((h) => `<th>${h}</th>`)
      .join("") +
    `</tr>`;

  // cfg.reportTopN caps how many rows a section RENDERS (cheapest landed first,
  // the list is already ranked). The count badge and the CSV still reflect every
  // car — a high-volume new-car search returns thousands of near-identical units
  // and an uncapped page is megabytes of scrolling. Unset => render all.
  const topN = cfg.reportTopN;
  const yearsInSearch = multiYears([cfg.target, ...(cfg.extraTargets ?? [])]);
  const section = (title: string, sub: string, list: RankedListing[], cls: string): string => {
    const count = `<span class="count">${list.length}</span>`;
    const shown = capForDisplay(list, topN, yearsInSearch);
    const trunc =
      shown.length < list.length
        ? `<p class="sub">Showing the ${shown.length} cheapest by landed price. All ${list.length} are in the CSV.</p>`
        : "";
    const body =
      list.length === 0
        ? `<p class="empty">None this run.</p>`
        : trunc +
          `<div class="tw"><table class="sortable"><thead>${headRow}</thead><tbody>${dataRows(shown)}</tbody></table></div>`;
    // Pinned (PO manual-add) rows have no Service-history column on the page, so
    // surface their note as a visible line under the table (phone-readable).
    const pinNotes = list
      .filter((r) => r.pinned && r.serviceHistory)
      .map((r) => `<p class="pinnote">&#128204; ${esc(r.vin)} &mdash; ${esc(r.serviceHistory)}</p>`)
      .join("");
    return `<section class="${cls}"><h2>${esc(title)} ${count}</h2><p class="sub">${esc(sub)}</p>${body}${pinNotes}</section>`;
  };

  const rejected =
    result.rejected.length === 0
      ? ""
      : `<section class="rej"><h2>Rejected <span class="count">${result.rejected.length}</span></h2>` +
        `<div class="tw"><table><thead><tr><th>VIN</th><th>Source</th><th>Reason</th></tr></thead><tbody>` +
        (topN != null ? result.rejected.slice(0, topN) : result.rejected)
          .map((rj) => {
            const v = rj.snapshot.url
              ? `<a href="${esc(rj.snapshot.url)}" target="_blank" rel="noopener">${esc(rj.snapshot.vin)} &#8599;</a>`
              : esc(rj.snapshot.vin);
            return `<tr><td class="vin">${v}</td><td>${esc(rj.snapshot.source)}</td><td>${esc(rj.reason)}</td></tr>`;
          })
          .join("") +
        `</tbody></table></div></section>`;

  const ruledOut =
    result.ruledOut.length === 0
      ? ""
      : `<section class="rej"><h2>Ruled out by you <span class="count">${result.ruledOut.length}</span></h2>` +
        `<p class="sub">VINs you marked NO GO — kept out of every list above (and the change diff) so they don't resurface.</p>` +
        `<div class="tw"><table><thead><tr><th>VIN</th><th>Reason</th><th>Dealer</th><th>Location</th></tr></thead><tbody>` +
        result.ruledOut
          .map((ro) => {
            const v = ro.snapshot.url
              ? `<a href="${esc(ro.snapshot.url)}" target="_blank" rel="noopener">${esc(ro.snapshot.vin)} &#8599;</a>`
              : esc(ro.snapshot.vin);
            return `<tr><td class="vin">${v}</td><td>${esc(ro.reason)}</td><td>${dealerCell(ro.snapshot.dealer, ro.snapshot.location, ro.snapshot.zip)}</td><td>${esc(ro.snapshot.location ?? "—")}</td></tr>`;
          })
          .join("") +
        `</tbody></table></div></section>`;

  // Vanilla click-to-sort (numeric via data-sort, else text). No backticks inside.
  const sortScript =
    "document.querySelectorAll('table.sortable th').forEach(function(th,i){th.addEventListener('click',function(){" +
    "var tb=th.closest('table').querySelector('tbody');var rows=[].slice.call(tb.rows);" +
    "var asc=th.getAttribute('data-asc')!=='1';th.setAttribute('data-asc',asc?'1':'0');" +
    "rows.sort(function(a,b){var x=a.cells[i],y=b.cells[i];" +
    "var xv=x.getAttribute('data-sort'),yv=y.getAttribute('data-sort');" +
    "var xn=xv!==null?parseFloat(xv):NaN,yn=yv!==null?parseFloat(yv):NaN;" +
    "var c=(!isNaN(xn)&&!isNaN(yn))?(xn-yn):((x.textContent||'').localeCompare(y.textContent||''));" +
    "return asc?c:-c;});rows.forEach(function(r){tb.appendChild(r);});});});";

  // Vehicle toggle — only when the search spans >1 make (e.g. Equinox + Niro).
  // Single-vehicle searches (a single-vehicle search) render no toggle.
  const allTargets = [cfg.target, ...(cfg.extraTargets ?? [])];
  const colorBuckets = configuredColors(cfg);

  // Dropdown filter bar. Every select narrows the SAME rendered rows (AND), so
  // the page answers "2026 + Black + New" without a re-run. Options are built
  // from the rows actually present, not from the config, so a filter can never
  // offer a combination that yields nothing.
  const allRows = [...result.buyable, ...result.unverified];
  const optionsFor = (pick: (r: RankedListing) => string): string[] =>
    [...new Set(allRows.map(pick).filter((v) => v !== ""))].sort();
  const sel = (id: string, label: string, values: string[]): string =>
    values.length < 2
      ? ""
      : `<label class="fl"><span>${esc(label)}</span><select id="${id}" data-k="${id.replace(/^f-/, "")}">` +
        `<option value="all">All</option>` +
        values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("") +
        `</select></label>`;

  const filterBar =
    sel("f-year", "Year", optionsFor((r) => String(r.year ?? ""))) +
    sel("f-color", "Color", optionsFor((r) => colorBucketOf(r.exteriorColor, colorBuckets))) +
    sel("f-trim", "Trim", optionsFor((r) => r.trim ?? "")) +
    sel("f-cond", "Condition", optionsFor((r) => conditionOf(r))) +
    sel("f-state", "State", optionsFor((r) => stateOf(r.location)));

  const showToggle = filterBar !== "";
  const toggleHtml = showToggle
    ? `<div class="filters">${filterBar}<button class="fclear" type="button" id="fClear">Reset</button>` +
      `<span class="fcount" id="fCount"></span></div>`
    : "";

  // Vanilla, no deps: read every select, hide rows that fail any of them, and
  // report the visible count per table.
  const filterScript = showToggle
    ? "(function(){var sels=[].slice.call(document.querySelectorAll('.filters select'));" +
      "function apply(){var shown=0,total=0;" +
      "document.querySelectorAll('table.sortable tbody tr').forEach(function(tr){" +
      "total++;var ok=sels.every(function(s){return s.value==='all'||tr.getAttribute('data-'+s.getAttribute('data-k'))===s.value;});" +
      "tr.style.display=ok?'':'none';if(ok)shown++;});" +
      "var c=document.getElementById('fCount');if(c)c.textContent=shown===total?(total+' shown'):(shown+' of '+total+' shown');}" +
      "sels.forEach(function(s){s.addEventListener('change',apply);});" +
      "var b=document.getElementById('fClear');if(b)b.addEventListener('click',function(){sels.forEach(function(s){s.value='all';});apply();});" +
      "apply();})();"
    : "";

  const css =
    ":root{--card:#141b27;--line:#26303f;--ink:#eef2f7;--mut:#93a1b6;--gold:#d9b779;--blue:#56a8ff;--grn:#36d99a;--amber:#f0c674;--red:#ff7a7a}" +
    "*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#0a0d13,#0f141d);color:var(--ink);font:15px/1.5 'Segoe UI',system-ui,sans-serif;padding:28px;min-height:100vh}" +
    "header,main,footer{max-width:1200px;margin-left:auto;margin-right:auto}" +
    ".kick{letter-spacing:.3em;color:var(--gold);font-weight:700;font-size:13px}" +
    "h1{margin:6px 0 4px;font-size:30px}.meta{margin:2px 0;color:var(--mut);font-size:13px}" +
    "section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 16px 8px;margin:16px 0}" +
    "h2{margin:0 0 2px;font-size:19px}.buy h2{color:var(--grn)}.ver h2{color:var(--amber)}.rej h2{color:var(--mut)}" +
    ".count{display:inline-block;min-width:24px;text-align:center;font-size:13px;background:#23304a;color:#cfe0ff;border-radius:999px;padding:2px 9px;margin-left:6px}" +
    ".sub{margin:0 0 12px;color:var(--mut);font-size:13px}.tw{overflow-x:auto}" +
    "table{border-collapse:collapse;width:100%;font-size:13.5px}" +
    "th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}" +
    "th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;user-select:none}th:hover{color:var(--ink)}" +
    "td.num{text-align:right;font-variant-numeric:tabular-nums}td.strong{font-weight:700;color:var(--gold)}" +
    "td.vin{font-family:Consolas,monospace;font-size:12px;color:var(--mut)}tbody tr:hover{background:#1a2333}" +
    "a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}" +
    ".tag{font-size:10px;background:var(--gold);color:#0a0d13;border-radius:4px;padding:1px 5px;font-weight:700}" +
    ".filters{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin:14px 0 18px}" +
    ".filters .fl{display:flex;flex-direction:column;gap:4px}" +
    ".filters .fl span{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}" +
    ".filters select{background:#1a2333;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 9px;font:13px inherit;min-width:104px}" +
    ".filters select:focus{outline:2px solid var(--blue);outline-offset:1px}" +
    ".fclear{background:transparent;color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:7px 12px;font:13px inherit;cursor:pointer}" +
    ".fclear:hover{color:var(--ink);border-color:var(--blue)}" +
    ".fcount{color:var(--mut);font-size:12.5px;margin-left:auto;align-self:center}" +
    ".tag.pin{background:var(--blue);color:#fff}" +
    ".pinnote{color:var(--amber);font-size:12.5px;margin:8px 2px 2px;line-height:1.45}" +
    ".ok{color:var(--grn)}.warn{color:var(--amber)}.bad{color:var(--red)}.empty{color:var(--mut);padding:6px 2px 14px}" +
    ".firm{font-size:10px;color:var(--grn);border:1px solid var(--grn);border-radius:4px;padding:0 4px;margin-left:4px;vertical-align:middle}" +
    ".toggle{display:flex;gap:8px;margin:12px 0 2px;flex-wrap:wrap}.tg{background:#1a2333;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:5px 14px;font-size:13px;cursor:pointer;font-weight:600}.tg:hover{color:var(--ink)}.tg.active{background:var(--gold);color:#0a0d13;border-color:var(--gold)}" +
    "footer{margin-top:20px;color:#5d6b80;font-size:12px;text-align:center}";

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(cfg.title ?? "Vehicle Price Search")} — ${esc(dateStr)}</title><style>${css}</style></head><body>` +
    `<header><div class="kick">${esc((cfg.title ?? "Vehicle Price Search").toUpperCase())}</div><h1>Ranked results</h1>` +
    `<p class="meta">${esc([cfg.target, ...(cfg.extraTargets ?? [])].map((t) => `${t.year} ${t.make} ${t.model}`).join(" + "))} &middot; ${esc(cfg.target.drivetrain)} &middot; home ZIP ${esc(cfg.homeZip)} &middot; ranked by landed price &middot; run ${esc(dateStr)}</p>` +
    `<p class="meta">Reference baseline VIN ${esc(cfg.referenceVin)} &middot; click any column header to sort</p>` +
    (cfg.feeDisclaimer ? `<p class="meta" style="color:var(--warn,#b45309)">${esc(cfg.feeDisclaimer)}</p>` : "") +
    `${toggleHtml}</header><main>` +
    section("Buyable", "Confirmed single-owner + clean title; passes every hard filter.", result.buyable, "buy") +
    section("Verify by hand", "Owner count and/or title not positively confirmed by the data source (its history flags are unreliable both ways) — open the dealer history report. The cheapest car can land here.", result.unverified, "ver") +
    rejected +
    ruledOut +
    `</main><footer>Generated by vehicle-price-search &middot; vehicle-price-search &middot; ${esc(dateStr)}</footer>` +
    `<script>${sortScript}${filterScript}</script></body></html>`
  );
}

function rankedTableHeader(): string {
  return [
    "| # | VIN | Year/Trim/DT | Price | +Ship | =Landed | Miles | Owner | Accident | History | Owner/Title src | Service history | $/mo@60 | $/mo@84 | Dealer | Color | Source | Link |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ].join("\n");
}

function dealerMd(dealer: string | null, location: string | null, zip: string | null): string {
  if (!dealer) return "-";
  const label = dealerLabel(dealer, location) ?? dealer;
  const mapUrl = dealerMapUrl(dealer, location, zip);
  return mapUrl ? `[${label}](${mapUrl})` : label;
}

function rankedRow(r: RankedListing, cfg: Config): string {
  const yearTrimDt = `${r.year ?? cfg.target.year} ${r.make ?? ""} ${r.model ?? ""} ${r.trim ?? "?"} ${r.drivetrain ?? "?"}`
    .replace(/\s+/g, " ")
    .trim();
  const baselineMark = r.isReferenceBaseline ? " **(baseline)**" : "";
  const link = r.url ? `[VDP](${r.url})` : "-";
  return [
    "",
    String(r.rank) + baselineMark,
    r.vin,
    yearTrimDt,
    money(r.price),
    money(r.shippingEst) + (r.shippingFirm ? " (firm)" : ""),
    money(r.landedPrice),
    r.mileage === null ? "-" : r.mileage.toLocaleString("en-US"),
    r.ownerCount === null ? "-" : String(r.ownerCount),
    r.handVerified ? "none (hand-checked)" : r.accidentSeverity,
    r.handVerified ? "hand-verified" : r.historyStatus,
    ownerTitleSource(r),
    serviceHistoryNote(r),
    paymentFor(r, 60),
    paymentFor(r, 84),
    dealerMd(r.dealer, r.location, r.zip),
    r.exteriorColor ?? "-",
    r.source,
    link,
    "",
  ].join(" | ").trim();
}

const CSV_HEADER = [
  "rank",
  "bucket",
  "vin",
  "source",
  "make",
  "model",
  "year",
  "trim",
  "drivetrain",
  "exterior_color",
  "price",
  "shipping_est",
  "distance_mi",
  "landed_price",
  "mileage",
  "owner_count",
  "accident_severity",
  "service_issue_flag",
  "history_status",
  "owner_title_source",
  "service_history_note",
  "monthly_60",
  "monthly_84",
  "dealer",
  "location",
  "zip",
  "url",
  "is_reference_baseline",
  "alternate_sources",
];

export function renderListingsCsv(result: AnalystResult): string {
  const rows: string[] = [CSV_HEADER.join(",")];
  const emit = (r: RankedListing, bucket: string): void => {
    const m60 = r.monthly.find((m) => m.months === 60)?.payment ?? "";
    const m84 = r.monthly.find((m) => m.months === 84)?.payment ?? "";
    const cells = [
      r.rank,
      bucket,
      r.vin,
      r.source,
      r.make ?? "",
      r.model ?? "",
      r.year ?? "",
      r.trim ?? "",
      r.drivetrain ?? "",
      r.exteriorColor ?? "",
      r.price ?? "",
      r.shippingEst ?? "",
      r.distanceMi ?? "",
      r.landedPrice ?? "",
      r.mileage ?? "",
      r.ownerCount ?? "",
      r.accidentSeverity,
      r.serviceIssueFlag ? "true" : "false",
      r.historyStatus,
      ownerTitleSource(r),
      serviceHistoryNote(r),
      m60,
      m84,
      r.dealer ?? "",
      r.location ?? "",
      r.zip ?? "",
      r.url ?? "",
      r.isReferenceBaseline ? "true" : "false",
      r.alternates.map((a) => a.source).join("|"),
    ];
    rows.push(cells.map(csvCell).join(","));
  };
  for (const r of result.buyable) emit(r, "buyable");
  for (const r of result.unverified) emit(r, "unverified");
  return rows.join("\n") + "\n";
}

/** RFC-4180-ish CSV escaping. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function renderChangesMd(diff: ChangesDiff): string {
  const lines: string[] = [];
  lines.push(`# Changes since previous run`);
  lines.push("");
  if (diff.isBaselineRun) {
    lines.push("baseline run — no prior run to diff");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  lines.push(`## NEW (${diff.added.length})`);
  lines.push("");
  if (diff.added.length === 0) lines.push("_none_");
  else for (const s of diff.added) lines.push(`- ${changeLine(s)}`);
  lines.push("");

  lines.push(`## PRICE DROP (${diff.priceDrops.length})`);
  lines.push("");
  if (diff.priceDrops.length === 0) lines.push("_none_");
  else
    for (const d of diff.priceDrops)
      lines.push(
        `- ${d.vin} — ${money(d.oldPrice)} -> ${money(d.newPrice)} (${money(d.newPrice - d.oldPrice)}) · ${d.snapshot.dealer ?? "?"} · ${d.snapshot.location ?? "?"}`,
      );
  lines.push("");

  lines.push(`## GONE (${diff.gone.length})`);
  lines.push("");
  if (diff.gone.length === 0) lines.push("_none_");
  else for (const s of diff.gone) lines.push(`- ${changeLine(s)}`);
  lines.push("");

  return lines.join("\n") + "\n";
}

function changeLine(s: ListingSnapshot): string {
  return `${s.vin} — ${money(s.price)} · ${s.dealer ?? "?"} · ${s.location ?? "?"} · ${s.source}`;
}

export function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
