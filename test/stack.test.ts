import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planStack, openStack } from "../stack";
import { ConfigError } from "../errors";

const MINUTE = 60_000;

describe("planStack", () => {
  test("count and kind are honoured", () => {
    const plan = planStack({ kind: "mobile", count: 4 });
    assert.equal(plan.length, 4);
    assert.ok(plan.every((p) => p.formFactor === "mobile"));
  });

  test("mixed draws from every form factor as it grows", () => {
    const forms = new Set(planStack({ kind: "mixed", count: 20 }).map((p) => p.formFactor));
    assert.equal(forms.size, 3);
  });

  test("handheld means phones and tablets", () => {
    const plan = planStack({ kind: "handheld", count: 12 });
    assert.ok(plan.every((p) => p.formFactor === "mobile" || p.formFactor === "tablet"));
  });

  test("engine narrows the pool", () => {
    const plan = planStack({ kind: "mixed", count: 6, engine: "chromium" });
    assert.ok(plan.every((p) => p.engine === "chromium"));
  });

  test("no duplicate fingerprints within a stack", () => {
    const plan = planStack({ kind: "mixed", count: 30 });
    assert.equal(new Set(plan.map((p) => p.id)).size, 30);
  });

  test("overflowing the pool throws rather than quietly repeating", () => {
    // Duplicates share a fingerprint, which is the correlation a stack exists
    // to avoid - so it has to be asked for explicitly.
    assert.throws(() => planStack({ kind: "mobile", count: 15 }), /only 10 distinct mobile profiles/);
  });

  test("allowDuplicates opts into reuse", () => {
    const plan = planStack({ kind: "mobile", count: 15, allowDuplicates: true });
    assert.equal(plan.length, 15);
  });

  test("an impossible combination throws", () => {
    assert.throws(() => planStack({ kind: "mobile", engine: "firefox", count: 1 }), /No profiles match/);
  });
});

describe("openStack", { timeout: 5 * MINUTE }, () => {
  test("opens the browsers, navigates, and closes cleanly", async () => {
    const stack = await openStack({
      kind: "mixed",
      count: 3,
      engine: "chromium",
      url: "https://example.com",
    });
    try {
      assert.equal(stack.sessions.length, 3);
      assert.equal(new Set(stack.sessions.map((s) => s.profile.id)).size, 3);
      for (const session of stack.sessions) {
        assert.ok(session.page, "a url was given, so each session has a page");
        assert.equal(await session.page!.title(), "Example Domain");
      }
    } finally {
      await stack.close();
    }
  });

  test("openPages fills in pages for a stack opened without a url", async () => {
    const stack = await openStack({ kind: "desktop", count: 2, engine: "chromium" });
    try {
      assert.ok(stack.sessions.every((s) => !s.page));
      const pages = await stack.openPages("https://example.com");
      assert.equal(pages.length, 2);
      assert.equal(await pages[0].title(), "Example Domain");
    } finally {
      await stack.close();
    }
  });
});

describe("typed errors", () => {
  test("asking for more browsers than profiles is a ConfigError, message unchanged", () => {
    assert.throws(() => planStack({ count: 999 }), ConfigError);
    assert.throws(() => planStack({ count: 999 }), /distinct/);
  });
});
