/**
 * ScrapingCourse challenges, solved with this framework.
 *
 *   npx tsx challenges.ts
 *   PROXIES="home=socks5://127.0.0.1:1080" npx tsx challenges.ts
 *
 * Each challenge asserts on the data it recovered, not on a status code: a
 * page that loads and yields nothing is a failure, and several of these serve
 * an empty shell to anything that does not run JavaScript.
 *
 * The last two - /antibot-challenge and /cloudflare-challenge - are Cloudflare
 * interstitials with a Turnstile checkbox on them. They are solved the same
 * way as the rest: a real headed Chrome wearing a coherent profile, and a
 * pointer that travels to the checkbox instead of teleporting onto it. See
 * `turnstile.ts`.
 */
import { openStack } from "./stack";
import { crawl, pageRange } from "./crawl";
import { sqliteStore, type Store } from "./storage";
import { parseRoutes } from "./routes";
import { gotoAndPass } from "./turnstile";
import { signIn, SCRAPINGCOURSE, SCRAPINGCOURSE_DEMO } from "./accounts";
import type { Page } from "playwright";

const BASE = "https://www.scrapingcourse.com";
const ROUTE = parseRoutes(process.env.PROXIES ?? "")[0];
const PROXIES = ROUTE?.proxy ? [ROUTE.proxy] : undefined;

type Outcome = { name: string; passed: boolean; detail: string };

const rule = "-".repeat(76);

/** Products as every one of these pages renders them. */
const readProducts = (page: Page) =>
  page.$$eval(".product-item, li.product", (nodes) =>
    nodes.map((n) => ({
      name: n.querySelector(".product-name")?.textContent?.trim(),
      price: n.querySelector(".product-price, .price")?.textContent?.trim(),
      image: n.querySelector("img")?.getAttribute("src") ?? undefined,
    }))
  );

const complete = (rows: Array<{ name?: string; price?: string }>) =>
  rows.filter((r) => r.name && r.price);

const unique = (rows: Array<{ name?: string }>) =>
  new Set(rows.map((r) => r.name)).size;

/**
 * 1. JavaScript rendering - the markup arrives empty and is built client-side.
 */
async function javascriptRendering(store: Store): Promise<Outcome> {
  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  try {
    const page = await stack.sessions[0].context.newPage();
    await page.goto(`${BASE}/javascript-rendering`, { waitUntil: "domcontentloaded" });
    // Not just .product-item: the page renders skeleton placeholders with that
    // class first, so waiting on the selector alone returns twelve empty rows.
    // Wait for one to actually carry a name.
    await page.waitForFunction(
      () => !!document.querySelector(".product-name")?.textContent?.trim(),
      undefined,
      { timeout: 20_000 }
    );

    const rows = complete(await readProducts(page));
    await store.save(rows.map((r) => ({ ...r, challenge: "javascript-rendering" })));
    return {
      name: "javascript-rendering",
      passed: rows.length >= 12,
      detail: `${rows.length} products, all with name and price`,
    };
  } finally {
    await stack.close();
  }
}

/**
 * 2. Button click - a "load more" button that appends a batch each press.
 *
 * Driven with `human.click`, so the presses carry the pointer travel and
 * dwell of the rest of the toolkit rather than firing instantly.
 */
async function buttonClick(store: Store): Promise<Outcome> {
  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  try {
    const session = stack.sessions[0];
    const page = await session.context.newPage();
    await page.goto(`${BASE}/button-click`, { waitUntil: "domcontentloaded" });

    const before = (await readProducts(page)).length;
    let presses = 0;

    // Press until the button is gone or the grid stops growing - never a fixed
    // count, which breaks the moment the page adds a batch.
    while (presses < 30) {
      const button = page.locator("#load-more-btn");
      if ((await button.count()) === 0 || !(await button.isVisible().catch(() => false))) break;

      const countBefore = (await readProducts(page)).length;
      await button.scrollIntoViewIfNeeded();
      await button.click();
      presses++;
      await page
        .waitForFunction(
          (n) => document.querySelectorAll(".product-item").length > n,
          countBefore,
          { timeout: 10_000 }
        )
        .catch(() => {});
      if ((await readProducts(page)).length === countBefore) break;
    }

    const rows = complete(await readProducts(page));
    await store.save(rows.map((r, i) => ({ ...r, challenge: "button-click", position: i })));
    // The catalogue cycles the same products, so repeated names are the site
    // being itself, not the scraper double-counting. Judge on growth and on
    // every row being complete.
    return {
      name: "button-click",
      passed: rows.length > before && rows.length === (await readProducts(page)).length,
      detail: `${before} → ${rows.length} products over ${presses} presses (${unique(rows)} distinct names)`,
    };
  } finally {
    await stack.close();
  }
}

