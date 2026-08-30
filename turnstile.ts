/**
 * Getting past a Cloudflare interstitial - the "Performing security
 * verification" page with a Turnstile widget on it.
 *
 *   const outcome = await passChallenge(page);
 *   if (!outcome.passed) throw new Error(outcome.detail);
 *
 * Two things have to be true for this to work, and neither is in this file:
 *
 * - **A real browser, headed.** The challenge script reads the things
 *   `browsers.ts` already provides - a genuine Chrome build, a coherent
 *   fingerprint, no headless tells. Against a headless launch the widget
 *   renders and the click is simply ignored.
 * - **A pointer that travelled.** The widget reads the movement leading into
 *   the press, not just the press. Hence `human.clickAt` rather than
 *   `page.mouse.click`, and hence the dwell before it.
 *
 * What this file adds is the part neither the profile nor `human` can do
 * alone: finding a checkbox that lives inside a cross-origin iframe, deciding
 * when it needs pressing at all, and telling "passed" apart from "still
 * waiting" without guessing from a screenshot.
 */
import type { Frame, Page } from "playwright";
import { humanize, type Human } from "./human";

/** Where the widget and its script are served from. */
const WIDGET_HOST = "challenges.cloudflare.com";

/** A widget smaller than this is the invisible variant - nothing to press. */
const MIN_INTERACTIVE = { width: 100, height: 40 };

export type ChallengeState =
  /** No Cloudflare challenge on this page. */
  | "clear"
  /** The interstitial is up and its widget is working on its own. */
  | "waiting"
  /** The interstitial is up and asking for a click. */
  | "interactive";

export type ChallengeOutcome = {
  passed: boolean;
  /** False when the page was never challenged - nothing had to be solved. */
  challenged: boolean;
  /** How many times the checkbox was pressed. */
  clicks: number;
  waitedMs: number;
  /** The `cf_clearance` token, when one was issued. */
  clearance?: string;
  detail: string;
};

export type ChallengeOptions = {
  /** Total budget for getting through, ms. Default 45s. */
  timeout?: number;
  /** Presses before giving up. Default 3. */
  attempts?: number;
  /** Reuse a session's persona instead of sampling a new one. */
  human?: Human;
  /** Called with progress; silent by default. */
  log?: (message: string) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Is the interstitial up?
 *
 * `_cf_chl_opt` is the challenge script's own configuration object, set before
 * anything is rendered - a more reliable read than the title, which is
 * localised, or the body text, which changes between challenge templates.
 */
export async function isChallenged(page: Page): Promise<boolean> {
  return page
    .evaluate(() => Boolean((window as unknown as Record<string, unknown>)._cf_chl_opt))
    .catch(() => false);
}

/** The widget's frame, if one is currently attached. */
function widgetFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => !f.isDetached() && f.url().includes(WIDGET_HOST));
}

/**
 * The widget's box in the top page's coordinates.
 *
 * The widget is a cross-origin iframe inside a shadow root, so no selector
 * from the top document reaches it - `page.$("iframe[src*=cloudflare]")`
 * returns null even while the thing is plainly on screen. Going the other way
 * works: find the frame by URL, then ask Playwright for the element hosting
 * it, which crosses the shadow boundary from the inside.
 */
export async function widgetBox(page: Page) {
  const frame = widgetFrame(page);
  if (!frame) return null;

  try {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    await element.dispose();
    return box;
  } catch {
    // The interstitial re-renders itself, so a frame found a moment ago is
    // routinely detached by the time it is measured. Not an error - the
    // caller polls, and the next look finds the replacement.
    return null;
  }
}

/** What the page is showing right now. */
export async function challengeState(page: Page): Promise<ChallengeState> {
  if (!(await isChallenged(page))) return "clear";
  const box = await widgetBox(page);
  const interactive =
    !!box && box.width >= MIN_INTERACTIVE.width && box.height >= MIN_INTERACTIVE.height;
  return interactive ? "interactive" : "waiting";
}

