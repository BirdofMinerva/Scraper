/**
 * Many browsers, one site, one coherent result.
 *
 * A crawl is a shared queue plus a stack of browsers. Each browser claims work
 * nobody else is doing, extracts rows, may discover more URLs, and everything
 * merges into one deduplicated set:
 *
 *   const result = await crawl({
 *     start: pageRange((n) => `https://site/list?page=${n}`, 1, 60),
 *     browsers: 6,
 *     key: (row) => row.id,
 *     extract: async ({ page }) => page.$$eval(".item", read),
 *   });
 *
 * The pieces that matter are the ones that are easy to get wrong at scale:
 * work is claimed rather than pre-assigned, so a slow browser cannot hold up
 * a shard nobody else may touch; a failed URL goes back on the queue rather
 * than vanishing with the browser that had it; and every request across every
 * browser passes one per-host rate limiter, because thirty browsers with no
 * shared throttle is a denial of service, not a scrape.
 */
import type { Page } from "playwright";
import { openStack, type StackKind, type StackSession } from "./stack";
import { launchProfile } from "./browsers";
import { toRows, type Row, type Store } from "./storage";
import type { Engine } from "./browsers";
import type { ProxyLike } from "./proxies";
import { passChallenge, type ChallengeOptions } from "./turnstile";

export type CrawlContext = {
  /** The URL this browser claimed. */
  url: string;
  page: Page;
  /** Which fingerprint is doing the work. */
  profile: string;
  /** Add URLs to the queue; already-seen ones are ignored. */
  enqueue: (urls: string | string[]) => number;
  attempt: number;
};

export type CrawlOptions<T = unknown> = {
  /** URLs to begin with. */
  start: string[];
  /** What to pull out of a page. Return rows, or nothing. */
  extract: (ctx: CrawlContext) => Promise<T>;

  /** How many browsers. Default 4. */
  browsers?: number;
  /** What kind of fingerprints to use. Default "mixed". */
  kind?: StackKind;
  engine?: Engine | Engine[];
  /** Routes, one per browser. Fewer routes than browsers throws. */
  proxies?: ProxyLike[];
  /** Reuse fingerprints when browsers exceed the profile pool. */
  allowDuplicates?: boolean;
  /** Let browsers share an exit IP when routes are short. */
  allowSharedProxies?: boolean;

  /** Rows land here as they are found, as well as in the return value. */
  store?: Store;
  /**
   * Row identity. Rows whose key was already seen are dropped, so overlapping
   * pages and re-visited URLs cannot inflate the result.
   */
  key?: (row: Row) => string;

  /** Requeue attempts per URL before giving up. Default 2. */
  retries?: number;
  /** Stop after this many successful pages. */
  maxPages?: number;
  /** Minimum gap between requests to one host, across all browsers. Default 250ms. */
  perHostDelayMs?: number;
  /** Per-page budget. Default 45s. */
  timeout?: number;
  /**
   * Handling of a Cloudflare interstitial on a crawled page. On by default;
   * `false` hands the challenge page to `extract` as it is.
   */
  challenge?: false | ChallengeOptions;
  /**
   * Checked between pages by every worker; return true to wind the crawl down.
   *
   * Cooperative rather than an abort: a worker mid-page finishes it and stops
   * before claiming the next URL, so nothing is left half-extracted and no
   * browser is killed with a page open.
   */
  stop?: () => boolean;
  /** Print progress. */
  verbose?: boolean;
};

export type CrawlResult<T = unknown> = {
  /** Every row, deduplicated by `key`, in the order they were found. */
  rows: Row[];
  /** Whatever `extract` returned, per URL, for callers who want it raw. */
  values: Array<{ url: string; value: T }>;
  failures: Array<{ url: string; error: string; attempts: number }>;
  stats: {
    visited: number;
    failed: number;
    rows: number;
    duplicatesDropped: number;
    /** Pages completed by each fingerprint - a fairness check. */
    byProfile: Record<string, number>;
    /** Browsers that died and were replaced mid-crawl. */
    relaunches: number;
    /** Workers that gave up because their browser could not be replaced. */
    retired: number;
    durationMs: number;
  };
};

/** How many times one worker may replace a dead browser before retiring. */
const MAX_REPLACEMENTS = 2;

