/**
 * The two things the dashboard can run, and the settings behind each.
 *
 *   scrape - point browsers at pages and bring rows back
 *   bot    - point browsers at a login form, one account each
 *
 * Kept apart from `server.ts` so the shapes can be validated and tested
 * without a socket: everything here is a pure transformation of a config
 * object until `runScrape`/`runBot` are actually called, and a config that is
 * wrong should be refused before a browser is launched rather than three
 * minutes into a run.
 */
import { crawl, pageRange } from "./crawl";
import { sqliteStore, type Row } from "./storage";
import {
  accountBook,
  createAccounts,
  defineSite,
  ensureAccounts,
  signInAll,
  signInEach,
  type AccountRunResult,
  type AuthSpec,
  type Credentials,
} from "./accounts";
import { LOGIN_SITES } from "./login-sites";
import { parseActions, describeAction, type Action } from "./actions";
import type { StackKind } from "./stack";
import type { Engine } from "./browsers";
import type { ProxyLike } from "./proxies";
import path from "node:path";
import { parseRoutes, describeRoute } from "./routes";
import { defineMission, runOnce } from "./missions";
import { getProfile } from "./browsers";

// ---------------------------------------------------------------------------
// What a run reports back
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "step" | "good" | "warn" | "error";

/** Everything a running job can say, without knowing who is listening. */
export type JobContext = {
  log: (level: LogLevel, message: string) => void;
  /** Progress as done/total, either of which may be unknown. */
  progress: (done: number, total?: number) => void;
  /** Counters shown as chips in the UI - rows, failures, accounts, and so on. */
  stat: (name: string, value: number | string) => void;
  /** Cooperative cancellation, checked between pages and between browsers. */
  stopped: () => boolean;
};

export type JobResult = {
  summary: string;
  /** A sample for the results table; not the whole crawl. */
  rows?: Row[];
  /** Screenshot files a bot run took, newest run first in the UI. */
  shots?: string[];
  failures?: Array<{ url?: string; error: string }>;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type Field = { name: string; selector?: string; attribute?: string };

export type ScrapeConfig = {
  mode: "scrape";
  /** One URL per line, and/or a numbered range below. */
  urls?: string[];
  /** `{n}` in the pattern is replaced with each number in the range. */
  range?: { pattern: string; from: number; to: number };
  browsers?: number;
  kind?: StackKind;
  engine?: Engine;
  /** `label=url` lines, hops separated by `>`, as everywhere else. */
  proxies?: string;
  /** Let browsers share an exit IP when there are fewer routes than browsers. */
  allowSharedProxies?: boolean;
  /** Check each route's exit IP before the run, and report duplicates. */
  verifyExitIps?: boolean;
  perHostDelayMs?: number;
  retries?: number;
  maxPages?: number;
  timeout?: number;
  challenge?: boolean;
  /** The repeating element to read rows from. */
  rowSelector: string;
  /** Fields within a row. No selector means the row's own text. */
  fields: Field[];
  /** Links to follow, as a selector; discovered URLs join the same queue. */
  follow?: string;
  /** Field name to deduplicate on. */
  key?: string;
  store?: { path: string; table: string };
};

export type BotConfig = {
  mode: "bot";
  /**
   * What the browsers should do with the site.
   *
   * - `list`   - one credential from the pasted list per browser
   * - `preset` - every browser uses the catalogue site's published demo login,
   *              which is all those sites have; the only case where sharing
   *              one login across browsers is deliberate
   * - `signin` - each browser into the account the book says it owns
   * - `create` - a new account per browser
   * - `ensure` - sign in, or register if this browser has no account yet
   */
  action: "signin" | "create" | "ensure" | "list" | "preset";
  /** A name from `login-sites.ts`, instead of describing the site by hand. */
  preset?: string;
  site?: {
    name: string;
    loginUrl: string;
    signupUrl?: string;
    accept?: string[];
    /** A URL fragment that means "signed in", for sites with no account UI. */
    signedInUrlIncludes?: string;
    fields?: AuthSpec["fields"];
    submit?: AuthSpec["submit"];
  };
  /** `user:pass` per line, for `action: "list"`. */
  credentials?: string;
  browsers?: number;
  kind?: StackKind;
  engine?: Engine;
  proxies?: string;
  allowSharedProxies?: boolean;
  verifyExitIps?: boolean;
  staggerMs?: [number, number];
  challenge?: boolean;
  /** Email domain for generated identities. */
  domain?: string;
  book?: { path: string };
  /**
   * What each browser does once it is signed in: visit, click, type, scroll,
   * wait, read, screenshot. Run per browser, on its own session.
   */
  actions?: Action[];
  /** Where screenshots land. Default `runs/`. */
  shotDir?: string;
};

export type JobConfig = ScrapeConfig | BotConfig;

// ---------------------------------------------------------------------------
// Parsing what the form sends
// ---------------------------------------------------------------------------

/**
 * Credentials from a pasted list.
 *
 * `user:pass`, `user,pass` or `user pass`, one per line, `#` comments ignored.
 * Colon first, because an email contains neither a comma nor a space but a
 * password may well contain a colon - so the split is on the *first*
 * separator, and the rest of the line is the password.
 */
export function parseCredentials(raw: string): Credentials[] {
  const out: Credentials[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;

    const at = text.search(/[:,\s]/);
    if (at === -1) continue;
    const identifier = text.slice(0, at).trim();
    const password = text.slice(at + 1).trim();
    if (!identifier || !password) continue;

    out.push(
      identifier.includes("@")
        ? { email: identifier, password }
        : { username: identifier, password }
    );
  }
  return out;
}

/** URLs from an explicit list plus an optional numbered range. */
export function startUrls(config: ScrapeConfig): string[] {
  const urls = (config.urls ?? []).map((u) => u.trim()).filter(Boolean);

  if (config.range?.pattern) {
    const { pattern, from, to } = config.range;
    if (!pattern.includes("{n}")) {
      throw new Error('The page range pattern needs an {n} where the number goes');
    }
    if (!(to >= from)) throw new Error("The page range ends before it starts");
    if (to - from > 5000) throw new Error("That page range is over 5000 pages; narrow it");
    urls.push(...pageRange((n) => pattern.replace(/\{n\}/g, String(n)), from, to));
  }

  if (urls.length === 0) throw new Error("Give at least one URL, or a page range");
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) throw new Error(`Not a URL: ${url.slice(0, 60)}`);
  }
  return urls;
}