/** The `cf_clearance` token for this page's host, if it has been issued. */
export async function clearanceToken(page: Page): Promise<string | undefined> {
  const cookies = await page.context().cookies(page.url()).catch(() => []);
  return cookies.find((c) => c.name === "cf_clearance")?.value;
}

/**
 * Where in the widget to aim.
 *
 * The checkbox sits at the left end, vertically centred, and the label beside
 * it is not clickable. Aim inside the checkbox with a little scatter, so
 * repeated runs do not all land on the same pixel.
 */
function checkboxPoint(box: { x: number; y: number; width: number; height: number }) {
  return {
    x: box.x + rand(24, 38),
    y: box.y + box.height * rand(0.42, 0.58),
  };
}

/**
 * Wait out the interstitial, pressing the checkbox when it appears.
 *
 * Returns rather than throws, like everything else here: a challenge that did
 * not resolve is a result to record, not an exception to catch.
 */
export async function passChallenge(
  page: Page,
  options: ChallengeOptions = {}
): Promise<ChallengeOutcome> {
  const { timeout = 45_000, attempts = 3, log = () => {} } = options;
  const human = options.human ?? humanize(page);
  const started = Date.now();
  const left = () => timeout - (Date.now() - started);

  let clicks = 0;
  let challenged = false;
  let lastClick = 0;

  while (left() > 0) {
    const state = await challengeState(page);

    if (state === "clear") {
      // A challenge only counts as passed if we saw it up first; a page that
      // was never challenged reports `challenged: false` instead, so a caller
      // can tell "solved it" from "there was nothing there".
      const clearance = await clearanceToken(page);
      return {
        passed: true,
        challenged,
        clicks,
        waitedMs: Date.now() - started,
        clearance,
        detail: challenged
          ? `passed after ${clicks} click${clicks === 1 ? "" : "s"} in ${Math.round((Date.now() - started) / 1000)}s`
          : "no challenge on this page",
      };
    }

    challenged = true;

    if (state === "interactive") {
      // Give a fresh widget a moment to settle, and a pressed one time to
      // answer, before pressing again - the second press inside a second is
      // the tell, not the first.
      const since = Date.now() - lastClick;
      if (lastClick && since < 6000) {
        await sleep(500);
        continue;
      }

      if (clicks >= attempts) {
        await sleep(500);
        continue;
      }

      const box = await widgetBox(page);
      if (!box) continue; // re-rendered between the state read and here

      log(`widget at ${Math.round(box.x)},${Math.round(box.y)} - press ${clicks + 1}`);
      try {
        await human.moveTo(checkboxPoint(box));
        await human.pause(rand(220, 520));
        // Re-measure: the travel takes a second or so, and the interstitial
        // is free to reflow underneath it. Pressing a remembered coordinate
        // is how a click lands next to the checkbox instead of on it.
        const now = await widgetBox(page);
        if (!now) continue;
        await human.clickAt(checkboxPoint(now));
        clicks++;
        lastClick = Date.now();
      } catch (error) {
        // Navigation mid-click - the challenge passed while we were moving.
        log(`press interrupted: ${(error as Error).message.split("\n")[0]}`);
      }
      continue;
    }

    await sleep(400);
  }

  const state = await challengeState(page);
  return {
    passed: false,
    challenged: true,
    clicks,
    waitedMs: Date.now() - started,
    clearance: await clearanceToken(page),
    detail: `still ${state} after ${Math.round(timeout / 1000)}s and ${clicks} click${clicks === 1 ? "" : "s"}`,
  };
}

/**
 * Navigate, then get through whatever is in the way.
 *
 * `goto` resolves on the interstitial's own 403, so its response is the
 * challenge's, not the page's - the status here is re-read after the
 * challenge clears, which is the one a caller actually wants.
 */
export async function gotoAndPass(
  page: Page,
  url: string,
  options: ChallengeOptions = {}
): Promise<ChallengeOutcome & { status?: number }> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const outcome = await passChallenge(page, options);
  // The challenge navigates on success, so a 403 on the first response says
  // nothing about the page we ended up on.
  const status = outcome.challenged && outcome.passed ? 200 : response?.status();
  return { ...outcome, status };
}
