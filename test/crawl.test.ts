/**
 * The queue and limiter are tested directly; the crawl itself runs against a
 * local site so the integration test needs no network and no goodwill from
 * anyone's server.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { crawl, pageRange, WorkQueue, HostLimiter } from "../crawl";
import { memoryStore } from "../storage";

const MINUTE = 60_000;

describe("pageRange", () => {
  test("builds an inclusive range", () => {
    assert.deepEqual(pageRange((n) => `/p/${n}`, 1, 3), ["/p/1", "/p/2", "/p/3"]);
  });
  test("a single page is a range of one", () => {
    assert.deepEqual(pageRange((n) => `/p/${n}`, 5, 5), ["/p/5"]);
  });
});

describe("WorkQueue", () => {
  test("claims each url exactly once", () => {
    const queue = new WorkQueue(["a", "b", "c"]);
    const claimed = [queue.claim(), queue.claim(), queue.claim(), queue.claim()];
    assert.deepEqual(claimed, ["a", "b", "c", undefined]);
  });

  test("ignores urls it has already seen", () => {
    const queue = new WorkQueue(["a"]);
    assert.equal(queue.add(["a", "b", "b", "c"]), 2);
    assert.equal(queue.size, 3);
  });

  test("stays active while work is in flight", () => {
    // The subtle case: the pending list is empty but a browser still holds a
    // url and may enqueue more from it. Stopping here truncates the crawl.
    const queue = new WorkQueue(["a"]);
    queue.claim();
    assert.equal(queue.size, 0);
    assert.equal(queue.active, true);
    queue.release();
    assert.equal(queue.active, false);
  });

  test("requeues a failure until its attempts run out", () => {
    const queue = new WorkQueue(["a"]);
    queue.claim();
    assert.equal(queue.retry("a", 2), true);
    assert.equal(queue.retry("a", 2), true);
    assert.equal(queue.retry("a", 2), false, "third failure exceeds a limit of 2");
  });

  test("a requeued url is claimable again", () => {
    const queue = new WorkQueue(["a"]);
    queue.claim();
    queue.retry("a", 2);
    assert.equal(queue.claim(), "a");
  });

  test("attempt numbers count from one", () => {
    const queue = new WorkQueue(["a"]);
    assert.equal(queue.attemptsFor("a"), 1);
    queue.retry("a", 3);
    assert.equal(queue.attemptsFor("a"), 2);
  });

  test("discovered urls join the same queue", () => {
    const queue = new WorkQueue(["a"]);
    queue.claim();
    queue.add(["b", "c"]);
    assert.equal(queue.size, 2);
  });
});

describe("HostLimiter", () => {
  test("spaces out requests to one host", async () => {
    const limiter = new HostLimiter(100);
    const started = Date.now();
    await Promise.all([
      limiter.wait("https://a.example/1"),
      limiter.wait("https://a.example/2"),
      limiter.wait("https://a.example/3"),
    ]);
    // Slots are reserved synchronously, so three concurrent callers queue
    // rather than all reading the same stale timestamp and firing together.
    assert.ok(Date.now() - started >= 190, `only waited ${Date.now() - started}ms`);
  });

  test("different hosts do not block each other", async () => {
    const limiter = new HostLimiter(300);
    const started = Date.now();
    await Promise.all([
      limiter.wait("https://a.example/"),
      limiter.wait("https://b.example/"),
      limiter.wait("https://c.example/"),
    ]);
    assert.ok(Date.now() - started < 150, `waited ${Date.now() - started}ms`);
  });

  test("a malformed url does not stall the crawl", async () => {
    await new HostLimiter(1000).wait("not a url");
  });
});

/** A tiny paginated site: 12 pages, 5 items each, with next-page links. */
function testSite() {
  const server = http.createServer((req, res) => {
    const page = Number(new URL(req.url!, "http://x").searchParams.get("page") ?? 1);
    if (page > 12) {
      res.writeHead(404).end("no such page");
      return;
    }
    const items = Array.from({ length: 5 }, (_, i) => {
      const id = (page - 1) * 5 + i + 1;
      return `<li class="item" data-id="${id}">Item ${id}</li>`;
    }).join("");
    const next = page < 12 ? `<a class="next" href="/?page=${page + 1}">next</a>` : "";
    res.writeHead(200, { "content-type": "text/html" }).end(`<ul>${items}</ul>${next}`);
  });

  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      })
    )
  );
}

