/**
 * A small mission runner on top of `browsers.ts`.
 *
 * A mission is one function that gets a ready page and returns something. The
 * runner handles the boring parts: picking a fingerprint, launching, retrying
 * on a different profile, running several at once, and closing everything.
 *
 *   const titles = await runMission(
 *     defineMission({
 *       name: "titles",
 *       url: "https://example.com",
 *       run: async ({ page }) => page.title(),
 *     }),
 *     { runs: 5, concurrency: 3 }
 *   );
 */
import type { Browser, BrowserContext, Page } from "playwright";
import {
  launchProfile,
  profileRotator,
  filterProfiles,
  type BrowserProfile,
} from "./browsers";
import {
  resolveProxy,
  proxyPool,
  describeProxy,
  type ProxyHop,
  type ProxyLike,
} from "./proxies";
import { toRows, type Row, type SaveMeta, type Store } from "./storage";
// Acting like a person lives in human.ts so that turnstile.ts can use the
// pointer without importing this file, which imports turnstile.ts for the
// challenge handling. Re-exported below, because this is where callers of the
// documented API expect to find it.
import { humanFor, humanDelay, randomPersona } from "./human";
import type { Human, Persona } from "./human";
import { passChallenge, type ChallengeOptions, type ChallengeOutcome } from "./turnstile";

export {
  humanize,
  humanFor,
  randomPersona,
  humanDelay,
  type Human,
  type Persona,
  type Point,
} from "./human";

/** Everything a mission gets to work with. */
export type MissionContext = {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  profile: BrowserProfile;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  /** Prefixed with the mission name and profile id. */
  log: (...args: unknown[]) => void;
  /** Timing and input helpers that do not look machine-generated. */
  human: Human;
  /** The proxy chain this attempt is going through, if any. */
  proxy?: ProxyHop[];
  /**
   * Write rows to the run's store as you find them, for missions that page
   * through results and should not hold everything until the end. The runner
   * also stores whatever `run` returns, so a mission using this should return
   * nothing.
   */
  save: (rows: unknown) => Promise<number>;
  /**
   * HTTP through the browser's own network stack, so the request carries the
   * browser's TLS fingerprint. Use this instead of `context.request`, which
   * issues from Node and fingerprints as Node - see `fetchViaPage`.
   */
  fetch: PageFetch;
  /**
   * Get past a Cloudflare interstitial if one is up.
   *
   * The runner already does this after navigating to `mission.url`. Call it
   * again after a navigation of your own - a form submit, a link - since a
   * challenge can appear on any request, not only the first.
   */
  challenge: (options?: ChallengeOptions) => Promise<ChallengeOutcome>;
};

export type Mission<T> = {
  name: string;
  /** Navigated to before `run`, if given. */
  url?: string;
  /** Restrict which fingerprints this mission may use. */
  profiles?: Parameters<typeof filterProfiles>[0];
  /** Extra attempts after a failure, each on a fresh profile. Default 2. */
  retries?: number;
  /** Per-attempt budget in ms, including launch. Default 60_000. */
  timeout?: number;
  /** Fix the behavioural traits instead of sampling fresh ones per attempt. */
  persona?: Persona;
  /** Proxy or chain for this mission; `RunOptions.proxies` overrides it. */
  proxy?: ProxyLike;
  /**
   * Handling of a Cloudflare interstitial after navigating to `url`. On by
   * default; `false` leaves the challenge page in front of `run`, which is
   * what a probe measuring blocks wants (see `field-test-live.ts`).
   */
  challenge?: false | ChallengeOptions;
  run: (ctx: MissionContext) => Promise<T>;
};

export type MissionResult<T> =
  | {
      ok: true;
      value: T;
      profile: BrowserProfile;
      attempts: number;
      durationMs: number;
      /** The chain that worked, e.g. "1.2.3.4:8080 -> 5.6.7.8:3128". */
      proxy?: string;
    }
  | {
      ok: false;
      error: Error;
      profile: BrowserProfile;
      attempts: number;
      durationMs: number;
      proxy?: string;
    };

/** Identity helper - exists so the callback gets its types inferred. */
export function defineMission<T>(mission: Mission<T>): Mission<T> {
  return mission;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// HTTP through the browser
// ---------------------------------------------------------------------------

export type PageResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: <T = unknown>() => T;
};

export type PageFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<PageResponse>;

/**
 * Fetch through the page, not through Node.
 *
 * `context.request` is issued by the Playwright driver, so it carries Node's
 * TLS fingerprint (JA4 `t13d521100_...`) while the page next to it carries
 * Chrome's (`t13d1517h2_...`). A site that fingerprints TLS sees a browser
 * session whose API calls are not a browser. Running `fetch` inside the page
 * uses the browser's own stack and matches its navigation exactly.
 *
 * The in-page call is subject to CORS, so cross-origin GETs fall back to
 * loading the URL in a throwaway tab, which is also the browser's stack.
 */
