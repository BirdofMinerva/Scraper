/**
 * The dashboard server: its HTTP surface, and one real run driven through it.
 *
 * The run is against a page served from this process, so what is being tested
 * is the plumbing - config in, browsers out, log lines and rows back over the
 * event stream - rather than any site's markup.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../server";
import { ensureDisplay } from "../browsers";
import { DEFAULT_MATCH_STATUS, DEFAULT_THREADS, DEFAULT_RATE, DEFAULT_INPUT_NUM } from "../ffuf";

const MINUTE = 60_000;

let dashboard: http.Server;
let base: string;
let site: http.Server;
let siteOrigin: string;

/** Two pages of three products, linked, so following and dedupe both apply. */
const PAGE = (n: number) => `<!doctype html><title>Page ${n}</title>
  <ul>
    ${[1, 2, 3]
      .map(
        (i) =>
          `<li class="item"><span class="name">Item ${n}.${i}</span>` +
          `<span class="price">$${n}${i}.00</span><img src="/img/${n}-${i}.png"></li>`
      )
      .join("")}
  </ul>
  <nav><a href="/page/2">next</a></nav>`;

before(async () => {
  ensureDisplay();

  site = http.createServer((req, res) => {
    const page = Number(/\/page\/(\d+)/.exec(req.url ?? "")?.[1] ?? 1);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE(page));
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  dashboard = createServer();
  await new Promise<void>((r) => dashboard.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(dashboard.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => dashboard?.close(r));
  await new Promise((r) => site?.close(r));
});

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Read the event stream to its "done", returning everything it said. */
async function watch(id: string, timeout = 3 * MINUTE) {
  const response = await fetch(`${base}/api/runs/${id}/events`, {
    signal: AbortSignal.timeout(timeout),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      events.push({ event, data: JSON.parse(data) });
      if (event === "done") {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}

describe("the HTTP surface", { timeout: MINUTE }, () => {
  test("the dashboard page is served", async () => {
    const response = await fetch(base + "/");
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<title>Scraper<\/title>/);
    // The page builds its dropdowns from /api/options; a second copy of the
    // catalogue in the HTML is a copy that goes stale.
    assert.match(html, /api\/options/);
  });

  test("options carry the profiles and the login presets", async () => {
    const options = await (await fetch(base + "/api/options")).json();
    assert.equal(options.profiles.length, 30);
    assert.ok(options.presets.some((p: any) => p.name === "saucedemo"));
    assert.deepEqual(options.kinds[0], "mixed");
  });

  test("options carry the ffuf engine defaults, so the enumerate form need not hardcode them", async () => {
    // Single source of truth: the served defaults ARE ffuf.ts's exported consts,
    // so the dashboard placeholders cannot drift from the engine.
    const options = await (await fetch(base + "/api/options")).json();
    assert.equal(options.ffufDefaults.matchStatus, DEFAULT_MATCH_STATUS);
    assert.equal(options.ffufDefaults.threads, DEFAULT_THREADS);
    assert.equal(options.ffufDefaults.rate, DEFAULT_RATE);
    assert.equal(options.ffufDefaults.inputNum, DEFAULT_INPUT_NUM);
  });

  test("a bad config is refused with a message a person can act on", async () => {
    const response = await post("/api/runs", { mode: "scrape", rowSelector: "", fields: [] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /at least one URL/);
  });

  test("an unknown mode is refused", async () => {
    const response = await post("/api/runs", { mode: "mischief" });
    assert.equal(response.status, 400);
  });

  test("asking for a run that does not exist is a 404, not a crash", async () => {
    assert.equal((await fetch(base + "/api/runs/nope")).status, 404);
    assert.equal((await fetch(base + "/api/runs/nope/events")).status, 404);
  });

  test("stored accounts come back without their passwords", async () => {
    // The book is on disk beside the server; whatever is in it, the passwords
    // are not something the browser needs.
    const data = await (await fetch(base + "/api/accounts?path=does-not-exist.db")).json();
    assert.deepEqual(data.accounts, []);
  });
});

describe("a run, end to end", { timeout: 5 * MINUTE }, () => {
  test("a scrape streams progress and comes back with rows", async () => {
    const response = await post("/api/runs", {
      mode: "scrape",
      urls: [`${siteOrigin}/page/1`],
      follow: "nav a",
      rowSelector: "li.item",
      fields: [
        { name: "name", selector: ".name" },
        { name: "price", selector: ".price" },
        { name: "image", selector: "img", attribute: "src" },
      ],
      key: "name",
      browsers: 1,
      kind: "desktop",
      engine: "chromium",
      perHostDelayMs: 0,
      challenge: false,
    });
    assert.equal(response.status, 201);
    const { id } = await response.json();

    const events = await watch(id);
    const done = events.find((e) => e.event === "done")!;
    assert.equal(done.data.status, "done");

    // Two pages: the second came from following the link, not from the config.
    assert.match(done.data.summary, /rows from 2 pages/);
    assert.equal(done.data.stats.rows, 6);
    assert.equal(done.data.stats.failed, 0);

    const first = done.data.rows[0];
    assert.match(first.name, /^Item \d\.\d$/);
    assert.match(first.price, /^\$\d+\.00$/);
    // An attribute field, not the element's text.
    assert.match(first.image, /\/img\/\d-\d\.png$/);

    // The log is what the terminal panel shows; it has to carry the per-page
    // lines, not just the summary.
    const lines = events.filter((e) => e.event === "log").map((e) => e.data.message);
    assert.ok(lines.some((l: string) => /3 rows/.test(l)), lines.join("\n"));
    assert.ok(events.some((e) => e.event === "progress"));
  });

  test("a finished run replays in full to a second viewer", async () => {
    // What a browser reloading mid-run gets: the whole log, not an empty panel.
    const runs = await (await fetch(base + "/api/runs")).json();
    const events = await watch(runs[0].id, MINUTE);
    const replay = events.find((e) => e.event === "replay")!;

    assert.ok(replay.data.log.length > 3);
    assert.equal(replay.data.status, "done");
    assert.ok(events.some((e) => e.event === "done"));
  });

  test("the history lists what has run", async () => {
    const runs = await (await fetch(base + "/api/runs")).json();
    assert.ok(runs.length >= 1);
    assert.equal(runs[0].mode, "scrape");
    assert.ok(runs[0].summary);
    // The config is not echoed back into the listing: a bot run's config holds
    // a credential list, and the history is the one thing rendered for every
    // run whether or not it is the one being looked at.
    assert.equal((runs[0] as any).config, undefined);
  });

  test("screenshots are served, and only from inside the run directory", async () => {
    const runs = await (await fetch(base + "/api/runs")).json();
    const id = runs[0].id;

    // Nothing was screenshotted by that scrape, so the interesting half here
    // is what the endpoint refuses. The traversal cases are the reason the
    // name is taken apart and rebuilt rather than joined.
    for (const name of ["../../package.json", "..%2f..%2fpackage.json", "nope.png", "shot.txt"]) {
      const response = await fetch(`${base}/api/runs/${id}/shots/${name}`);
      assert.equal(response.status, 404, `${name} was not refused`);
    }
  });

  test("stopping a run is reported, and a finished one cannot be stopped", async () => {
    const runs = await (await fetch(base + "/api/runs")).json();
    const stopped = await (await post(`/api/runs/${runs[0].id}/stop`, {})).json();
    assert.equal(stopped.stopped, false);
  });
});
