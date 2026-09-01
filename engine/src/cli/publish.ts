import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";

/**
 * `npm run publish` — assemble the static web bundle for the Vercel deploy.
 *
 * This is the PUBLISH step of the standing tracker. It takes the latest
 * generated report artifacts in out/ (written by `npm run search`) and produces
 * a self-contained, secret-free static site under <app>/../publish:
 *
 *   index.html      <- out/ranked.html, with web-hosting concerns added:
 *                       * <meta name="robots" content="noindex,nofollow">
 *                       * a "Download CSV" link in the footer
 *   listings.csv    <- out/listings.csv (verbatim)
 *   robots.txt      <- Disallow: / (belt-and-suspenders with the meta tag)
 *   vercel.json     <- X-Robots-Tag: noindex header on every path
 *
 * SECURITY / PRIVACY (the security notes):
 *   - The .env / MARKETCHECK_API_KEY never touches this bundle. The only inputs
 *     are out/ranked.html + out/listings.csv, which carry only the minimal
 *     listing fields (no secret, no PII — dealer is a business entity).
 *   - noindex is enforced THREE ways (meta tag + robots.txt + response header)
 *     so the page is not search-indexed. Access model = unlisted (PO's call,
 *     2026-06-18): obscure URL, no password.
 *   - The publish dir lives outside any cloud-synced folder. We never read,
 *     copy, or print the API key or the live DB.
 *
 * The deploy itself is intentionally NOT run from here (keeps this script free
 * of any Vercel-auth dependency). After assembling, deploy with:
 *
 *   cd <publish dir> && vercel deploy --prod --yes
 */

const NOINDEX_META = `<meta name="robots" content="noindex,nofollow">`;
const CHARSET_MARKER = `<meta charset="utf-8">`;
const FOOTER_CLOSE = `</footer>`;
const CSV_LINK = ` &middot; <a href="./listings.csv" download>Download CSV &#8599;</a>`;

const ROBOTS_TXT = `User-agent: *\nDisallow: /\n`;

const VERCEL_JSON =
  JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      headers: [
        {
          source: "/(.*)",
          headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
        },
      ],
    },
    null,
    2,
  ) + "\n";

function main(): void {
  const cfg = loadConfig(process.env.SEARCH_CONFIG);
  const outDir = cfg.paths.outDir;
  const srcHtml = join(outDir, "ranked.html");
  const srcCsv = join(outDir, "listings.csv");

  if (!existsSync(srcHtml)) {
    throw new Error(
      `No report to publish: "${srcHtml}" not found. Run \`npm run search\` first.`,
    );
  }

  const publishDir = join(outDir, "..", "publish");
  if (/onedrive|dropbox|google drive|googledrive|icloud|box sync/i.test(publishDir)) {
    throw new Error(`Refusing to assemble a publish bundle inside a cloud-synced folder: "${publishDir}".`);
  }
  mkdirSync(publishDir, { recursive: true });

  // 1) index.html = ranked.html + noindex meta + CSV download link.
  let html = readFileSync(srcHtml, "utf8");

  if (!html.includes(CHARSET_MARKER)) {
    throw new Error(
      `Cannot inject noindex: charset marker not found in ${srcHtml}. ` +
        `Refusing to publish a page that may be search-indexed.`,
    );
  }
  if (!html.includes(NOINDEX_META)) {
    html = html.replace(CHARSET_MARKER, CHARSET_MARKER + NOINDEX_META);
  }

  if (html.includes(FOOTER_CLOSE) && !html.includes(CSV_LINK)) {
    html = html.replace(FOOTER_CLOSE, CSV_LINK + FOOTER_CLOSE);
  }

  // Safety net: never ship a bundle that leaks an obvious secret token.
  for (const re of [/mc_[A-Za-z0-9]{20,}/, /MARKETCHECK_API_KEY/i, /api_key=/i]) {
    if (re.test(html)) {
      throw new Error(
        `Aborting publish: report HTML appears to contain a secret-like token (${re}). ` +
          `Investigate before deploying.`,
      );
    }
  }

  writeFileSync(join(publishDir, "index.html"), html, "utf8");

  // 2) listings.csv verbatim (optional but nice — the page links to it).
  if (existsSync(srcCsv)) {
    copyFileSync(srcCsv, join(publishDir, "listings.csv"));
  }

  // 3) robots.txt + vercel.json (idempotent).
  writeFileSync(join(publishDir, "robots.txt"), ROBOTS_TXT, "utf8");
  writeFileSync(join(publishDir, "vercel.json"), VERCEL_JSON, "utf8");

  console.log("Publish bundle assembled:");
  console.log(`  ${join(publishDir, "index.html")}`);
  console.log(`  ${join(publishDir, "listings.csv")}`);
  console.log(`  ${join(publishDir, "robots.txt")}`);
  console.log(`  ${join(publishDir, "vercel.json")}`);
  console.log("\nDeploy:");
  console.log(`  cd "${publishDir}" && vercel deploy --prod --yes`);
}

try {
  main();
} catch (err) {
  console.error(`\n[publish] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
}