const routesToProxies = (raw?: string): ProxyLike[] | undefined => {
  const routes = parseRoutes(raw ?? "");
  const proxies = routes.map((r) => r.proxy).filter(Boolean) as ProxyLike[];
  return proxies.length ? proxies : undefined;
};

/**
 * One route per browser, or say why not.
 *
 * `openStack` refuses the short case on its own, but by then the browsers are
 * being launched. Catching it in validation turns a run that dies after the
 * first launch into a sentence in the form.
 */
function checkRoutes(raw: string | undefined, browsers: number, allowShared?: boolean): void {
  const routes = parseRoutes(raw ?? "");
  if (routes.length === 0) return;

  if (routes.length < browsers && !allowShared) {
    throw new Error(
      `${browsers} browsers but ${routes.length} route${routes.length === 1 ? "" : "s"} - ` +
        `two browsers would leave from the same IP. Add routes, lower the browser count, ` +
        `or tick "let browsers share a route".`
    );
  }

  // A list with the same proxy twice is the same problem wearing a disguise,
  // and it is an easy thing to do when pasting from two places.
  const seen = new Set<string>();
  for (const route of routes) {
    const key = describeRoute(route);
    if (seen.has(key)) throw new Error(`The route ${key} is in the list twice`);
    seen.add(key);
  }
}

/**
 * Ask each route where it comes out, before spending a run on it.
 *
 * The reason this is worth a minute: a proxy that is quietly dead, or one that
 * is not actually being used, produces a run whose results are attributed to
 * an exit that never carried them. Two routes that answer with the same IP are
 * the same failure in a subtler form - the list looks like an IP each and is
 * not.
 */