/** The same site, but failing a share of requests at random. */
function flakySite(failureRate: number) {
  const server = http.createServer((req, res) => {
    if (Math.random() < failureRate) {
      res.writeHead(500).end("boom");
      return;
    }
    const page = Number(new URL(req.url!, "http://x").searchParams.get("page") ?? 1);
    const items = Array.from({ length: 5 }, (_, i) => {
      const id = (page - 1) * 5 + i + 1;
      return `<li class="item" data-id="${id}">Item ${id}</li>`;
    }).join("");
    res.writeHead(200, { "content-type": "text/html" }).end(`<ul>${items}</ul>`);
  });

  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
      })
    )
  );
}

const readItems = (page: any) =>
  page.$$eval(".item", (nodes: any[]) =>
    nodes.map((n) => ({ id: Number(n.dataset.id), text: n.textContent }))
  );

describe("crawl", { timeout: 5 * MINUTE }, () => {
  test("splits known pages across browsers and merges one coherent result", async () => {
    const site = await testSite();
    try {
      const store = memoryStore();
      const result = await crawl({
        start: pageRange((n) => `${site.url}/?page=${n}`, 1, 12),
        browsers: 3,
        engine: "chromium",
        perHostDelayMs: 0,
        key: (row) => String(row.id),
        store,
        extract: ({ page }) => readItems(page),
      });

      assert.equal(result.stats.visited, 12);
      assert.equal(result.stats.failed, 0);
      // 12 pages × 5 items, each exactly once, however the work was divided.
      assert.equal(result.rows.length, 60);
      const ids = result.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
      assert.deepEqual(ids, Array.from({ length: 60 }, (_, i) => i + 1));
      assert.equal(store.rows.length, 60);

      // Every browser did some of it, and no page was done twice.
      const done = Object.values(result.stats.byProfile);
      assert.equal(done.reduce((a, b) => a + b, 0), 12);
      assert.equal(Object.keys(result.stats.byProfile).length, 3, "all three browsers worked");
    } finally {
      site.close();
    }
  });

  test("follows links discovered mid-crawl", async () => {
    const site = await testSite();
    try {
      const result = await crawl({
        start: [`${site.url}/?page=1`],
        browsers: 2,
        engine: "chromium",
        perHostDelayMs: 0,
        key: (row) => String(row.id),
        extract: async ({ page, enqueue }) => {
          const next = await page.$$eval("a.next", (as: any[]) => as.map((a) => a.href));
          enqueue(next);
          return readItems(page);
        },
      });

      // Started from one url; the other eleven were discovered.
      assert.equal(result.stats.visited, 12);
      assert.equal(result.rows.length, 60);
    } finally {
      site.close();
    }
  });

  test("duplicate rows across overlapping pages are dropped", async () => {
    const site = await testSite();
    try {
      const result = await crawl({
        start: [`${site.url}/?page=1`, `${site.url}/?page=1&again`, `${site.url}/?page=2`],
        browsers: 2,
        engine: "chromium",
        perHostDelayMs: 0,
        key: (row) => String(row.id),
        extract: ({ page }) => readItems(page),
      });

      assert.equal(result.stats.visited, 3);
      assert.equal(result.rows.length, 10, "page 1 was fetched twice, its items counted once");
      assert.equal(result.stats.duplicatesDropped, 5);
    } finally {
      site.close();
    }
  });

  test("a failing url is retried, then reported without sinking the run", async () => {
    const site = await testSite();
    try {
      const result = await crawl({
        start: [`${site.url}/?page=1`, `${site.url}/?page=99`, `${site.url}/?page=2`],
        browsers: 2,
        engine: "chromium",
        perHostDelayMs: 0,
        retries: 1,
        key: (row) => String(row.id),
        extract: async ({ page }) => {
          const items = await readItems(page);
          if (items.length === 0) throw new Error("empty page");
          return items;
        },
      });

      assert.equal(result.stats.visited, 2);
      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0].url, /page=99/);
      assert.equal(result.failures[0].attempts, 2, "one attempt plus one retry");
      assert.equal(result.rows.length, 10, "the good pages still landed");
    } finally {
      site.close();
    }
  });

  test("maxPages stops the crawl early", async () => {
    const site = await testSite();
    try {
      const result = await crawl({
        start: pageRange((n) => `${site.url}/?page=${n}`, 1, 12),
        browsers: 2,
        engine: "chromium",
        perHostDelayMs: 0,
        maxPages: 4,
        extract: ({ page }) => readItems(page),
      });
      assert.ok(result.stats.visited >= 4 && result.stats.visited <= 6, `visited ${result.stats.visited}`);
      assert.ok(result.stats.visited < 12);
    } finally {
      site.close();
    }
  });

  test("an empty start list is rejected", async () => {
    await assert.rejects(
      () => crawl({ start: [], extract: async () => [] }),
      /at least one start URL/
    );
  });
});