/** `https://site/list?page=1..60` as a starting set. */
export function pageRange(
  build: (n: number) => string,
  from: number,
  to: number
): string[] {
  const urls: string[] = [];
  for (let n = from; n <= to; n++) urls.push(build(n));
  return urls;
}

/**
 * The shared queue.
 *
 * Claim-based rather than sharded: with thirty browsers of differing speeds
 * and one of them behind a slow proxy, pre-assigning ranges means the run
 * lasts as long as its unluckiest shard.
 */
export class WorkQueue {
  private pending: string[] = [];
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private inFlight = 0;

  constructor(urls: string[] = []) {
    this.add(urls);
  }

  /** Returns how many were new. */
  add(urls: string | string[]): number {
    let added = 0;
    for (const url of [urls].flat()) {
      if (!url || this.seen.has(url)) continue;
      this.seen.add(url);
      this.pending.push(url);
      added++;
    }
    return added;
  }

  claim(): string | undefined {
    const url = this.pending.shift();
    if (url) this.inFlight++;
    return url;
  }

  release(): void {
    this.inFlight--;
  }

  /**
   * Put a URL back without counting an attempt against it.
   *
   * For failures that are not the URL's fault - a browser that died holding
   * it - where charging a retry would eventually discard perfectly good work.
   */
  returnUnused(url: string): void {
    this.pending.unshift(url);
  }

  /** Put a failed URL back. Returns false once it is out of attempts. */
  retry(url: string, limit: number): boolean {
    const used = (this.attempts.get(url) ?? 0) + 1;
    this.attempts.set(url, used);
    if (used > limit) return false;
    this.pending.push(url);
    return true;
  }

  attemptsFor(url: string): number {
    return (this.attempts.get(url) ?? 0) + 1;
  }

  get size(): number {
    return this.pending.length;
  }

  /** True while work exists or someone might still discover more. */
  get active(): boolean {
    return this.pending.length > 0 || this.inFlight > 0;
  }
}

/**
 * One gate per host, shared by every browser.
 *
 * Without this, "30 browsers" means 30 simultaneous requests to one origin -
 * which is both rude and the fastest way to earn a block that has nothing to
 * do with fingerprints.
 */
export class HostLimiter {
  private readonly nextFree = new Map<string, number>();

  constructor(private readonly delayMs: number) {}

  async wait(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }

    const now = Date.now();
    const earliest = this.nextFree.get(host) ?? 0;
    const start = Math.max(now, earliest);
    // Reserve the slot before awaiting, so concurrent callers queue rather
    // than all reading the same stale timestamp and firing together.
    this.nextFree.set(host, start + this.delayMs);
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  }
}

