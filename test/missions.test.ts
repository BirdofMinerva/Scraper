/**
 * Browser-backed tests. Slower than the rest - each one launches real
 * browsers - so they carry generous timeouts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { defineMission, runMission, runEach, partition, randomPersona } from "../missions";
import { memoryStore } from "../storage";
import { getProfile } from "../browsers";

const MINUTE = 60_000;

describe("persona", () => {
  test("traits stay inside their ranges", () => {
    for (let i = 0; i < 200; i++) {
      const p = randomPersona();
      assert.ok(p.speed >= 0.65 && p.speed <= 1.6);
      assert.ok(p.keyDelay > 0);
      assert.ok(p.typoRate >= 0 && p.typoRate <= 0.06);
      assert.ok(p.scrollBackRate >= 0.05 && p.scrollBackRate <= 0.2);
    }
  });

  test("sessions differ from each other", () => {
    const speeds = new Set(Array.from({ length: 20 }, () => randomPersona().speed));
    assert.ok(speeds.size > 15, "personas should not collapse to one value");
  });
});

describe("partition", () => {
  test("splits values from failures", () => {
    const results = [
      { ok: true, value: 1 }, { ok: false, error: new Error("x") }, { ok: true, value: 2 },
    ] as any;
    const { values, failures } = partition(results);
    assert.deepEqual(values, [1, 2]);
    assert.equal(failures.length, 1);
  });
});

describe("running", { timeout: 5 * MINUTE }, () => {
  test("returns the mission's value with the profile that ran it", async () => {
    const results = await runMission(
      defineMission({ name: "t", url: "https://example.com", run: ({ page }) => page.title() }),
      { runs: 2, concurrency: 2 }
    );
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.ok(r.ok, r.ok ? "" : String((r as any).error));
      assert.equal((r as any).value, "Example Domain");
      assert.ok(r.profile.id);
      assert.ok(r.durationMs > 0);
    }
  });

  test("a failing mission comes back as a result, never a rejection", async () => {
    const results = await runMission(
      defineMission({ name: "fail", retries: 1, run: async () => { throw new Error("nope"); } }),
      { runs: 1 }
    );
    assert.equal(results[0].ok, false);
    assert.equal(results[0].attempts, 2);
    assert.match((results[0] as any).error.message, /nope/);
  });

  test("retries land on a different profile each time", async () => {
    const seen: string[] = [];
    await runMission(
      defineMission({
        name: "record", retries: 2,
        run: async ({ profile }) => { seen.push(profile.id); throw new Error("again"); },
      }),
      { runs: 1 }
    );
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3, `repeated a profile: ${seen}`);
  });

  test("timeout is enforced per attempt", async () => {
    const started = Date.now();
    const results = await runMission(
      defineMission({
        name: "slow", retries: 0, timeout: 5000,
        run: async ({ page }) => { await page.waitForTimeout(60_000); },
      }),
      { runs: 1 }
    );
    assert.equal(results[0].ok, false);
    assert.match((results[0] as any).error.message, /timed out/);
    assert.ok(Date.now() - started < 30_000);
  });

  test("fixed profiles are used in order", async () => {
    const profiles = [getProfile("desktop-chrome"), getProfile("mobile-pixel-7")];
    const results = await runMission(
      defineMission({ name: "who", run: async ({ profile }) => profile.id }),
      { runs: 2, concurrency: 1, profiles }
    );
    assert.deepEqual(partition(results).values, ["desktop-chrome", "mobile-pixel-7"]);
  });

  test("runEach attaches the target to each result", async () => {
    const targets = ["https://example.com", "https://example.org"];
    const results = await runEach(
      targets,
      (url) => defineMission({ name: "each", url, retries: 0, run: ({ page }) => page.title() }),
      { concurrency: 2 }
    );
    assert.deepEqual(results.map((r) => r.target), targets);
    assert.ok(results.every((r) => r.ok));
  });
});

describe("context", { timeout: 5 * MINUTE }, () => {
  test("the profile's identity reaches the page", async () => {
    const results = await runMission(
      defineMission({
        name: "identity",
        url: "https://example.com",
        profiles: { formFactor: "mobile", engine: "chromium" },
        run: async ({ page, profile }) => ({
          claimed: profile.fingerprint.platform,
          actual: await page.evaluate(() => navigator.platform),
          webdriver: await page.evaluate(() => (navigator as any).webdriver),
        }),
      }),
      { runs: 1 }
    );
    const value = (results[0] as any).value;
    assert.equal(value.actual, value.claimed);
    assert.equal(value.webdriver, false);
  });

  test("ctx.fetch uses the page's stack, and its cookies", async () => {
    const results = await runMission(
      defineMission({
        name: "fetch", url: "https://example.com", retries: 0,
        run: async ({ fetch }) => {
          const res = await fetch("https://example.com/");
          return { status: res.status, hasBody: res.body.includes("Example Domain") };
        },
      }),
      { runs: 1 }
    );
    assert.deepEqual((results[0] as any).value, { status: 200, hasBody: true });
  });
});

describe("storage integration", { timeout: 5 * MINUTE }, () => {
  test("returned values are stored with run metadata", async () => {
    const store = memoryStore();
    await runMission(
      defineMission({
        name: "store-me", url: "https://example.com", retries: 0,
        run: async ({ page }) => ({ title: await page.title() }),
      }),
      { runs: 1, store }
    );
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].title, "Example Domain");
    assert.equal(store.rows[0]._mission, "store-me");
    assert.ok(store.rows[0]._profile);
    assert.equal(store.rows[0]._target, "https://example.com");
  });

  test("ctx.save streams rows during the run", async () => {
    const store = memoryStore();
    await runMission(
      defineMission({
        name: "paged", url: "https://example.com", retries: 0,
        run: async ({ save }) => { await save([{ n: 1 }, { n: 2 }]); await save({ n: 3 }); },
      }),
      { runs: 1, store }
    );
    assert.deepEqual(store.rows.map((r) => r.n), [1, 2, 3]);
    assert.ok(store.rows.every((r) => r._mission === "paged"));
  });

  test("a failed run stores nothing", async () => {
    const store = memoryStore();
    await runMission(
      defineMission({ name: "nope", retries: 0, run: async () => { throw new Error("x"); } }),
      { runs: 1, store }
    );
    assert.equal(store.rows.length, 0);
  });
});

describe("profile filters", { timeout: 5 * MINUTE }, () => {
  test("runMission honours the mission's filter", async () => {
    const results = await runMission(
      defineMission({
        name: "filtered", profiles: { engine: "firefox" },
        run: async ({ profile }) => profile.engine,
      }),
      { runs: 2, concurrency: 2 }
    );
    assert.deepEqual(partition(results).values, ["firefox", "firefox"]);
  });

  test("runEach honours each built mission's filter", async () => {
    // Regression: runEach used the shared rotator and ignored mission.profiles,
    // so a chromium-only probe would launch webkit.
    const results = await runEach(
      ["a", "b"],
      () => defineMission({
        name: "filtered", profiles: { engine: "chromium", formFactor: "desktop" },
        run: async ({ profile }) => profile.engine,
      }),
      { concurrency: 2 }
    );
    assert.deepEqual(results.map((r) => (r as any).value), ["chromium", "chromium"]);
  });
});
