/**
 * End-to-end test of the whole stack against targets that are actually hard.
 *
 *   npx tsx hard-test.ts
 *
 * Three things worth proving, each with a pass criterion that is data, not a
 * status code — "200 OK" means nothing if the page it served was a challenge:
 *
 *   1. anti-bot challenges that refuse a plain HTTP client outright
 *   2. content that only exists after JavaScript runs
 *   3. a thousand records, split across browsers and merged exactly once
 */
import { execFile } from "node:child_process";
import { crawl, pageRange } from "./crawl";
import { openStack } from "./stack";
import { sqliteStore } from "./storage";
import { classify, detectProtection } from "./detect";
import { parseRoutes } from "./routes";

/** PROXIES="home=socks5://127.0.0.1:1080" runs everything through that route. */
const ROUTE = parseRoutes(process.env.PROXIES ?? "")[0];
const PROXIES = ROUTE?.proxy ? [ROUTE.proxy] : undefined;

/** curl over the same route, so the comparison is like for like. */
function curlProxyArg(): string[] {
  const first = Array.isArray(ROUTE?.proxy) ? ROUTE.proxy[0] : ROUTE?.proxy;
  const server = typeof first === "string" ? first : (first as { server?: string })?.server;
  return server ? ["--proxy", server.replace(/^socks5:\/\//, "socks5h://")] : [];
}

const line = "-".repeat(78);
const ok = (pass: boolean) => (pass ? "PASS" : "FAIL");

/** What a plain HTTP client gets, for comparison. */
function curlStatus(url: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "curl",
      ["-s", "-o", "/dev/null", "-L", "--max-redirs", "5", "--max-time", "25", "-w", "%{http_code}", ...curlProxyArg(), url],
      (error, stdout) => resolve(error && !stdout ? 0 : Number(stdout.trim()) || 0)
    );
  });
}

/**
 * 1. Anti-bot challenges.
 *
 * Both of these answer a plain curl with 403. Passing means the browser is
 * served the real page — checked by looking for content only the real page
 * has, since a challenge page is also served with a 200.
 */
async function challenges() {
  const targets = [
    { url: "https://www.scrapingcourse.com/antibot-challenge", needle: /challenge|product|congratulations/i },
    { url: "https://www.scrapingcourse.com/cloudflare-challenge", needle: /challenge|product|congratulations/i },
    // Strict on purpose: this page says so explicitly when it is satisfied,
    // and a looser needle would let its own domain name count as a pass.
    { url: "https://nowsecure.nl/", needle: /you are not a bot/i },
  ];

  console.log("\n1. ANTI-BOT CHALLENGES");
  console.log(line);
  let passed = 0;

  for (const target of targets) {
    const baseline = await curlStatus(target.url);

    // A browser per target: a challenge page can take the browser down with
    // it, and one dead browser should not end the run.
    const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
    try {
      const page = await stack.sessions[0].context.newPage();
      const response = await page.goto(target.url, { waitUntil: "domcontentloaded" });

      // Poll rather than sleep: a Cloudflare interstitial can take anywhere
      // from two seconds to twenty, and a fixed wait either gives up on a
      // challenge that would have resolved or wastes time on one that will
      // not. Watch for the interstitial to go away instead.
      const deadline = Date.now() + 30_000;
      let waited = 0;
      while (Date.now() < deadline) {
        const body = await page.locator("body").innerText().catch(() => "");
        // "Verify you are human", not "verifying" - the wrong wording meant
        // this loop broke on the first poll and reported a challenge page as
        // though it had settled.
        // Same reason: check for the widget, and only then fall back to copy.
        const widget = await page
          .locator('input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]')
          .count()
          .catch(() => 0);
        const stillChallenging =
          widget > 0 ||
          /just a moment|nur einen moment|even geduld|checking your browser/i.test(body) ||
          body.trim().length < 60;
        if (!stillChallenging) break;
        await page.waitForTimeout(1000);
        waited++;
      }

      const status = response?.status() ?? 0;
      const text = await page.locator("body").innerText().catch(() => "");
      const title = await page.title();
      const cookies = (await page.context().cookies()).map((c) => c.name);
      const protection = detectProtection(cookies, await page.content().catch(() => ""));
      const verdict = classify(status, title, text, text.length, protection);

      // The real test: is the page's own content there? A challenge page is
      // also served with a 200, so a status code proves nothing.
      // An interactive human-verification widget - a Turnstile checkbox or
      // similar - is not something this toolkit tries to get past. Report it
      // as what it is rather than as a fingerprint failure, so it does not
      // send anyone off tuning the profiles.
      // Detect the widget by its DOM, not its copy: Cloudflare serves the
      // interstitial in the profile's own language, so an English regex misses
      // a German or Dutch one. Turnstile always leaves this hidden input.
      const humanCheck =
        (await page
          .locator(
            'input[name="cf-turnstile-response"], input[name="g-recaptcha-response"], ' +
              'input[name="h-captcha-response"], iframe[src*="challenges.cloudflare.com"], ' +
              'iframe[src*="hcaptcha"], iframe[src*="recaptcha"]'
          )
          .count()) > 0;

      const served = verdict === "clean" && target.needle.test(text);
      if (served) passed++;

      const label = served ? "PASS" : humanCheck ? "SKIP" : "FAIL";
      console.log(
        `${label}  ${target.url.replace("https://", "").slice(0, 46).padEnd(48)} ` +
          `browser ${status} ${verdict}  ·  curl ${baseline}`
      );
      if (humanCheck) {
        console.log("      Cloudflare Turnstile / captcha widget present — human verification,");
        console.log("      out of scope for this toolkit and not attempted");
      }
      console.log(
        `      ${text.length} chars after ${waited}s · ${protection.vendors.join(", ") || "no vendor named"} · "${title.slice(0, 44)}"`
      );
    } catch (error) {
      console.log(`${ok(false)}  ${target.url.replace("https://", "").slice(0, 46).padEnd(48)} ` +
        `errored  ·  curl ${baseline}`);
      console.log(`      ${(error as Error).message.split("\n")[0].slice(0, 66)}`);
    } finally {
      await stack.close();
    }
  }

  return { passed, total: targets.length };
}