export async function verifyRoutes(raw: string | undefined, ctx: JobContext): Promise<void> {
  const routes = parseRoutes(raw ?? "");
  if (routes.length === 0) return;

  ctx.log("step", `checking ${routes.length} route${routes.length === 1 ? "" : "s"} for their exit IPs`);
  const seen = new Map<string, string>();

  for (const route of routes) {
    if (ctx.stopped()) return;
    const result = await runOnce(
      defineMission({
        name: "exit-ip",
        url: "https://ipinfo.io/json",
        retries: 0,
        timeout: 60_000,
        proxy: route.proxy,
        challenge: false as const,
        run: async ({ page }) => {
          const text = await page.locator("pre, body").first().innerText();
          return JSON.parse(text) as { ip?: string; org?: string; country?: string };
        },
      }),
      () => getProfile("desktop-chrome"),
      false
    );

    if (!result.ok) {
      ctx.log("error", `${route.label}: no exit - ${result.error.message.split("\n")[0].slice(0, 70)}`);
      continue;
    }

    const { ip = "?", org = "?", country = "?" } = result.value;
    const clash = seen.get(ip);
    if (clash) {
      ctx.log("warn", `${route.label}: ${ip} - same exit as ${clash}, so those browsers share an IP`);
    } else {
      ctx.log("good", `${route.label}: ${ip} · ${org} · ${country}`);
      seen.set(ip, route.label);
    }
  }
}

