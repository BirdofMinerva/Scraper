/**
 * Build a stack of browsers: pick how many and what kind, get back live
 * sessions ready to drive.
 *
 *   const stack = await openStack({ kind: "mixed", count: 5 });
 *   for (const { page, profile } of stack.sessions) await page.goto(url);
 *   await stack.close();
 *
 * Or from the shell, which opens them and holds them open:
 *
 *   npx tsx stack.ts --kind=mobile --count=4
 *   npx tsx stack.ts --kind=mixed --count=6 --url=https://example.com
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { ConfigError } from "./errors";
import {
  filterProfiles,
  getProfile,
  launchProfile,
  profileRotator,
  type BrowserProfile,
  type Engine,
} from "./browsers";
import { resolveProxy, proxyPool, describeProxy, type ActiveProxy, type ProxyLike } from "./proxies";

/** Shorthand for the profile filters people actually ask for. */
export type StackKind = "mixed" | "desktop" | "mobile" | "tablet" | "handheld";

export type StackOptions = {
  /** What to fill the stack with. Default "mixed". */
  kind?: StackKind;
  /** How many browsers. Default 3. */
  count?: number;
  /**
   * Exact fingerprints, in order, by id or profile - `kind`, `engine` and
   * `count` are then ignored.
   *
   * The rotation is shuffled, so two runs asking for "three desktop browsers"
   * get three different ones. That is right for scraping and wrong for
   * anything holding state per fingerprint: an account created by
   * `desktop-edge` has to be signed into by `desktop-edge`.
   */
  profiles?: Array<BrowserProfile | string>;
  /** Restrict to one engine, e.g. only chromium. */
  engine?: Engine | Engine[];
  /**
   * Routes, one per browser, in order.
   *
   * Fewer routes than browsers throws, the same way too few profiles does:
   * two browsers sharing an exit IP is the correlation a stack exists to
   * avoid, and silently reusing one is indistinguishable from a run that had
   * an IP each. `allowSharedProxies` says it out loud when it is deliberate.
   */
  proxies?: ProxyLike[];
  /** Let browsers share a route when there are fewer routes than browsers. */
  allowSharedProxies?: boolean;
  /** Open a page in each and navigate to this. */
  url?: string;
  /**
   * Allow the same profile more than once when `count` exceeds the pool.
   * Off by default: duplicates share a fingerprint, which is exactly the
   * correlation a stack is meant to avoid. Turning it on is fine when the
   * browsers are pointed at different targets.
   */
  allowDuplicates?: boolean;
  /** Launch browsers this many at a time. Default 4. */
  concurrency?: number;
};

export type StackSession = {
  profile: BrowserProfile;
  browser: Browser;
  context: BrowserContext;
  /** Present when `url` was given, or created on demand by `openPages()`. */
  page?: Page;
  proxy?: string;
};

export type Stack = {
  sessions: StackSession[];
  /** Open a page in every session that does not have one yet. */
  openPages: (url?: string) => Promise<Page[]>;
  /** Close everything, browsers and proxy listeners alike. */
  close: () => Promise<void>;
};

const KINDS: Record<StackKind, Parameters<typeof filterProfiles>[0]> = {
  mixed: {},
  desktop: { formFactor: "desktop" },
  mobile: { formFactor: "mobile" },
  tablet: { formFactor: "tablet" },
  handheld: { formFactor: ["mobile", "tablet"] },
};

/** The profiles a stack would use, without launching anything. */
export function planStack(options: StackOptions = {}): BrowserProfile[] {
  const { kind = "mixed", count = 3, allowDuplicates = false } = options;

  if (options.profiles?.length) {
    const chosen = options.profiles.map((p) => (typeof p === "string" ? getProfile(p) : p));
    const ids = new Set(chosen.map((p) => p.id));
    if (ids.size !== chosen.length && !allowDuplicates) {
      throw new ConfigError(
        `Asked for the same fingerprint twice: ${chosen.map((p) => p.id).join(", ")}. ` +
          `Pass allowDuplicates if that is deliberate.`
      );
    }
    return chosen;
  }

  const filter = { ...KINDS[kind] };
  if (options.engine) filter.engine = options.engine;

  const pool = filterProfiles(filter);
  if (pool.length === 0) {
    throw new ConfigError(`No profiles match kind "${kind}"${options.engine ? ` on ${options.engine}` : ""}`);
  }
  if (count > pool.length && !allowDuplicates) {
    throw new ConfigError(
      `Asked for ${count} browsers but only ${pool.length} distinct ${kind} profiles exist. ` +
        `Pass allowDuplicates to reuse fingerprints, or lower count.`
    );
  }

  const next = profileRotator(filter);
  return Array.from({ length: count }, next);
}