export function fetchViaPage(page: Page): PageFetch {
  return async (url, init = {}) => {
    const build = (status: number, headers: Record<string, string>, body: string) => ({
      status,
      headers,
      body,
      json: <T,>() => JSON.parse(body) as T,
    });

    try {
      const result = await page.evaluate(
        async ({ url, init }) => {
          const response = await fetch(url, {
            method: init.method ?? "GET",
            headers: init.headers,
            body: init.body,
            credentials: "include",
          });
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => (headers[key] = value));
          return { status: response.status, headers, body: await response.text() };
        },
        { url, init }
      );
      return build(result.status, result.headers, result.body);
    } catch (error) {
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET") throw error;

      // CORS blocked it; a navigation is not subject to CORS and still uses
      // the browser's TLS stack.
      const tab = await page.context().newPage();
      try {
        const response = await tab.goto(url, { waitUntil: "domcontentloaded" });
        if (!response) throw error;
        return build(
          response.status(),
          response.headers(),
          await response.text()
        );
      } finally {
        await tab.close();
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export type RunOptions = {
  /** How many times to run the mission. Default 1. */
  runs?: number;
  /** How many browsers at once. Default 3. */
  concurrency?: number;
  /** Fixed profiles to use, in order, instead of the rotation. */
  profiles?: BrowserProfile[];
  /** Print per-attempt progress. Default false. */
  verbose?: boolean;
  /**
   * Random delay before each run starts, `[min, max]` ms. Default [0, 2500].
   * Concurrent sessions that all begin on the same millisecond are a pattern
   * in the target's logs no matter how human each one looks on its own.
   */
  stagger?: [number, number];
  /**
   * Proxies or chains to rotate over, one per run - and the next one on every
   * retry. Overrides `mission.proxy`. A chain is an array of hops:
   * `[[hopA, hopB], [hopC]]` is two routes, the first two hops deep.
   */
  proxies?: ProxyLike[];
  /**
   * Where results go. Rows are written as each run finishes, so an
   * interrupted crawl keeps everything it had already collected.
   */
  store?: Store;
};

/** One attempt: launch, navigate, run, always close. */
async function attemptOnce<T>(
  mission: Mission<T>,
  profile: BrowserProfile,
  attempt: number,
  verbose: boolean,
  proxy?: ProxyLike,
  store?: Store,
  meta: SaveMeta = {}
): Promise<T> {
  const log = (...args: unknown[]) => {
    if (verbose) console.log(`[${mission.name}] ${profile.id}:`, ...args);
  };

  // A chain needs a local listener, which must outlive the browser using it.
  const active = proxy ? await resolveProxy(proxy) : undefined;
  if (active && verbose) log("via", describeProxy(active.hops));

  const session = await launchProfile(
    profile,
    active ? { proxy: active.proxy } : {}
  );
  try {
    const page = await session.context.newPage();
    const human = humanFor(page, mission.persona ?? randomPersona());

    // A challenge can be served on any request, so this is a helper the
    // mission can call again rather than something that only runs on entry.
    const challenge = async (options: ChallengeOptions = {}) => {
      const outcome = await passChallenge(page, {
        human,
        log: (message) => log(message),
        ...(mission.challenge === false ? {} : mission.challenge ?? {}),
        ...options,
      });
      if (outcome.challenged) log(outcome.detail);
      return outcome;
    };

    if (mission.url) {
      // A person does not navigate the instant the window appears.
      await human.pause(600);
      await page.goto(mission.url, { waitUntil: "domcontentloaded" });
      if (mission.challenge !== false) {
        const outcome = await challenge();
        // A challenge that did not resolve is a failed attempt, not a page:
        // letting `run` scrape the interstitial produces rows of nothing and
        // spends no retry. Retrying moves to a new profile and proxy, which
        // is exactly what an unresolved challenge calls for.
        if (!outcome.passed) throw new Error(`challenge not passed: ${outcome.detail}`);
      }
      // ...nor act the instant it paints.
      await human.pause(900);
    }
    return await mission.run({
      page,
      context: session.context,
      browser: session.browser,
      profile,
      attempt,
      log,
      human,
      challenge,
      proxy: active?.hops,
      fetch: fetchViaPage(page),
      save: async (rows) =>
        store
          ? store.save(toRows(rows), {
              ...meta,
              profile: profile.id,
              proxy: active ? describeProxy(active.hops) : undefined,
              attempts: attempt,
            })
          : 0,
    });
  } finally {
    await session.browser.close().catch(() => {});
    await active?.close().catch(() => {});
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Run a mission once, retrying on a fresh profile each time it fails. */
export async function runOnce<T>(
  mission: Mission<T>,
  nextProfile: () => BrowserProfile,
  verbose = false,
  nextProxy?: () => ProxyLike,
  store?: Store,
  target?: string
): Promise<MissionResult<T>> {
  const started = Date.now();
  const maxAttempts = (mission.retries ?? 2) + 1;
  const timeout = mission.timeout ?? 60_000;

  let profile = nextProfile();
  let proxy = nextProxy ? nextProxy() : mission.proxy;
  let lastError = new Error("no attempt was made");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const describe = proxy ? describeProxy(asHopList(proxy)) : undefined;
    try {
      const value = await withTimeout(
        attemptOnce(mission, profile, attempt, verbose, proxy, store, {
          mission: mission.name,
          target: target ?? mission.url,
        }),
        timeout,
        `${mission.name} on ${profile.id}`
      );
      const rows = toRows(value);
      if (store && rows.length > 0) {
        await store.save(rows, {
          mission: mission.name,
          profile: profile.id,
          proxy: describe,
          target: target ?? mission.url,
          attempts: attempt,
          durationMs: Date.now() - started,
        });
      }

      return {
        ok: true,
        value,
        profile,
        attempts: attempt,
        durationMs: Date.now() - started,
        proxy: describe,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (verbose) {
        console.log(
          `[${mission.name}] ${profile.id}: attempt ${attempt} failed - ${lastError.message}`
        );
      }
      // A block is usually specific to the fingerprint or the IP that earned
      // it, so retry on both a fresh profile and the next proxy.
      if (attempt < maxAttempts) {
        profile = nextProfile();
        if (nextProxy) proxy = nextProxy();
      }
    }
  }

  return {
    ok: false,
    error: lastError,
    profile,
    attempts: maxAttempts,
    durationMs: Date.now() - started,
    proxy: proxy ? describeProxy(asHopList(proxy)) : undefined,
  };
}

/** Normalise any proxy shape to a hop list, for logging. */
function asHopList(proxy: ProxyLike): ProxyHop[] {
  return typeof proxy === "string"
    ? [{ server: proxy }]
    : Array.isArray(proxy)
      ? proxy
      : [proxy];
}

/**
 * Run a mission `runs` times, at most `concurrency` browsers at a time.
 * Never rejects: every run comes back as an ok or failed result.
 */
export async function runMission<T>(
  mission: Mission<T>,
  options: RunOptions = {}
): Promise<MissionResult<T>[]> {
  const { runs = 1, concurrency = 3, verbose = false } = options;

  const fixed = options.profiles;
  const rotate = fixed
    ? (() => {
        let i = 0;
        return () => fixed[i++ % fixed.length];
      })()
    : profileRotator(mission.profiles);

  const results: MissionResult<T>[] = new Array(runs);
  let cursor = 0;

  const nextProxy = options.proxies ? proxyPool(options.proxies) : undefined;
  const [minGap, maxGap] = options.stagger ?? [0, 2500];
  const worker = async () => {
    while (cursor < runs) {
      const index = cursor++;
      if (maxGap > 0) await sleep(humanDelay(rand(minGap, maxGap) || 1, 0.5));
      results[index] = await runOnce(
        mission,
        rotate,
        verbose,
        nextProxy,
        options.store
      );
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, runs) }, worker)
  );
  return results;
}

/**
 * Run one mission per target, each on its own fingerprint - the usual shape
 * for "scrape these 50 URLs".
 */
export async function runEach<Target, T>(
  targets: Target[],
  build: (target: Target) => Mission<T>,
  options: Omit<RunOptions, "runs"> = {}
): Promise<Array<MissionResult<T> & { target: Target }>> {
  const { concurrency = 3, verbose = false } = options;
  const rotate = options.profiles
    ? (() => {
        let i = 0;
        return () => options.profiles![i++ % options.profiles!.length];
      })()
    : profileRotator();

  const results = new Array<MissionResult<T> & { target: Target }>(targets.length);
  let cursor = 0;

  const nextProxy = options.proxies ? proxyPool(options.proxies) : undefined;
  const [minGap, maxGap] = options.stagger ?? [0, 2500];
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index];
      if (maxGap > 0) await sleep(humanDelay(rand(minGap, maxGap) || 1, 0.5));
      // Each target builds its own mission, so its `profiles` filter has to be
      // honoured here - the shared rotator knows nothing about it.
      const mission = build(target);
      const pick =
        options.profiles || !mission.profiles
          ? rotate
          : profileRotator(mission.profiles);
      const result = await runOnce(
        mission,
        pick,
        verbose,
        nextProxy,
        options.store,
        typeof target === "string" ? target : undefined
      );
      results[index] = { ...result, target };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker)
  );
  return results;
}

/** Split results into the values that came back and the failures. */
export function partition<T>(results: MissionResult<T>[]) {
  return {
    values: results.flatMap((r) => (r.ok ? [r.value] : [])),
    failures: results.flatMap((r) => (r.ok ? [] : [r])),
  };
}
