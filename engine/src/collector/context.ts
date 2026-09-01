import { chromium, type BrowserContext } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { Pacer } from "./pacing.js";
import type { CollectorContext } from "./adapter.js";

/**
 * Persistent headful browser context per source.
 *
 * SECURITY (the security notes):
 *   - HEADFUL only (visible browser, human-in-the-loop). headless is forced
 *     false; there is no headless path.
 *   - Persistent context uses a WARMED PROFILE under
 *     <profilesDir>/<source>/ (outside any cloud-synced folder, gitignored).
 *     The operator logs into any site that needs it BY HAND, once, into this profile.
 *     No credentials/cookies are read from or written to the repo or config.
 *   - NO stealth: no proxy, no fingerprint/user-agent spoofing, no
 *     headless-evasion. Just a real browser + human CAPTCHA clearing.
 *
 * the source design (MarketCheck): HTTP/API adapters (usesBrowser=false) DO NOT launch
 * Chromium. They get a context with a null browser (which they never touch) and
 * still receive the pacer + config. This keeps the API path browser-free.
 */
export async function openSourceContext(
  source: string,
  cfg: Config,
  usesBrowser = true,
): Promise<{ ctx: CollectorContext; close: () => Promise<void> }> {
  if (!usesBrowser) {
    // HTTP/API adapter: no browser process at all. ctx.browser is null and the
    // adapter must not dereference it (MarketCheck fetches over the network).
    const collectorCtx: CollectorContext = {
      browser: null,
      pacer: new Pacer(cfg),
      config: cfg,
    };
    return { ctx: collectorCtx, close: async (): Promise<void> => {} };
  }

  const userDataDir = join(cfg.paths.profilesDir, source);
  mkdirSync(userDataDir, { recursive: true });

  const browser: BrowserContext = await chromium.launchPersistentContext(
    userDataDir,
    {
      headless: false, // HEADFUL — non-negotiable per the security notes
      viewport: null, // use the real window size
      // No proxy, no custom userAgent override, no anti-detection args.
    },
  );

  const collectorCtx: CollectorContext = {
    browser,
    pacer: new Pacer(cfg),
    config: cfg,
  };

  const close = async (): Promise<void> => {
    // Close cleanly so no orphaned browser processes; profile stays warmed.
    await browser.close().catch(() => {});
  };

  return { ctx: collectorCtx, close };
}
