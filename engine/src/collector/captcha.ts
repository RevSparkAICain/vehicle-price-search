import { createInterface } from "node:readline";
import type { Page } from "playwright";

/**
 * pauseForCaptcha.
 *
 * Detects a bot-challenge / CAPTCHA heuristically, then HALTS the run, prints a
 * clear instruction to the console, and BLOCKS until the operator (the operator)
 * solves it in the visible browser and presses Enter. Then the run resumes.
 *
 * Posture (the security notes): the ONLY anti-bot mechanism is "real browser +
 * human clears the challenge". No solver service, no bypass.
 */

/** Known challenge signals — title fragments and selectors. */
const CHALLENGE_TITLE_FRAGMENTS = [
  "just a moment",
  "attention required",
  "are you a robot",
  "verify you are human",
  "access denied",
  "pardon our interruption",
  "checking your browser",
];

const CHALLENGE_SELECTORS = [
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='recaptcha']",
  "iframe[title*='recaptcha' i]",
  "iframe[src*='hcaptcha']",
  "#challenge-running",
  "#cf-challenge-running",
  "div.px-captcha-container", // PerimeterX
  "#px-captcha",
  "[id*='datadome']", // DataDome
];

/**
 * Pure heuristic: given a page title and the set of selectors found present,
 * decide if this looks like a challenge. Unit-testable without a browser.
 */
export function looksLikeChallenge(
  title: string,
  presentSelectors: string[],
): boolean {
  const t = title.toLowerCase();
  if (CHALLENGE_TITLE_FRAGMENTS.some((frag) => t.includes(frag))) return true;
  return presentSelectors.length > 0;
}

/** The selectors we probe for; exported so the live check + tests agree. */
export function challengeSelectors(): string[] {
  return [...CHALLENGE_SELECTORS];
}

/** Live detection: inspect the page's title + probe challenge selectors. */
export async function detectChallenge(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => "");
  const present: string[] = [];
  for (const sel of CHALLENGE_SELECTORS) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) present.push(sel);
  }
  return looksLikeChallenge(title, present);
}

/** Block on stdin until the operator presses Enter. */
export async function waitForOperatorEnter(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const rl = createInterface({ input, output });
  output.write(`\n${prompt}\n> `);
  await new Promise<void>((resolve) => rl.question("", () => resolve()));
  rl.close();
}

/**
 * If the page shows a challenge, halt and wait for the operator. Returns true
 * if a challenge was detected + cleared, false if no challenge was present.
 */
export async function pauseForCaptcha(page: Page): Promise<boolean> {
  const isChallenge = await detectChallenge(page);
  if (!isChallenge) return false;
  const url = page.url();
  console.warn(
    `\n[CAPTCHA / bot challenge detected]\n` +
      `  URL: ${url}\n` +
      `  ACTION REQUIRED: solve the challenge in the open browser window, then press Enter here to continue.`,
  );
  await waitForOperatorEnter("Press Enter once the challenge is cleared...");
  console.warn("[resuming run]\n");
  return true;
}
