/**
 * What the dashboard sends, before any of it reaches a browser.
 *
 * Every case here is a config that should be refused in the form rather than
 * three minutes into a run - and one, the extractor source, is a bug that cost
 * a live run to find: Playwright evaluates a string as an expression and
 * silently drops the argument you pass beside it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCredentials,
  startUrls,
  resolveSite,
  validate,
  type BotConfig,
  type ScrapeConfig,
} from "../jobs";

const scrape = (over: Partial<ScrapeConfig> = {}): ScrapeConfig => ({
  mode: "scrape",
  urls: ["https://example.com/list"],
  rowSelector: ".row",
  fields: [{ name: "title", selector: "h2" }],
  ...over,
});

const bot = (over: Partial<BotConfig> = {}): BotConfig => ({
  mode: "bot",
  action: "list",
  site: { name: "demo", loginUrl: "https://demo.example/login" },
  credentials: "a@example.com:one\nb@example.com:two",
  browsers: 2,
  ...over,
});

describe("credential lists", () => {
  test("colon, comma and space all separate", () => {
    const list = parseCredentials("a@x.com:one\nb@x.com,two\ncarl three");
    assert.deepEqual(list, [
      { email: "a@x.com", password: "one" },
      { email: "b@x.com", password: "two" },
      { username: "carl", password: "three" },
    ]);
  });

  test("a password containing the separator survives", () => {
    // Split on the first separator only: `pass:word` is a password people use.
    const [entry] = parseCredentials("user:pass:word");
    assert.equal(entry.password, "pass:word");
  });

  test("comments and blank lines are skipped", () => {
    assert.equal(parseCredentials("# a note\n\n  \nuser:pw\n").length, 1);
  });

  test("an identifier with an @ is an email, otherwise a username", () => {
    assert.equal(parseCredentials("a@x.com:p")[0].email, "a@x.com");
    assert.equal(parseCredentials("tomsmith:p")[0].username, "tomsmith");
  });

  test("a line with no password is dropped rather than half-used", () => {
    assert.equal(parseCredentials("lonely\nuser:pw").length, 1);
  });
});

describe("start URLs", () => {
  test("a range expands, and joins the explicit list", () => {
    const urls = startUrls(
      scrape({ urls: ["https://a.example/"], range: { pattern: "https://b.example/{n}", from: 2, to: 4 } })
    );
    assert.deepEqual(urls, [
      "https://a.example/",
      "https://b.example/2",
      "https://b.example/3",
      "https://b.example/4",
    ]);
  });

  test("a pattern with no {n} is refused", () => {
    assert.throws(
      () => startUrls(scrape({ urls: [], range: { pattern: "https://b.example/", from: 1, to: 3 } })),
      /\{n\}/
    );
  });

  test("a backwards range is refused", () => {
    assert.throws(
      () => startUrls(scrape({ urls: [], range: { pattern: "https://b/{n}", from: 9, to: 2 } })),
      /ends before it starts/
    );
  });

  test("an absurd range is refused rather than queued", () => {
    assert.throws(
      () => startUrls(scrape({ urls: [], range: { pattern: "https://b/{n}", from: 1, to: 99_999 } })),
      /narrow it/
    );
  });

  test("something that is not a URL is refused", () => {
    assert.throws(() => startUrls(scrape({ urls: ["example.com/list"] })), /Not a URL/);
  });
});

describe("scrape configs", () => {
  test("a complete one passes", () => {
    validate(scrape());
  });

  test("a row selector and at least one field are required", () => {
    assert.throws(() => validate(scrape({ rowSelector: "" })), /selector for the repeating row/);
    assert.throws(() => validate(scrape({ fields: [] })), /at least one field/);
  });

  test("a dedupe key that is not a field is refused", () => {
    // Otherwise every row keys on "undefined" and the crawl silently keeps one.
    assert.throws(() => validate(scrape({ key: "price" })), /not one of the fields/);
    validate(scrape({ key: "title" }));
  });
});

describe("one exit IP per browser", () => {
  test("fewer routes than browsers is refused", () => {
    assert.throws(
      () => validate(scrape({ browsers: 4, proxies: "a=http://1.1.1.1:8080\nb=http://2.2.2.2:8080" })),
      /two browsers would leave from the same IP/
    );
  });

  test("unless sharing is asked for explicitly", () => {
    validate(scrape({ browsers: 4, proxies: "a=http://1.1.1.1:8080", allowSharedProxies: true }));
  });

  test("the same route twice is refused", () => {
    // A list that looks like an IP each and is not.
    assert.throws(
      () => validate(scrape({ browsers: 2, proxies: "a=http://1.1.1.1:8080\nb=http://1.1.1.1:8080" })),
      /in the list twice/
    );
  });

  test("no routes at all is fine - everything leaves from this machine", () => {
    validate(scrape({ browsers: 4 }));
  });

  test("the same rules apply to bot runs", () => {
    assert.throws(
      () =>
        validate(
          bot({
            browsers: 3,
            credentials: "a@x.com:1\nb@x.com:2\nc@x.com:3",
            proxies: "a=http://1.1.1.1:8080",
          })
        ),
      /same IP/
    );
  });
});

describe("bot configs", () => {
  test("a preset resolves to its shipped spec and credentials", () => {
    const { spec, credentials } = resolveSite({ mode: "bot", action: "signin", preset: "saucedemo" });
    assert.equal(spec.name, "saucedemo");
    assert.equal(credentials?.username, "standard_user");
  });

  test("an unknown preset is refused", () => {
    assert.throws(() => resolveSite({ mode: "bot", action: "signin", preset: "nope" }), /Unknown preset/);
  });

  test("a hand-described site falls back to the hostname for a name", () => {
    const { spec } = resolveSite({
      mode: "bot",
      action: "signin",
      site: { name: "", loginUrl: "https://shop.example/account/login" },
    });
    assert.equal(spec.name, "shop.example");
  });

  test("signedInUrlIncludes becomes a signedIn check", () => {
    const { spec } = resolveSite({
      mode: "bot",
      action: "signin",
      site: { name: "x", loginUrl: "https://x.example/login", signedInUrlIncludes: "/app" },
    });
    assert.equal(typeof spec.signedIn, "function");
  });

  test("creating accounts needs a signup URL", () => {
    assert.throws(() => validate(bot({ action: "create" })), /no signup URL/);
  });

  test("a credential list run needs credentials", () => {
    assert.throws(() => validate(bot({ credentials: "" })), /Paste some credentials/);
  });

  test("more browsers than credentials is refused", () => {
    assert.throws(() => validate(bot({ browsers: 5 })), /would share a login/);
  });

  test("the same login twice in the list is refused", () => {
    // Two browsers on one account is the correlation the whole module avoids;
    // it is also the easiest paste mistake to make.
    assert.throws(
      () => validate(bot({ credentials: "a@x.com:one\na@x.com:one" })),
      /in the credential list twice/
    );
  });

  test("a broken action list is refused with the config", () => {
    // The action list is part of the bot config, so it has to be refused in
    // the same place as everything else - not when browser 1 reaches step 2.
    assert.throws(() => validate(bot({ actions: [{ do: "click" }] as any })), /step 1: click needs a selector/);
    assert.throws(() => validate(bot({ actions: [{ do: "dance" }] as any })), /not something a browser can do/);
  });

  test("a valid action list passes", () => {
    validate(bot({ actions: [{ do: "visit", url: "https://x.example" }, { do: "shot" }] as any }));
  });

  test("a site with no login URL is refused", () => {
    assert.throws(() => validate(bot({ site: { name: "x", loginUrl: "" } })), /Give a login URL/);
  });
});
