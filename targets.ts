/**
 * Targets for the live probe, graded and grouped.
 *
 * The `vendor` field is what that site is *expected* to run - the probe
 * detects what is actually there and the two are compared, so a wrong guess
 * here shows up as a mismatch rather than silently misleading you.
 *
 * The controls matter as much as the hard targets. If wikipedia.org fails,
 * the tunnel, the display or the build is broken and nothing else in the run
 * means anything. Always keep at least one control in a probe.
 */

export type Vendor =
  | "none"
  | "cloudflare"
  | "datadome"
  | "perimeterx"
  | "kasada"
  | "akamai"
  | "imperva"
  | "unknown";

export type Category =
  | "control"
  | "detector"
  | "retail"
  | "marketplace"
  | "travel"
  | "tickets"
  | "jobs"
  | "property"
  | "reviews"
  | "media";

export type Target = {
  url: string;
  /** Short name used in output and as part of the result key. */
  name: string;
  category: Category;
  /** What this site is expected to be running. Verified, not trusted. */
  vendor: Vendor;
  /** Roughly how hard it has been to load, from observation. */
  difficulty: "easy" | "medium" | "hard";
  note?: string;
};

export const TARGETS: Target[] = [
  // --- Controls: must always pass. A failure here is a broken setup. ---
  { url: "https://example.com/", name: "example", category: "control", vendor: "none", difficulty: "easy" },
  { url: "https://www.wikipedia.org/", name: "wikipedia", category: "control", vendor: "none", difficulty: "easy" },
  { url: "https://news.ycombinator.com/", name: "hn", category: "control", vendor: "none", difficulty: "easy" },
  { url: "https://httpbin.org/headers", name: "httpbin", category: "control", vendor: "none", difficulty: "easy",
    note: "echoes the request headers back - useful when a header looks wrong" },

  // --- Detectors: grade the browser and publish a verdict. ---
  { url: "https://bot.sannysoft.com/", name: "sannysoft", category: "detector", vendor: "none", difficulty: "easy" },
  { url: "https://abrahamjuliot.github.io/creepjs/", name: "creepjs", category: "detector", vendor: "none", difficulty: "easy" },
  { url: "https://tls.browserleaks.com/json", name: "tls", category: "detector", vendor: "none", difficulty: "easy",
    note: "JA3/JA4 - compare against a real Chrome" },
  { url: "https://browserleaks.com/javascript", name: "browserleaks-js", category: "detector", vendor: "none", difficulty: "easy" },

  // --- Cloudflare ---
  { url: "https://www.indeed.com/", name: "indeed", category: "jobs", vendor: "cloudflare", difficulty: "medium",
    note: "passed from both datacenter and residential; issues cf_clearance" },
  { url: "https://www.upwork.com/", name: "upwork", category: "jobs", vendor: "cloudflare", difficulty: "hard" },
  { url: "https://www.crunchbase.com/", name: "crunchbase", category: "reviews", vendor: "cloudflare", difficulty: "hard" },
  { url: "https://medium.com/", name: "medium", category: "media", vendor: "cloudflare", difficulty: "medium" },
  { url: "https://www.zoopla.co.uk/", name: "zoopla", category: "property", vendor: "cloudflare", difficulty: "medium" },

  // --- DataDome ---
  { url: "https://www.g2.com/", name: "g2", category: "reviews", vendor: "datadome", difficulty: "hard",
    note: "empty-bodied 403 behind a cf_clearance cookie: rejected after the JS layer ran" },
  { url: "https://www.leboncoin.fr/", name: "leboncoin", category: "marketplace", vendor: "datadome", difficulty: "hard" },
  { url: "https://www.vinted.com/", name: "vinted", category: "marketplace", vendor: "datadome", difficulty: "hard" },
  { url: "https://www.seloger.com/", name: "seloger", category: "property", vendor: "datadome", difficulty: "hard" },
  { url: "https://www.rakuten.com/", name: "rakuten", category: "retail", vendor: "datadome", difficulty: "medium" },

  // --- PerimeterX / HUMAN ---
  { url: "https://www.zillow.com/", name: "zillow", category: "property", vendor: "perimeterx", difficulty: "hard",
    note: "403 at the edge from a datacenter IP, clean from residential" },
  { url: "https://www.walmart.com/", name: "walmart", category: "retail", vendor: "perimeterx", difficulty: "medium",
    note: "passed from both routes" },
  { url: "https://www.wayfair.com/", name: "wayfair", category: "retail", vendor: "perimeterx", difficulty: "hard" },
  { url: "https://www.grubhub.com/", name: "grubhub", category: "retail", vendor: "perimeterx", difficulty: "hard" },
  { url: "https://www.booking.com/", name: "booking", category: "travel", vendor: "perimeterx", difficulty: "medium" },

  // --- Kasada ---
  { url: "https://www.ticketmaster.com/", name: "ticketmaster", category: "tickets", vendor: "kasada", difficulty: "hard",
    note: '"Your Browsing Activity Has Been Paused" at the edge; clean from residential' },
  { url: "https://www.stubhub.com/", name: "stubhub", category: "tickets", vendor: "kasada", difficulty: "hard" },
  { url: "https://www.hyatt.com/", name: "hyatt", category: "travel", vendor: "kasada", difficulty: "medium" },

  // --- Akamai ---
  { url: "https://www.nike.com/", name: "nike", category: "retail", vendor: "akamai", difficulty: "hard" },
  { url: "https://www.target.com/", name: "target", category: "retail", vendor: "akamai", difficulty: "hard" },
  { url: "https://www.bestbuy.com/", name: "bestbuy", category: "retail", vendor: "akamai", difficulty: "hard" },
  { url: "https://www.adidas.com/us", name: "adidas", category: "retail", vendor: "akamai", difficulty: "hard" },
  { url: "https://www.homedepot.com/", name: "homedepot", category: "retail", vendor: "akamai", difficulty: "medium" },
  { url: "https://www.expedia.com/", name: "expedia", category: "travel", vendor: "akamai", difficulty: "medium" },

  // --- Imperva ---
  { url: "https://www.ryanair.com/", name: "ryanair", category: "travel", vendor: "imperva", difficulty: "hard" },
  { url: "https://www.saks.com/", name: "saks", category: "retail", vendor: "imperva", difficulty: "hard" },
];