/** Launch the stack. Always close it, or you leave browsers running. */
export async function openStack(options: StackOptions = {}): Promise<Stack> {
  const { concurrency = 4, url } = options;
  const profiles = planStack(options);

  if (
    options.proxies?.length &&
    options.proxies.length < profiles.length &&
    !options.allowSharedProxies
  ) {
    throw new ConfigError(
      `${profiles.length} browsers but only ${options.proxies.length} route` +
        `${options.proxies.length === 1 ? "" : "s"}. Two browsers would leave from the same IP. ` +
        `Add routes, lower count, or pass allowSharedProxies.`
    );
  }

  const nextProxy = options.proxies?.length ? proxyPool(options.proxies) : undefined;

  const sessions: StackSession[] = new Array(profiles.length);
  const actives: ActiveProxy[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < profiles.length) {
      const index = cursor++;
      const profile = profiles[index];

      const active = nextProxy ? await resolveProxy(nextProxy()) : undefined;
      if (active) actives.push(active);

      const session = await launchProfile(profile, active ? { proxy: active.proxy } : {});
      const entry: StackSession = {
        profile,
        browser: session.browser,
        context: session.context,
        proxy: active ? describeProxy(active.hops) : undefined,
      };

      if (url) {
        entry.page = await session.context.newPage();
        await entry.page.goto(url, { waitUntil: "domcontentloaded" });
      }
      sessions[index] = entry;
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, profiles.length) }, worker)
    );
  } catch (error) {
    // A half-open stack leaks browser processes, so tear down what did start.
    await Promise.all(sessions.filter(Boolean).map((s) => s.browser.close().catch(() => {})));
    await Promise.all(actives.map((a) => a.close().catch(() => {})));
    throw error;
  }

  return {
    sessions,
    async openPages(target = url) {
      return Promise.all(
        sessions.map(async (session) => {
          if (!session.page) session.page = await session.context.newPage();
          if (target) await session.page.goto(target, { waitUntil: "domcontentloaded" });
          return session.page;
        })
      );
    },
    async close() {
      await Promise.all(sessions.map((s) => s.browser.close().catch(() => {})));
      await Promise.all(actives.map((a) => a.close().catch(() => {})));
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };

  const kind = (get("kind") ?? "mixed") as StackKind;
  if (!(kind in KINDS)) {
    throw new ConfigError(`Unknown --kind=${kind}. Options: ${Object.keys(KINDS).join(", ")}`);
  }

  return {
    kind,
    count: Number(get("count") ?? 3),
    engine: get("engine") as Engine | undefined,
    url: get("url"),
    allowDuplicates: argv.includes("--allow-duplicates"),
    dryRun: argv.includes("--plan"),
    proxies: get("proxies")?.split(",").filter(Boolean),
  };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const options: StackOptions = {
      kind: args.kind,
      count: args.count,
      engine: args.engine,
      url: args.url,
      allowDuplicates: args.allowDuplicates,
      proxies: args.proxies,
    };

    if (args.dryRun) {
      const planned = planStack(options);
      console.log(`${args.count} × ${args.kind}:`);
      for (const p of planned) {
        console.log(`  ${p.id.padEnd(32)} ${p.engine.padEnd(9)} ${p.name}`);
      }
      return;
    }

    console.log(`opening ${args.count} ${args.kind} browsers…\n`);
    const stack = await openStack(options);

    for (const s of stack.sessions) {
      console.log(
        `  ${s.profile.id.padEnd(32)} ${s.profile.engine.padEnd(9)} ${s.browser.version().padEnd(16)}${s.proxy ?? ""}`
      );
    }

    console.log(`\n${stack.sessions.length} browsers open. Ctrl+C to close them.`);
    const shutdown = async () => {
      console.log("\nclosing…");
      await stack.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {}); // hold them open
  })().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
