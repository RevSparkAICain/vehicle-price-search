import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, extname } from "node:path";
import type { SourceAdapter, AdapterModule } from "./adapter.js";

/**
 * Adapter auto-discovery.
 *
 * Loads EVERY `src/adapters/*.adapter.ts` (or compiled `*.adapter.js`) and
 * registers the `adapter` it exports — so a future source (a second marketplace) drops in by adding ONE file, WITHOUT editing
 * any shared registry. No hardcoded import list.
 */
/**
 * Import one adapter module by absolute path.
 *
 * Two runtimes disagree about what specifier they accept, and getting this
 * wrong loads ZERO adapters while throwing nothing useful:
 *   - Node ESM requires a file:// URL. An absolute Windows path is rejected,
 *     because "C:" parses as a URL scheme.
 *   - Vitest's module runner rewrites a runtime-computed file:// specifier into
 *     a percent-encoded bare path it then cannot stat, so any checkout under a
 *     directory containing a space ("Program Files", "My Documents", macOS
 *     "Application Support") fails to resolve.
 * So: try the URL form, fall back to the plain path, and if both fail surface
 * the ORIGINAL error rather than the confusing second one.
 */
async function importAdapterModule(absPath: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ pathToFileURL(absPath).href);
  } catch (urlErr) {
    try {
      return await import(/* @vite-ignore */ absPath);
    } catch {
      throw urlErr;
    }
  }
}

export async function discoverAdapters(): Promise<SourceAdapter[]> {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/collector or dist/collector
  const adaptersDir = join(here, "..", "adapters");

  let files: string[];
  try {
    files = readdirSync(adaptersDir);
  } catch {
    return [];
  }

  // When running under tsx, source is .ts; when running compiled, .js.
  const adapterFiles = files.filter(
    (f) =>
      (f.endsWith(".adapter.ts") || f.endsWith(".adapter.js")) &&
      !f.endsWith(".d.ts"),
  );

  const adapters: SourceAdapter[] = [];
  const seen = new Set<string>();
  for (const file of adapterFiles) {
    const base = file.slice(0, file.length - extname(file).length); // strip .ts/.js
    if (seen.has(base)) continue; // avoid double-loading .ts + .js of same module
    seen.add(base);

    const mod = (await importAdapterModule(join(adaptersDir, file))) as Partial<AdapterModule>;
    if (mod.adapter && typeof mod.adapter.name === "string") {
      adapters.push(mod.adapter);
    } else {
      console.warn(`[registry] ${file} has no valid 'adapter' export — skipped`);
    }
  }

  adapters.sort((a, b) => a.name.localeCompare(b.name));
  return adapters;
}

/** Filter discovered adapters to those enabled in config (by name). */
export function enabledAdapters(
  all: SourceAdapter[],
  configSources: Array<{ name: string; enabled: boolean }>,
): SourceAdapter[] {
  const enabledNames = new Set(
    configSources.filter((s) => s.enabled).map((s) => s.name),
  );
  return all.filter((a) => a.enabled && enabledNames.has(a.name));
}