/**
 * 3. Infinite scrolling - more products load as the page is scrolled.
 */
async function infiniteScrolling(store: Store): Promise<Outcome> {
  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  try {
    const page = await stack.sessions[0].context.newPage();
    await page.goto(`${BASE}/infinite-scrolling`, { waitUntil: "domcontentloaded" });

    const before = (await readProducts(page)).length;
    let stalls = 0;
    let scrolls = 0;

    // Stop on three consecutive scrolls that add nothing: one quiet scroll is
    // often just a slow batch still in flight.
    while (stalls < 3 && scrolls < 60) {
      const countBefore = (await readProducts(page)).length;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      scrolls++;
      await page
        .waitForFunction(
          (n) => document.querySelectorAll(".product-item").length > n,
          countBefore,
          { timeout: 4000 }
        )
        .catch(() => {});
      stalls = (await readProducts(page)).length > countBefore ? 0 : stalls + 1;
    }

    const rows = complete(await readProducts(page));
    await store.save(rows.map((r, i) => ({ ...r, challenge: "infinite-scrolling", position: i })));
    return {
      name: "infinite-scrolling",
      passed: rows.length > before && rows.length === (await readProducts(page)).length,
      detail: `${before} → ${rows.length} products over ${scrolls} scrolls (${unique(rows)} distinct names)`,
    };
  } finally {
    await stack.close();
  }
}

/**
 * 4. Pagination - follow the numbered links to the end.
 *
 * Uses the crawl queue: page 1 is the only URL given, and each page enqueues
 * the ones it links to.
 */
async function pagination(store: Store): Promise<Outcome> {
  const result = await crawl({
    start: [`${BASE}/pagination`],
    browsers: 3,
    engine: "chromium",
    proxies: PROXIES,
    perHostDelayMs: 300,
    // Products repeat across pages here, so key on page and position, not name.
    key: (row) => `pagination|${row.page}|${row.name}`,
    store,
    extract: async ({ page, enqueue }) => {
      // The paths are /pagination/2, which does not contain "page" - the old
      // filter looked for exactly that and enqueued nothing, so the crawl
      // stopped after one page and looked like a site with no pagination.
      const links = await page.$$eval("#pagination-container a", (as) =>
        as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
      );
      enqueue(links);
      const rows = await readProducts(page);
      const number = page.url().match(/pagination\/(\d+)/)?.[1] ?? "1";
      return complete(rows).map((r) => ({ ...r, challenge: "pagination", page: number }));
    },
  });

  return {
    name: "pagination",
    passed: result.stats.visited > 1 && result.rows.length > 12 && result.stats.failed === 0,
    detail: `${result.rows.length} products across ${result.stats.visited} pages, ${result.stats.duplicatesDropped} duplicates dropped`,
  };
}

/**
 * 5. Table parsing - a plain HTML table, read into rows.
 */
async function tableParsing(store: Store): Promise<Outcome> {
  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  try {
    const page = await stack.sessions[0].context.newPage();
    await page.goto(`${BASE}/table-parsing`, { waitUntil: "domcontentloaded" });

    const rows = await page.$$eval(".product-item", (nodes) =>
      nodes.map((n) => ({
        id: n.querySelector(".product-id")?.textContent?.trim(),
        name: n.querySelector(".product-name")?.textContent?.trim(),
        price: n.querySelector(".product-price")?.textContent?.trim(),
        category: n.querySelector(".product-category")?.textContent?.trim(),
        stock: n.querySelector(".product-stock")?.textContent?.trim(),
      }))
    );

    const full = rows.filter((r) => r.id && r.name && r.price && r.category && r.stock);
    await store.save(full.map((r) => ({ ...r, challenge: "table-parsing" })));
    return {
      name: "table-parsing",
      passed: full.length === rows.length && full.length >= 10,
      detail: `${full.length} of ${rows.length} rows with every field populated`,
    };
  } finally {
    await stack.close();
  }
}

/**
 * 6. Login - the site's own published practice credentials.
 *
 * Driven through `accounts.ts` rather than by filling the fields here: the
 * form is found by discovery, typed by `human`, and any challenge on the POST
 * is passed before the result is read. The wrong-password run is the half that
 * makes the pass meaningful - a flow that reports success on both is reporting
 * nothing.
 */