describe("resilience", { timeout: 5 * MINUTE }, () => {
  test("a browser dying mid-crawl costs nothing", async () => {
    // Before this was handled, one crash lost 170 of 200 items: the dead
    // worker kept claiming urls and failing them against a closed page,
    // spending every remaining url's retries in seconds.
    const site = await testSite();
    let killed = false;
    try {
      const result = await crawl({
        start: pageRange((n) => `${site.url}/?page=${n}`, 1, 12),
        browsers: 3,
        engine: "chromium",
        perHostDelayMs: 0,
        key: (row) => String(row.id),
        extract: async ({ page }) => {
          if (!killed) {
            killed = true;
            setTimeout(() => page.context().browser()?.close().catch(() => {}), 30);
          }
          return readItems(page);
        },
      });

      assert.equal(result.stats.visited, 12, "every page still visited");
      assert.equal(result.rows.length, 60, "every item still collected");
      assert.equal(result.stats.failed, 0);
      assert.ok(result.stats.relaunches >= 1, "the dead browser was replaced");
    } finally {
      site.close();
    }
  });

  test("a url held by a dead browser keeps its retries", () => {
    // returnUnused, not retry: the url did nothing wrong, and charging it an
    // attempt would eventually discard good work after enough crashes.
    const queue = new WorkQueue(["a", "b"]);
    queue.claim();
    queue.returnUnused("a");
    assert.equal(queue.attemptsFor("a"), 1, "still on its first attempt");
    assert.equal(queue.claim(), "a", "and goes back to the front of the queue");
  });

  test("exact-once coverage survives contention and transient failures", async () => {
    // 40 pages, 6 browsers, one in five requests failing at random.
    const site = await flakySite(0.2);
    try {
      const result = await crawl({
        start: pageRange((n) => `${site.url}/?page=${n}`, 1, 40),
        browsers: 6,
        engine: "chromium",
        perHostDelayMs: 0,
        retries: 4,
        key: (row) => String(row.id),
        extract: async ({ page }) => {
          const items = await readItems(page);
          if (items.length === 0) throw new Error("empty response");
          return items;
        },
      });

      const ids = result.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
      assert.deepEqual(ids, Array.from({ length: 200 }, (_, i) => i + 1));
      assert.equal(new Set(ids).size, ids.length, "no item collected twice");
      assert.equal(Object.keys(result.stats.byProfile).length, 6, "every browser contributed");
    } finally {
      site.close();
    }
  });
});
