/**
 * Signing up and signing in, in a real browser, against the fixture site.
 *
 * Three things are being asserted here that no pure-logic test can reach: that
 * the forms are found and filled without a selector map, that "signed in"
 * means a session the server accepts rather than a URL, and that a challenge
 * appearing mid-flow is noticed and passed instead of being read as a refusal.
 *
 * The last of these is why the fixture can serve an interstitial on the
 * response to a submit: that is the shape that silently breaks a login flow,
 * because nothing on the page says anything about credentials.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ensureDisplay } from "../browsers";
import {
  signIn,
  signUp,
  isSignedIn,
  findField,
  formError,
  newIdentity,
  defineSite,
  accountBook,
  createAccounts,
  signInAll,
} from "../accounts";
import { startAuthSite, WIDGET_HTML, type AuthSite } from "./fixtures/auth-site";
import { runActions } from "../actions";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MINUTE = 60_000;
const KNOWN = { email: "known@example.com", password: "correct horse battery" };

let browser: Browser;
let context: BrowserContext;
let site: AuthSite;
let page: Page;

const specFor = (s: AuthSite) =>
  defineSite({
    name: "fixture",
    loginUrl: `${s.origin}/login`,
    signupUrl: `${s.origin}/signup`,
    accept: ["#terms"],
  });

before(async () => {
  ensureDisplay();
  browser = await chromium.launch({ headless: false, channel: "chrome" });
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  await context?.close();
  context = await browser.newContext();
  // The widget comes from the host the code looks for, without leaving the box.
  await context.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: WIDGET_HTML })
  );
  page = await context.newPage();
});

const start = async (options?: Parameters<typeof startAuthSite>[0]) => {
  await site?.close();
  site = await startAuthSite({ users: [{ ...KNOWN, name: "Known User" }], ...options });
  return specFor(site);
};

after(async () => site?.close());

describe("finding a form nobody described", { timeout: MINUTE }, () => {
  test("the fields are discovered from the markup", async () => {
    const spec = await start();
    await page.goto(spec.signupUrl!);

    for (const kind of ["email", "password", "confirm", "fullName"] as const) {
      assert.ok(await findField(page, kind, spec), `${kind} not found`);
    }
    // A signup form has no username field here; a missing optional field must
    // read as absent rather than as an error.
    assert.equal(await findField(page, "username", spec), null);
  });
});

describe("signing in", { timeout: 2 * MINUTE }, () => {
  test("correct credentials produce a session", async () => {
    const spec = await start();
    const outcome = await signIn(page, KNOWN, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.challenged, false);
    assert.match(outcome.detail, /signed in as known@example.com/);
    assert.equal(await isSignedIn(page, spec), true);
  });

  test("a wrong password is reported as the form's own refusal", async () => {
    const spec = await start();
    const outcome = await signIn(page, { ...KNOWN, password: "nope" }, spec);

    assert.equal(outcome.ok, false);
    // The distinction that matters: refused by the site, not blocked before
    // reaching it. One is a credential problem, the other is a route problem.
    assert.match(outcome.detail, /refused: These credentials do not match/);
    assert.equal(await isSignedIn(page, spec), false);
  });

  test("the password typed is the password stored", async () => {
    // human.type makes and corrects typos; a correction that did not take
    // would create an account whose password nobody knows.
    const spec = await start();
    const identity = newIdentity({ password: "Zx9!kqmr2LpTvA#4" });
    const created = await signUp(page, identity, spec);
    assert.equal(created.ok, true, created.detail);

    const back = await signIn(page, identity, spec);
    assert.equal(back.ok, true, back.detail);
  });
});

describe("signing up", { timeout: 2 * MINUTE }, () => {
  test("a new identity is registered and lands signed in", async () => {
    const spec = await start();
    const identity = newIdentity();
    const outcome = await signUp(page, identity, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(await isSignedIn(page, spec), true);
    assert.ok(site.users().some((u) => u.email === identity.email), "the server has no such user");
  });

  test("a duplicate email comes back with the site's message", async () => {
    const spec = await start();
    const outcome = await signUp(page, newIdentity({ ...KNOWN }), spec);

    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /already been taken/);
    assert.match((await formError(page)) ?? "", /already been taken/);
  });

  test("a site with no signup URL says so rather than guessing one", async () => {
    const spec = await start();
    const outcome = await signUp(page, newIdentity(), { ...spec, signupUrl: undefined });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /no signup URL/);
  });
});

describe("a challenge in the middle of it", { timeout: 2 * MINUTE }, () => {
  test("an interstitial in front of the login form is passed", async () => {
    const spec = await start({ challenge: ["GET /login"] });
    const outcome = await signIn(page, KNOWN, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.challenged, true, "the challenge went unnoticed");
    assert.equal(await isSignedIn(page, spec), true);
  });

  test("an interstitial on the response to the submit is passed", async () => {
    // The hard case: the form is gone, the page says nothing about
    // credentials, and a flow that only looked for an error message would
    // report a failed login for a site that accepted it.
    const spec = await start({ challenge: ["POST /login"] });
    const outcome = await signIn(page, KNOWN, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.challenged, true);
    assert.equal(await isSignedIn(page, spec), true);
  });

  test("a signup behind a challenge still registers", async () => {
    const spec = await start({ challenge: ["GET /signup", "POST /signup"] });
    const identity = newIdentity();
    const outcome = await signUp(page, identity, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.challenged, true);
    assert.ok(site.users().some((u) => u.email === identity.email));
  });

  test("challenge: false leaves the interstitial in place", async () => {
    // A probe measuring blocks wants the challenge page, not a solved one.
    const spec = await start({ challenge: ["GET /login"] });
    const outcome = await signIn(page, KNOWN, spec, { challenge: false });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.challenged, false);
    assert.match(outcome.detail, /no login form/);
  });
});

describe("forms that are not the easy shape", { timeout: 3 * MINUTE }, () => {
  test("a submit button with no type, outside any form", async () => {
    // practicetestautomation.com. `button[type=submit]` does not match it and
    // `form button` does not either, so the discovery list has to know about
    // a bare `button#submit`.
    const spec = await start({ shape: "formless" });
    const outcome = await signIn(page, KNOWN, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(await isSignedIn(page, spec), true);
  });

  test("fields written a second after load", async () => {
    // OrangeHRM's React demo: at domcontentloaded there is no form at all,
    // and discovery answered "no login form on the page" for a page that
    // grows one a beat later.
    const spec = await start({ shape: "delayed" });
    const outcome = await signIn(page, KNOWN, spec);

    assert.equal(outcome.ok, true, outcome.detail);
  });

  test("a sign-out link hidden inside a closed menu", async () => {
    // saucedemo keeps Logout in a burger menu. Nothing visible on the page
    // says signed in, so the affordance is matched by presence, not
    // visibility.
    const spec = await start({ shape: "hidden-logout" });
    const outcome = await signIn(page, KNOWN, spec);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(await isSignedIn(page, spec), true);
  });

  test("a wrong password on that same shape is still refused", async () => {
    // The half that makes the one above worth anything: presence-based
    // detection must not turn every page into a success.
    const spec = await start({ shape: "hidden-logout" });
    const outcome = await signIn(page, { ...KNOWN, password: "nope" }, spec);

    assert.equal(outcome.ok, false, outcome.detail);
    assert.match(outcome.detail, /do not match/);
  });

  test("a username-only form is filled from credentials.username", async () => {
    // Most real login forms take a username in a plain text input. The
    // fixture's field is an email input, so this asserts the fallback
    // direction: given only a username, it goes into whatever identifier
    // field exists.
    const spec = await start();
    const outcome = await signIn(page, { username: KNOWN.email, password: KNOWN.password }, spec);
    assert.equal(outcome.ok, true, outcome.detail);
  });
});

describe("what a browser does once it is in", { timeout: 3 * MINUTE }, () => {
  test("it clicks, and the page agrees that it was clicked", async () => {
    const spec = await start();
    await signIn(page, KNOWN, spec);

    const outcome = await runActions(page, [
      { do: "visit", url: `${site.origin}/app` },
      { do: "click", selector: "#add" },
      { do: "click", selector: "#add" },
      { do: "read", name: "cart", selector: "#count" },
    ]);

    assert.equal(outcome.ok, true, outcome.detail);
    // The counter only moves on a real click, so this is the page's own
    // account of what happened rather than ours.
    assert.equal(outcome.data.cart, "2");
    assert.equal(outcome.steps.length, 4);
    assert.ok(outcome.steps.every((s) => s.ok));
  });

  test("reading several elements, and an attribute rather than the text", async () => {
    const spec = await start();
    await signIn(page, KNOWN, spec);

    const outcome = await runActions(page, [
      { do: "visit", url: `${site.origin}/app` },
      { do: "read", name: "prices", selector: ".price", all: true },
      { do: "read", name: "skus", selector: ".item", attribute: "data-sku", all: true },
    ]);

    assert.deepEqual(outcome.data.prices, ["$9.99", "$19.99", "$29.99"]);
    assert.deepEqual(outcome.data.skus, ["a1", "b2", "c3"]);
  });

  test("typing goes through the keyboard, not through the value property", async () => {
    const spec = await start();
    await signIn(page, KNOWN, spec);

    const outcome = await runActions(page, [
      { do: "visit", url: `${site.origin}/app` },
      { do: "type", selector: "#note", text: "written by hand" },
      // #echo is only updated by an input event, so it is empty if the value
      // was assigned rather than typed.
      { do: "read", name: "echo", selector: "#echo" },
    ]);

    assert.equal(outcome.data.echo, "written by hand");
  });

  test("a screenshot lands on disk, named for the browser that took it", async () => {
    const spec = await start();
    await signIn(page, KNOWN, spec);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shots-"));

    const outcome = await runActions(
      page,
      [
        { do: "visit", url: `${site.origin}/app` },
        { do: "shot", label: "app" },
      ],
      { shotDir: dir, shotPrefix: "desktop-chrome" }
    );

    assert.equal(outcome.shots.length, 1);
    assert.equal(path.basename(outcome.shots[0]), "desktop-chrome-02-app.png");
    assert.ok(fs.statSync(outcome.shots[0]).size > 1000, "the screenshot is empty");
    // It is on the step too, so the UI can put the picture next to the step
    // that took it.
    assert.equal(outcome.steps[1].shot, outcome.shots[0]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a step that fails stops the list and says which one", async () => {
    const spec = await start();
    await signIn(page, KNOWN, spec);

    const outcome = await runActions(
      page,
      [
        { do: "visit", url: `${site.origin}/app` },
        { do: "click", selector: "#not-a-thing" },
        { do: "read", name: "cart", selector: "#count" },
      ],
      { timeout: 2000 }
    );

    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /step 2 \(click\) failed/);
    // The third step did not run: continuing after a click that never landed
    // produces results that look fine and mean nothing.
    assert.equal(outcome.steps.length, 2);
    assert.equal(outcome.data.cart, undefined);
  });

  test("an optional step that fails is skipped, and the rest carries on", async () => {
    const spec = await start();
    await signIn(page, KNOWN, spec);

    const outcome = await runActions(
      page,
      [
        { do: "visit", url: `${site.origin}/app` },
        { do: "click", selector: "#cookie-banner-that-is-not-there", optional: true },
        { do: "read", name: "cart", selector: "#count" },
      ],
      { timeout: 2000 }
    );

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.data.cart, "0");
    assert.equal(outcome.steps[1].ok, false);
    assert.match(outcome.detail, /1 optional skipped/);
  });

  test("a click that navigates is followed, and the challenge on the far side passed", async () => {
    // The interstitial is served on the page the link leads to, which is the
    // shape that breaks a list: the click succeeds, and everything after it
    // runs against a challenge page.
    const spec = await start({ challenge: ["GET /login"] });
    await signIn(page, KNOWN, spec);
    await page.goto(`${site.origin}/app`);

    const outcome = await runActions(page, [
      { do: "click", selector: "#next" },
      { do: "read", name: "heading", selector: "h1" },
    ]);

    assert.equal(outcome.ok, true, outcome.detail);
    assert.equal(outcome.data.heading, "App");
    assert.match(page.url(), /page=2/);
  });
});

describe("a browser each", { timeout: 4 * MINUTE }, () => {
  test("each browser runs the action list on its own session", async () => {
    const spec = await start();
    const book = accountBook({ path: ":memory:" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shots-"));

    const results = await createAccounts(spec, {
      count: 2,
      kind: "desktop",
      engine: "chromium",
      book,
      stagger: [50, 150],
      shotDir: dir,
      after: [
        { do: "visit", url: `${site.origin}/app` },
        { do: "click", selector: "#add" },
        { do: "read", name: "cart", selector: "#count" },
        { do: "shot" },
      ],
    });

    for (const result of results) {
      assert.equal(result.ok, true, `${result.profile}: ${result.detail}`);
      assert.equal(result.actions?.data.cart, "1", "the click did not land for " + result.profile);
      assert.equal(result.actions?.shots.length, 1);
      // Named for the profile, so a gallery of eight pictures says which
      // browser each one came from.
      assert.match(path.basename(result.actions!.shots[0]), new RegExp(`^${result.profile}-`));
    }

    // Separate sessions: a shared one would have counted two clicks.
    assert.equal(new Set(results.map((r) => r.profile)).size, 2);
    fs.rmSync(dir, { recursive: true, force: true });
    book.close();
  });

  test("three browsers create three accounts and sign back into their own", async () => {
    const spec = await start();
    const book = accountBook({ path: ":memory:" });

    const created = await createAccounts(spec, {
      count: 3,
      kind: "desktop",
      engine: "chromium",
      book,
      stagger: [50, 150],
    });

    assert.equal(created.length, 3);
    for (const outcome of created) assert.equal(outcome.ok, true, `${outcome.profile}: ${outcome.detail}`);

    const emails = new Set(created.map((c) => c.email));
    const profiles = new Set(created.map((c) => c.profile));
    assert.equal(emails.size, 3, "two browsers shared an email");
    assert.equal(profiles.size, 3, "two accounts share a fingerprint");
    assert.equal(site.users().length, 4, "the server did not see three registrations");

    // Every account is filed against the browser that made it, so a later run
    // can put each one back where it belongs.
    for (const outcome of created) {
      assert.equal(book.forProfile("fixture", outcome.profile)?.email, outcome.email);
      assert.equal(book.forProfile("fixture", outcome.profile)?.status, "active");
    }

    // No profiles passed: signInAll defaults to the fingerprints that own an
    // account, which is the only way the second run can find the first's work.
    const back = await signInAll(spec, { book, stagger: [50, 150] });

    for (const outcome of back) assert.equal(outcome.ok, true, `${outcome.profile}: ${outcome.detail}`);
    assert.deepEqual(
      back.map((b) => `${b.profile}=${b.email}`).sort(),
      created.map((c) => `${c.profile}=${c.email}`).sort(),
      "a browser signed into somebody else's account"
    );
    book.close();
  });

  test("a browser with no account on file fails rather than borrowing one", async () => {
    const spec = await start();
    const book = accountBook({ path: ":memory:" });
    book.add({ ...newIdentity(), site: "fixture", profile: "desktop-edge", status: "active" });

    const results = await signInAll(spec, {
      book,
      profiles: ["desktop-chrome"],
      stagger: [0, 1],
    });

    assert.equal(results[0].ok, false);
    assert.match(results[0].detail, /no account on file/);
    book.close();
  });
});