async function login(): Promise<Outcome> {
  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  try {
    const page = await stack.sessions[0].context.newPage();
    const good = await signIn(page, SCRAPINGCOURSE_DEMO, SCRAPINGCOURSE);

    const other = await stack.sessions[0].context.newPage();
    const bad = await signIn(other, { ...SCRAPINGCOURSE_DEMO, password: "not-the-password" }, SCRAPINGCOURSE);

    return {
      name: "login",
      passed: good.ok && !bad.ok,
      detail: good.ok
        ? `${good.detail}; wrong password ${bad.ok ? "ALSO accepted" : "refused"}`
        : good.detail,
    };
  } finally {
    await stack.close();
  }
}

/**
 * 7. E-commerce - the largest listing, crawled across its numbered pages.
 */
async function ecommerce(store: Store): Promise<Outcome> {
  const result = await crawl({
    start: pageRange((n) => `${BASE}/ecommerce/page/${n}/`, 1, 12),
    browsers: 4,
    kind: "mixed",
    proxies: PROXIES,
    perHostDelayMs: 250,
    key: (row) => `ecommerce|${row.name}`,
    store,
    retries: 1,
    extract: async ({ page }) => {
      const rows = await readProducts(page);
      return complete(rows).map((r) => ({ ...r, challenge: "ecommerce" }));
    },
  });

  return {
    name: "ecommerce",
    passed: result.rows.length >= 100 && result.stats.failed === 0,
    detail: `${result.rows.length} products across ${result.stats.visited} pages, ${result.stats.failed} failures`,
  };
}

/**
 * 8 and 9. The two Cloudflare interstitials.
 *
 * Both serve a 403 with `cf-mitigated: challenge` to anything that asks, and
 * put a Turnstile checkbox in front of a browser. `gotoAndPass` waits the
 * interstitial out and presses the checkbox if it is asked to.
 *
 * The assertion is deliberately on the page behind it, not on the clearance
 * cookie: `cf_clearance` is issued the moment the widget is satisfied, and a
 * run that collects a token and still sees the interstitial has not solved
 * anything. The marker text is what proves we are through.
 */
async function interstitial(
  name: string,
  path: string,
  store: Store
): Promise<Outcome> {
  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  try {
    const page = await stack.sessions[0].context.newPage();
    const outcome = await gotoAndPass(page, `${BASE}${path}`, { timeout: 60_000 });

    // The success page is rendered after the challenge navigates, so read it
    // once the heading is actually there rather than straight after the pass.
    const marker = page.locator("text=/bypassed the .* challenge/i").first();
    const shown = await marker
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => marker.innerText())
      .catch(() => "");

    const title = await page.title().catch(() => "");
    await store.save([
      {
        challenge: name,
        title,
        marker: shown.trim() || undefined,
        challenged: outcome.challenged,
        clicks: outcome.clicks,
        waited_ms: outcome.waitedMs,
        clearance: outcome.clearance ? "issued" : "none",
      },
    ]);

    const passed = outcome.passed && /bypassed/i.test(shown);
    return {
      name,
      passed,
      detail: passed
        ? `${shown.trim().slice(0, 46)} (${outcome.clicks} click${outcome.clicks === 1 ? "" : "s"}, ${(outcome.waitedMs / 1000).toFixed(1)}s${outcome.clearance ? ", cf_clearance issued" : ""})`
        : `${outcome.detail}${shown ? "" : ", no marker on the page"}`,
    };
  } finally {
    await stack.close();
  }
}

(async () => {
  console.log(ROUTE ? `route: ${ROUTE.label}\n` : "route: direct\n");
  const store = sqliteStore({ path: "challenges.db", table: "products" });

  const outcomes: Outcome[] = [];
  const steps: Array<() => Promise<Outcome>> = [
    () => javascriptRendering(store),
    () => buttonClick(store),
    () => infiniteScrolling(store),
    () => pagination(store),
    () => tableParsing(store),
    () => login(),
    () => ecommerce(store),
    () => interstitial("antibot-challenge", "/antibot-challenge", store),
    () => interstitial("cloudflare-challenge", "/cloudflare-challenge", store),
  ];

  for (const step of steps) {
    try {
      outcomes.push(await step());
    } catch (error) {
      outcomes.push({
        name: "errored",
        passed: false,
        detail: (error as Error).message.split("\n")[0].slice(0, 70),
      });
    }
    const last = outcomes[outcomes.length - 1];
    console.log(`${last.passed ? "PASS" : "FAIL"}  ${last.name.padEnd(22)} ${last.detail}`);
  }

  await store.close();
  const passed = outcomes.filter((o) => o.passed).length;
  console.log(`\n${rule}\n${passed}/${outcomes.length} challenges passed — written to challenges.db`);
})();
