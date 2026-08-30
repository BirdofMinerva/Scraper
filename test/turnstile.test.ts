/**
 * Turnstile handling, against a stand-in interstitial served locally.
 *
 * The real thing cannot be a test: it is rate limited, it is someone else's
 * service, and a red run would mean "Cloudflare changed something" as often as
 * "we broke something". What is ours, and what these assert, is the mechanics
 * around the click - finding a widget inside a closed shadow root, telling an
 * interactive widget from an invisible one, and arriving with a pointer that
 * moved.
 *
 * The stand-in copies the parts of the real page the code actually depends on:
 * `window._cf_chl_opt` set inline, and the widget in a **closed** shadow root
 * on a `challenges.cloudflare.com` iframe. That last detail is the whole
 * reason `widgetBox` exists.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ensureDisplay } from "../browsers";
import { passChallenge, challengeState, widgetBox, isChallenged } from "../turnstile";

const MINUTE = 60_000;

/**
 * The widget: a checkbox that reports the pointer travel that reached it.
 *
 * Counting moves is the point. A press with no movement in front of it is the
 * signal the real widget is reading, so a change that made `clickAt` teleport
 * would still solve this page - unless the page says how it was clicked.
 */
const WIDGET = `<!doctype html><body style="margin:0;font:12px monospace">
<div id="cb" style="position:absolute;left:20px;top:20px;width:26px;height:26px;border:1px solid #444"></div>
<script>
  let moves = 0;
  addEventListener("mousemove", () => moves++);
  document.getElementById("cb").addEventListener("click", () => {
    parent.postMessage({ solved: true, moves }, "*");
  });
</script>`;

/** The interstitial, as far as anything in turnstile.ts can tell. */
const interstitialPage = (size: { width: number; height: number }) => `<!doctype html>
<title>Just a moment...</title>
<body>
<h2>Performing security verification</h2>
<div id="widget"></div>
<script>
  window._cf_chl_opt = { cType: "managed", cRay: "test" };
  window.__moves = null;
  const root = document.getElementById("widget").attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.src = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget";
  frame.style.cssText = "width:${size.width}px;height:${size.height}px;border:0";
  root.appendChild(frame);
  addEventListener("message", (event) => {
    if (!event.data || !event.data.solved) return;
    window.__moves = event.data.moves;
    delete window._cf_chl_opt;          // what a real pass amounts to, from here
    document.title = "Challenge passed";
    document.body.innerHTML = "<h1>through</h1>";
  });
</script>`;

let browser: Browser;
let context: BrowserContext;
let server: http.Server;
let origin: string;

before(async () => {
  ensureDisplay();

  server = http.createServer((req, res) => {
    const size = req.url === "/invisible" ? { width: 2, height: 2 } : { width: 300, height: 65 };
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/clear" ? "<title>plain</title><h1>nothing here</h1>" : interstitialPage(size));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  browser = await chromium.launch({ headless: false, channel: "chrome" });
  context = await browser.newContext();
  // Serve the widget from the host the code looks for, without leaving the box.
  await context.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: WIDGET })
  );
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const open = async (path: string): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  if (path !== "/clear") {
    // Wait for the widget's frame, not just the host element: the box cannot
    // be measured until the iframe has attached.
    await page
      .waitForFunction(() => document.querySelector("#widget") !== null, undefined, { timeout: 5000 })
      .catch(() => {});
  }
  return page;
};

describe("finding the widget", { timeout: MINUTE }, () => {
  test("no selector reaches it, and widgetBox still does", async () => {
    const page = await open("/");
    // The regression this guards: the widget lives in a closed shadow root, so
    // the obvious lookup finds nothing while the thing is plainly on screen.
    assert.equal(await page.$("iframe[src*='challenges.cloudflare.com']"), null);

    const box = await widgetBox(page);
    assert.ok(box, "widgetBox found no widget");
    assert.equal(Math.round(box!.width), 300);
    assert.equal(Math.round(box!.height), 65);
    await page.close();
  });

  test("a page with no challenge reads clear", async () => {
    const page = await open("/clear");
    assert.equal(await isChallenged(page), false);
    assert.equal(await challengeState(page), "clear");
    assert.equal(await widgetBox(page), null);
    await page.close();
  });

  test("an invisible widget is waiting, not interactive", async () => {
    // Turnstile's invisible variant renders a 2px iframe and resolves itself.
    // Clicking it is both pointless and a tell.
    const page = await open("/invisible");
    assert.equal(await challengeState(page), "waiting");
    await page.close();
  });
});

describe("passing it", { timeout: 2 * MINUTE }, () => {
  test("the checkbox is pressed and the pass is reported", async () => {
    const page = await open("/");
    assert.equal(await challengeState(page), "interactive");

    const outcome = await passChallenge(page, { timeout: 30_000 });

    assert.equal(outcome.passed, true, outcome.detail);
    assert.equal(outcome.challenged, true);
    assert.equal(outcome.clicks, 1, "one press should have been enough");
    assert.equal(await challengeState(page), "clear");
    await page.close();
  });

  test("the pointer travelled to the checkbox", async () => {
    const page = await open("/");
    await passChallenge(page, { timeout: 30_000 });

    const moves = await page.evaluate(() => (window as any).__moves);
    assert.ok(moves >= 5, `only ${moves} mousemove events reached the widget before the press`);
    await page.close();
  });

  test("an unchallenged page returns immediately, having pressed nothing", async () => {
    const page = await open("/clear");
    const started = Date.now();
    const outcome = await passChallenge(page, { timeout: 30_000 });

    assert.equal(outcome.passed, true);
    // `challenged: false` is how a caller tells "solved it" from "there was
    // nothing to solve" - a run that reports a pass on every page is useless.
    assert.equal(outcome.challenged, false);
    assert.equal(outcome.clicks, 0);
    assert.ok(Date.now() - started < 5000, "waited on a page with no challenge");
    await page.close();
  });

  test("a widget that never resolves fails within its budget", async () => {
    const page = await open("/invisible");
    const outcome = await passChallenge(page, { timeout: 4000 });

    assert.equal(outcome.passed, false);
    assert.equal(outcome.clicks, 0, "pressed an invisible widget");
    assert.match(outcome.detail, /still waiting/);
    assert.ok(outcome.waitedMs >= 4000 && outcome.waitedMs < 12_000);
    await page.close();
  });
});