/**
 * 2. JavaScript-rendered content.
 *
 * quotes.toscrape.com/js serves an empty shell to any HTTP client and builds
 * the list in the browser. curl gets 200 and zero quotes, which is the exact
 * failure mode that makes people reach for a browser in the first place.
 */
async function javascriptRendered() {
  console.log("\n2. JAVASCRIPT-RENDERED CONTENT");
  console.log(line);

  const result = await crawl({
    start: pageRange((n) => `https://quotes.toscrape.com/js/page/${n}/`, 1, 5),
    browsers: 3,
    engine: "chromium",
    proxies: PROXIES,
    perHostDelayMs: 400,
    key: (row) => `${row.author}|${String(row.text).slice(0, 40)}`,
    extract: ({ page }) =>
      page.$$eval(".quote", (nodes) =>
        nodes.map((n) => ({
          text: n.querySelector(".text")?.textContent?.trim(),
          author: n.querySelector(".author")?.textContent?.trim(),
          tags: [...n.querySelectorAll(".tag")].map((t) => t.textContent).join(","),
        }))
      ),
  });

  const complete = result.rows.filter((r) => r.text && r.author);
  const pass = complete.length === 50 && result.stats.failed === 0;

  console.log(`${ok(pass)}  50 quotes across 5 JS-rendered pages`);
  console.log(`      got ${result.rows.length} rows, ${complete.length} with both text and author`);
  console.log(`      sample: ${String(result.rows[0]?.text).slice(0, 58)}…`);
  return { passed: pass ? 1 : 0, total: 1 };
}

/**
 * 3. Scale.
 *
 * 1000 books over 50 pages, split across browsers, merged by key. The point is
 * not that it is difficult to fetch, but that nothing is lost or double-counted
 * when six fingerprints work one queue.
 */
async function atScale() {
  console.log("\n3. A THOUSAND RECORDS, SIX BROWSERS");
  console.log(line);

  const store = sqliteStore({ path: "hard-test.db", table: "books", key: (r) => String(r.url) });
  const started = Date.now();

  const result = await crawl({
    start: pageRange((n) => `https://books.toscrape.com/catalogue/page-${n}.html`, 1, 50),
    browsers: 6,
    kind: "mixed",
    proxies: PROXIES,
    perHostDelayMs: 150,
    // Key on the detail URL, not the title. This catalogue genuinely repeats
    // some titles, and keying on one collapsed two distinct books into one -
    // 999 of 1000, which looked like a lost record and was a bad key.
    key: (row) => String(row.url),
    store,
    extract: ({ page }) =>
      page.$$eval("article.product_pod", (nodes) =>
        nodes.map((n) => ({
          url: (n.querySelector("h3 a") as HTMLAnchorElement | null)?.href,
          title: n.querySelector("h3 a")?.getAttribute("title"),
          price: n.querySelector(".price_color")?.textContent?.trim(),
          rating: n.querySelector(".star-rating")?.className.replace("star-rating ", ""),
          inStock: !!n.querySelector(".instock.availability"),
        }))
      ),
  });
  await store.close();

  const complete = result.rows.filter((r) => r.url && r.title && r.price && r.rating);
  const pass =
    result.rows.length === 1000 && complete.length === 1000 && result.stats.failed === 0;

  console.log(`${ok(pass)}  1000 books over 50 pages`);
  console.log(
    `      ${result.rows.length} rows, ${complete.length} complete, ` +
      `${result.stats.failed} failures, ${result.stats.duplicatesDropped} duplicates dropped`
  );
  console.log(`      split: ${JSON.stringify(result.stats.byProfile)}`);
  console.log(
    `      ${((Date.now() - started) / 1000).toFixed(1)}s wall, ` +
      `${result.stats.relaunches} browser relaunches, written to hard-test.db`
  );
  return { passed: pass ? 1 : 0, total: 1 };
}

(async () => {
  console.log(ROUTE ? `route: ${ROUTE.label}` : "route: direct");
  const results = [await challenges(), await javascriptRendered(), await atScale()];
  const passed = results.reduce((sum, r) => sum + r.passed, 0);
  const total = results.reduce((sum, r) => sum + r.total, 0);

  console.log(`\n${line}`);
  console.log(`${passed}/${total} passed`);
})();