export type TargetFilter = {
  vendor?: Vendor | Vendor[];
  category?: Category | Category[];
  difficulty?: Target["difficulty"] | Target["difficulty"][];
  /** Exact names, e.g. `g2,zillow`. */
  names?: string[];
  /** Cap the number returned, after filtering. */
  limit?: number;
  /** Prepend a control so a broken setup is obvious. Default true. */
  withControl?: boolean;
};

const asList = <T,>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : ([] as T[]).concat(value);

/** Select targets. Names win outright; other filters combine. */
export function selectTargets(filter: TargetFilter = {}): Target[] {
  const { withControl = true, limit } = filter;

  let chosen: Target[];
  if (filter.names?.length) {
    const missing = filter.names.filter((n) => !TARGETS.some((t) => t.name === n));
    if (missing.length) {
      throw new Error(
        `Unknown target(s): ${missing.join(", ")}. Known: ${TARGETS.map((t) => t.name).join(", ")}`
      );
    }
    chosen = TARGETS.filter((t) => filter.names!.includes(t.name));
  } else {
    const vendors = asList(filter.vendor);
    const categories = asList(filter.category);
    const difficulties = asList(filter.difficulty);

    chosen = TARGETS.filter(
      (t) =>
        (!vendors || vendors.includes(t.vendor)) &&
        (!categories || categories.includes(t.category)) &&
        (!difficulties || difficulties.includes(t.difficulty))
    );
    if (chosen.length === 0) throw new Error("No targets match that filter");
  }

  if (limit !== undefined) chosen = chosen.slice(0, limit);

  // A run with no control cannot tell "the site blocked us" from "the tunnel
  // is down", so put one in front unless asked not to.
  if (withControl && !chosen.some((t) => t.category === "control")) {
    chosen = [TARGETS.find((t) => t.name === "example")!, ...chosen];
  }

  return chosen;
}

/** Build a filter from `--vendor=`, `--category=`, `--targets=`, `--limit=`. */
export function filterFromArgs(argv: string[]): TargetFilter {
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  const split = (value?: string) =>
    value?.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    vendor: split(get("vendor")) as Vendor[] | undefined,
    category: split(get("category")) as Category[] | undefined,
    difficulty: split(get("difficulty")) as Target["difficulty"][] | undefined,
    names: split(get("targets")),
    limit: get("limit") ? Number(get("limit")) : undefined,
    withControl: !argv.includes("--no-control"),
  };
}