/** Run the crawl. Browsers are opened, used, and always closed. */
export async function crawl<T = unknown>(
  options: CrawlOptions<T>
): Promise<CrawlResult<T>> {
  const {
    start,
    extract,
    browsers = 4,
    kind = "mixed",
    engine,
    proxies,
    allowDuplicates,
    allowSharedProxies,
    store,
    key,
    retries = 2,
    maxPages = Infinity,
    perHostDelayMs = 250,
    timeout = 45_000,
    challenge,
    stop,
    verbose = false,
  } = options;

  if (start.length === 0) throw new Error("crawl needs at least one start URL");

  const began = Date.now();
  const queue = new WorkQueue(start);
  const limiter = new HostLimiter(perHostDelayMs);

  const rows: Row[] = [];
  const values: CrawlResult<T>["values"] = [];
  const failures: CrawlResult<T>["failures"] = [];
  const keys = new Set<string>();
  const byProfile: Record<string, number> = {};
  let visited = 0;
  let duplicatesDropped = 0;
  let relaunches = 0;
  let retired = 0;

  const stack = await openStack({
    kind,
    count: browsers,
    engine,
    proxies,
    allowDuplicates,
    allowSharedProxies,
  });

  /** Merge one extraction into the shared result, dropping repeats. */
  const merge = async (value: unknown, url: string, profile: string) => {
    const fresh: Row[] = [];
    for (const row of toRows(value)) {
      if (key) {
        const id = key(row);
        if (keys.has(id)) {
          duplicatesDropped++;
          continue;
        }
        keys.add(id);
      }
      fresh.push(row);
    }

    rows.push(...fresh);
    if (store && fresh.length) {
      await store.save(fresh, { mission: "crawl", profile, target: url });
    }
  };

  const withTimeout = <R,>(promise: Promise<R>, url: string) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${timeout}ms`)), timeout)
      ),
    ]);

  /**
   * Did this fail because the browser is gone, rather than because of the page?
   *
   * The distinction is the difference between losing one URL and losing the
   * rest of the queue: a dead worker that keeps claiming will chew through
   * every remaining URL, spending their retries on a page that cannot load
   * anything. Measured at 170 of 200 items lost from a single crash.
   */
  const isDead = (error: unknown) =>
    /target page, context or browser has been closed|browser has been closed|target closed|browser has disconnected|websocket|connection closed/i.test(
      error instanceof Error ? error.message : String(error)
    );

  const worker = async (session: StackSession) => {
    let browser = session.browser;
    let context = session.context;
    let page = session.page ?? (await session.context.newPage());
    const profile = session.profile.id;
    let replacements = 0;

    /** Try to put a dead worker back on its feet. */
    const replaceBrowser = async (): Promise<boolean> => {
      if (replacements >= MAX_REPLACEMENTS) return false;
      replacements++;
      try {
        await browser.close().catch(() => {});
        const fresh = await launchProfile(session.profile);
        browser = fresh.browser;
        context = fresh.context;
        page = await context.newPage();
        // The stack owns teardown, so hand it the browser it must now close.
        session.browser = browser;
        session.context = context;
        session.page = page;
        relaunches++;
        if (verbose) console.log(`  ${profile} ⟳ browser replaced`);
        return true;
      } catch {
        return false;
      }
    };

    while (queue.active && visited < maxPages && !stop?.()) {
      const url = queue.claim();
      if (!url) {
        // Nothing claimable yet, but another browser may still enqueue more.
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      const attempt = queue.attemptsFor(url);
      try {
        await limiter.wait(url);
        await withTimeout(
          (async () => {
            await page.goto(url, { waitUntil: "domcontentloaded" });
            if (challenge !== false) {
              // Any page in a crawl can be the one that draws a challenge -
              // usually not the first, which is why this is per-page and not
              // a warm-up step. An unresolved one fails the URL so it is
              // requeued onto another browser and another route, instead of
              // extracting nothing from an interstitial.
              const outcome = await passChallenge(page, {
                timeout: Math.min(timeout, 30_000),
                ...challenge,
              });
              if (!outcome.passed) throw new Error(`challenge not passed: ${outcome.detail}`);
              if (outcome.challenged && verbose) console.log(`  ${profile} ⚑ ${outcome.detail}`);
            }
            const value = await extract({
              url,
              page,
              profile,
              attempt,
              enqueue: (urls) => queue.add(urls),
            });
            await merge(value, url, profile);
            values.push({ url, value: value as T });
          })(),
          url
        );

        visited++;
        byProfile[profile] = (byProfile[profile] ?? 0) + 1;
        queue.release();
        if (verbose) console.log(`  ${profile} ✓ ${url} (${rows.length} rows)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (isDead(error) || !browser.isConnected()) {
          // Not this URL's fault: give it back untouched, then try to come
          // back with a new browser. If that fails, retire rather than sit in
          // the loop failing everything that is left.
          queue.returnUnused(url);
          queue.release();
          if (await replaceBrowser()) continue;
          retired++;
          if (verbose) console.log(`  ${profile} ⨯ retired, browser unrecoverable`);
          return;
        }

        if (!queue.retry(url, retries)) {
          failures.push({ url, error: message, attempts: attempt });
          if (verbose) console.log(`  ${profile} ✗ ${url} — ${message}`);
        } else if (verbose) {
          console.log(`  ${profile} ↻ ${url} — ${message}`);
        }
        queue.release();
      }
    }
  };

  try {
    await Promise.all(stack.sessions.map(worker));
  } finally {
    await stack.close();
  }

  return {
    rows,
    values,
    failures,
    stats: {
      visited,
      failed: failures.length,
      rows: rows.length,
      duplicatesDropped,
      byProfile,
      relaunches,
      retired,
      durationMs: Date.now() - began,
    },
  };
}