/** The site to work against: a catalogue preset, or one described by hand. */
export function resolveSite(config: BotConfig): { spec: AuthSpec; credentials?: Credentials } {
  if (config.preset) {
    const site = LOGIN_SITES.find((s) => s.spec.name === config.preset);
    if (!site) throw new Error(`Unknown preset "${config.preset}"`);
    return { spec: site.spec, credentials: site.credentials };
  }

  const site = config.site;
  if (!site?.loginUrl) throw new Error("Give a login URL, or pick a preset");
  if (!/^https?:\/\//i.test(site.loginUrl)) throw new Error("The login URL is not a URL");

  const includes = site.signedInUrlIncludes?.trim();
  return {
    spec: defineSite({
      name: site.name?.trim() || new URL(site.loginUrl).hostname,
      loginUrl: site.loginUrl,
      signupUrl: site.signupUrl?.trim() || undefined,
      accept: site.accept?.filter(Boolean),
      fields: site.fields,
      submit: site.submit,
      // A site with no account UI has to be told what "in" looks like; the
      // generic sign-out heuristic has nothing to read there.
      signedIn: includes ? async (page) => page.url().includes(includes) : undefined,
    }),
  };
}

/**
 * Refuse a config before anything launches.
 *
 * Every message here is one a person can act on: the point is that a run which
 * cannot work fails in the form, not in minute three of a crawl.
 */
export function validate(config: JobConfig): void {
  if (config.mode === "scrape") {
    startUrls(config);
    if (!config.rowSelector?.trim()) throw new Error("Give a selector for the repeating row");
    if (!config.fields?.length) throw new Error("Add at least one field to extract");
    for (const field of config.fields) {
      if (!field.name?.trim()) throw new Error("Every field needs a name");
    }
    if (config.key && !config.fields.some((f) => f.name === config.key)) {
      throw new Error(`The dedupe key "${config.key}" is not one of the fields`);
    }
    if ((config.browsers ?? 1) < 1) throw new Error("At least one browser");
    checkRoutes(config.proxies, config.browsers ?? 3, config.allowSharedProxies);
    return;
  }

  const { spec } = resolveSite(config);
  if (config.action === "create" && !spec.signupUrl) {
    throw new Error(`${spec.name} has no signup URL, so accounts cannot be created there`);
  }
  if (config.action === "preset") {
    if (!config.preset) throw new Error("Pick a preconfigured site for that action");
    const site = LOGIN_SITES.find((s) => s.spec.name === config.preset);
    if (!site) throw new Error(`Unknown preset "${config.preset}"`);
  }
  if (config.action === "list") {
    const credentials = parseCredentials(config.credentials ?? "");
    if (credentials.length === 0) throw new Error("Paste some credentials, as user:pass per line");
    if (credentials.length < (config.browsers ?? credentials.length)) {
      throw new Error(
        `${config.browsers} browsers but ${credentials.length} credentials - two browsers would share a login`
      );
    }
    const ids = credentials
      .slice(0, config.browsers ?? credentials.length)
      .map((c) => (c.email ?? c.username ?? "").toLowerCase());
    const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
    if (repeated) throw new Error(`"${repeated}" is in the credential list twice`);
  }
  if ((config.browsers ?? 1) < 1) throw new Error("At least one browser");
  checkRoutes(config.proxies, config.browsers ?? 3, config.allowSharedProxies);
  parseActions(config.actions);
}

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------

/**
 * The extractor, built as source text with its arguments already in it.
 *
 * Two traps here, both of which cost a run to find:
 *
 * - A function defined in this file and shipped to the page is rewritten by
 *   the TS runner - `__name` helpers that do not exist in the browser - and
 *   throws inside `evaluate` with a message about nothing to do with the
 *   selector. Source text survives any build pipeline, same as
 *   `hardeningScript`.
 * - Playwright evaluates a **string** as an expression and ignores the second
 *   argument, so `evaluate(fnSource, args)` hands the page a function it never
 *   calls and yields `undefined`. Measured, not assumed. So the arguments are
 *   baked in and the whole thing is an IIFE.
 */
function extractSource(rowSelector: string, fields: Field[]): string {
  return `(() => {
  const rowSelector = ${JSON.stringify(rowSelector)};
  const fields = ${JSON.stringify(fields)};
  const rows = [];
  const nodes = document.querySelectorAll(rowSelector);
  for (const node of nodes) {
    const row = {};
    let any = false;
    for (const field of fields) {
      const target = field.selector ? node.querySelector(field.selector) : node;
      if (!target) { row[field.name] = null; continue; }
      const value = field.attribute
        ? target.getAttribute(field.attribute)
        : (target.textContent || "").replace(/\\s+/g, " ").trim();
      row[field.name] = value === "" || value === null ? null : value;
      if (value) any = true;
    }
    if (any) rows.push(row);
  }
  return rows;
})()`;
}

const linksSource = (selector: string) =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
     .map((a) => a.href).filter(Boolean)`;

export async function runScrape(config: ScrapeConfig, ctx: JobContext): Promise<JobResult> {
  validate(config);
  const urls = startUrls(config);
  const store = config.store?.path
    ? sqliteStore({ path: config.store.path, table: config.store.table || "rows" })
    : undefined;

  ctx.log("step", `${urls.length} start URL${urls.length === 1 ? "" : "s"}, ${config.browsers ?? 3} browsers`);
  if (config.verifyExitIps) await verifyRoutes(config.proxies, ctx);
  if (store) ctx.log("info", `writing to ${config.store!.path} (${config.store!.table || "rows"})`);

  let visited = 0;
  const sample: Row[] = [];

  try {
    const result = await crawl({
      start: urls,
      browsers: config.browsers ?? 3,
      kind: config.kind ?? "mixed",
      engine: config.engine,
      proxies: routesToProxies(config.proxies),
      allowSharedProxies: config.allowSharedProxies,
      perHostDelayMs: config.perHostDelayMs ?? 250,
      retries: config.retries ?? 2,
      maxPages: config.maxPages,
      timeout: config.timeout ?? 45_000,
      challenge: config.challenge === false ? false : undefined,
      key: config.key ? (row) => String(row[config.key as string]) : undefined,
      store,
      stop: ctx.stopped,
      extract: async ({ page, url, enqueue }) => {
        const rows = (await page.evaluate(
          extractSource(config.rowSelector, config.fields)
        )) as Row[];

        if (config.follow?.trim()) {
          enqueue((await page.evaluate(linksSource(config.follow.trim()))) as string[]);
        }

        visited++;
        ctx.progress(visited, config.maxPages ?? undefined);
        ctx.stat("pages", visited);
        ctx.log(rows.length ? "good" : "warn", `${rows.length} rows · ${short(url)}`);
        if (sample.length < 50) sample.push(...rows.slice(0, 50 - sample.length));
        return rows;
      },
    });

    ctx.stat("rows", result.rows.length);
    ctx.stat("failed", result.stats.failed);
    ctx.stat("duplicates", result.stats.duplicatesDropped);
    for (const failure of result.failures) {
      ctx.log("error", `${short(failure.url)} gave up after ${failure.attempts}: ${failure.error}`);
    }

    return {
      summary:
        `${result.rows.length} rows from ${result.stats.visited} pages` +
        `${result.stats.failed ? `, ${result.stats.failed} failed` : ""}` +
        `${result.stats.duplicatesDropped ? `, ${result.stats.duplicatesDropped} duplicates dropped` : ""}`,
      rows: sample,
      failures: result.failures.map((f) => ({ url: f.url, error: f.error })),
    };
  } finally {
    await store?.close();
  }
}

const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70);

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export async function runBot(config: BotConfig, ctx: JobContext): Promise<JobResult> {
  validate(config);
  const { spec, credentials: presetCredentials } = resolveSite(config);
  const book = config.book?.path ? accountBook({ path: config.book.path }) : undefined;

  const options = {
    count: config.browsers ?? 3,
    kind: config.kind ?? "desktop",
    engine: config.engine,
    proxies: routesToProxies(config.proxies),
    allowSharedProxies: config.allowSharedProxies,
    stagger: config.staggerMs ?? ([500, 4000] as [number, number]),
    challenge: config.challenge === false ? (false as const) : undefined,
    domain: config.domain,
    stop: ctx.stopped,
    book,
    after: parseActions(config.actions),
    shotDir: config.shotDir,
  };

  ctx.log("step", `${spec.name}: ${config.action} with ${options.count} browser${options.count === 1 ? "" : "s"}`);
  if (options.after.length) {
    ctx.log("info", `then, per browser: ${options.after.map(describeAction).join(" → ")}`);
  }
  if (config.verifyExitIps) await verifyRoutes(config.proxies, ctx);

  try {
    let results: AccountRunResult[];

    if (config.action === "list") {
      const list = parseCredentials(config.credentials ?? "");
      ctx.log("info", `${list.length} credentials, one per browser`);
      results = await signInEach(spec, list, options);
    } else if (config.action === "create") {
      results = await createAccounts(spec, options);
    } else if (config.action === "ensure") {
      if (!book) throw new Error("Signing in or registering needs an account book to remember which is which");
      results = await ensureAccounts(spec, { ...options, book });
    } else if (config.action === "preset") {
      if (!presetCredentials) throw new Error(`${spec.name} publishes no credentials`);
      // The one case where several browsers share a login on purpose: these
      // sites have exactly one demo account, so an account each is not on
      // offer. Said out loud rather than assumed.
      ctx.log("warn", `every browser uses ${spec.name}'s single published login - they share an account`);
      results = await signInEach(
        spec,
        Array.from({ length: options.count }, () => presetCredentials),
        { ...options, allowSharedLogin: true }
      );
    } else {
      if (!book) throw new Error("Signing in needs an account book, or a credential list");
      results = await signInAll(spec, { ...options, book });
    }

    let done = 0;
    for (const result of results) {
      done++;
      ctx.progress(done, results.length);
      ctx.log(
        result.ok ? "good" : "error",
        `${result.profile.padEnd(24)} ${result.detail}`
      );
    }

    const ok = results.filter((r) => r.ok).length;
    const shots = results.flatMap((r) => r.actions?.shots ?? []);
    ctx.stat("browsers", results.length);
    ctx.stat("signed in", ok);
    ctx.stat("failed", results.length - ok);
    ctx.stat("challenged", results.filter((r) => r.challenged).length);
    if (options.after.length) {
      ctx.stat("steps", results.reduce((n, r) => n + (r.actions?.steps.length ?? 0), 0));
      if (shots.length) ctx.stat("screenshots", shots.length);
    }

    return {
      summary: `${ok}/${results.length} browsers ${config.action === "create" ? "registered" : "signed in"}`,
      // What each read step found becomes a column, so a run that collected a
      // price per account reads as a table rather than as log lines.
      rows: results.map((r) => ({
        profile: r.profile,
        email: r.email,
        ok: r.ok,
        challenged: r.challenged,
        detail: r.detail,
        seconds: Math.round(r.durationMs / 100) / 10,
        ...flattenData(r.actions),
        ...(r.actions?.shots.length ? { shots: r.actions.shots.map((s) => path.basename(s)).join(" ") } : {}),
      })),
      shots,
      failures: results.filter((r) => !r.ok).map((r) => ({ error: `${r.profile}: ${r.detail}` })),
    };
  } finally {
    book?.close();
  }
}

/** `read` results as flat columns, arrays joined so a table cell can hold them. */
function flattenData(actions?: { data: Record<string, string | string[] | null> }): Row {
  if (!actions) return {};
  const row: Row = {};
  for (const [name, value] of Object.entries(actions.data)) {
    row[name] = Array.isArray(value) ? value.join(" | ") : value;
  }
  return row;
}

export async function runJob(config: JobConfig, ctx: JobContext): Promise<JobResult> {
  return config.mode === "scrape" ? runScrape(config, ctx) : runBot(config, ctx);
}
