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
  seedUrlsFrom,
  SEED_URL_CAP,
  enumerateResult,
  type BotConfig,
  type ScrapeConfig,
  type EnumerateConfig,
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

const enumerate = (over: Partial<EnumerateConfig> = {}): EnumerateConfig => ({
  mode: "enumerate",
  target: "example.com",
  enumMode: "subdomain",
  wordlist: "/tmp/words.txt",
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


describe("enumerate configs", () => {
  test("a subdomain config passes", () => {
    validate(enumerate());
  });

  test("a path config passes", () => {
    validate(enumerate({ enumMode: "path", target: "https://example.com/" }));
  });

  test("a missing target is refused", () => {
    // Rejected in the form, before ffuf is ever spawned.
    assert.throws(() => validate(enumerate({ target: "" })), /target domain or URL/);
    assert.throws(() => validate(enumerate({ target: "   " })), /target domain or URL/);
  });

  test("a missing wordlist is refused", () => {
    assert.throws(() => validate(enumerate({ wordlist: "" })), /wordlist path/);
    assert.throws(() => validate(enumerate({ wordlist: "  " })), /wordlist path/);
  });

  test("an unknown mode is refused", () => {
    assert.throws(() => validate(enumerate({ enumMode: "portscan" as any })), /Enumerate mode must be/);
  });

  test("path mode needs a URL, subdomain mode a bare domain", () => {
    // FUZZ has to have somewhere to go, and that place is a URL; a subdomain
    // fuzz on a scheme is the same mistake the other way round.
    assert.throws(() => validate(enumerate({ enumMode: "path", target: "example.com" })), /base URL/);
    assert.throws(
      () => validate(enumerate({ enumMode: "subdomain", target: "https://example.com" })),
      /bare domain/
    );
  });

  test("thread and rate floors are enforced", () => {
    assert.throws(() => validate(enumerate({ threads: 0 })), /one thread/);
    assert.throws(() => validate(enumerate({ rate: -5 })), /negative/);
  });

  test("a fully specified config passes and keeps its shape", () => {
    const config = enumerate({
      enumMode: "path",
      target: "https://example.com/",
      wordlist: "/tmp/w.txt",
      threads: 40,
      rate: 100,
      timeoutMs: 60_000,
      matchStatus: "200,301",
      filterStatus: "404",
      filterSize: 4242,
      filterWords: 12,
      store: { path: "out.db", table: "hits" },
    });
    validate(config);
    assert.equal(config.mode, "enumerate");
    assert.equal(config.enumMode, "path");
    assert.equal(config.matchStatus, "200,301");
    assert.equal(config.store?.table, "hits");
  });
});


describe("start URLs take any named URL, not just numbered ones", () => {
  // The user's core doubt: they thought scrape "only goes through numbers as
  // directories". It never did - startUrls passes arbitrary URLs through
  // untouched, and the {n} range is one optional add-on.
  test("named pages, deep paths and query strings pass through unchanged", () => {
    const given = [
      "https://site/index.html",
      "https://site/products/shoes",
      "https://site/about",
      "https://site/search?q=boots&page=2",
    ];
    assert.deepEqual(startUrls(scrape({ urls: given })), given);
  });

  test("a single named URL with no number anywhere is fine on its own", () => {
    assert.deepEqual(
      startUrls(scrape({ urls: ["https://shop.example/catalog/index"] })),
      ["https://shop.example/catalog/index"]
    );
  });

  test("named URLs and a numbered range coexist, in that order", () => {
    const urls = startUrls(
      scrape({
        urls: ["https://site/index.html", "https://site/about"],
        range: { pattern: "https://site/list?page={n}", from: 1, to: 2 },
      })
    );
    assert.deepEqual(urls, [
      "https://site/index.html",
      "https://site/about",
      "https://site/list?page=1",
      "https://site/list?page=2",
    ]);
  });
});

describe("enumerate seed URLs", () => {
  test("deduplicates while keeping first-seen order", () => {
    const { urls, truncated } = seedUrlsFrom([
      { url: "https://a" },
      { url: "https://b" },
      { url: "https://a" },
      { url: "https://c" },
    ]);
    assert.deepEqual(urls, ["https://a", "https://b", "https://c"]);
    assert.equal(truncated, 0);
  });

  test("blank urls are skipped rather than seeded", () => {
    const { urls } = seedUrlsFrom([{ url: "" }, { url: "https://x" }, { url: "" }]);
    assert.deepEqual(urls, ["https://x"]);
  });

  test("the list is capped and it reports how many were dropped", () => {
    const hits = Array.from({ length: SEED_URL_CAP + 5 }, (_, i) => ({ url: `https://h/${i}` }));
    const { urls, truncated } = seedUrlsFrom(hits);
    assert.equal(urls.length, SEED_URL_CAP);
    assert.equal(truncated, 5);
  });

  test("a custom cap is honoured, after the dedupe", () => {
    const { urls, truncated } = seedUrlsFrom(
      [{ url: "a" }, { url: "b" }, { url: "a" }, { url: "c" }],
      2
    );
    assert.deepEqual(urls, ["a", "b"]);
    // three distinct after dedupe, cap 2, so one dropped.
    assert.equal(truncated, 1);
  });
});


describe("enumerate result shaping (streaming + partial-on-stop)", () => {
  // A minimal ffuf hit. The streaming and full-array hits share these identity
  // fields; contentType is the one that is absent on a streamed hit.
  const hit = (over: Record<string, unknown> = {}) => ({
    input: "x",
    url: "https://x",
    host: "x",
    status: 200,
    length: 1,
    words: 1,
    lines: 1,
    ...over,
  }) as any;

  test("a finished run summarises the count and carries the full seed set", () => {
    const r = enumerateResult(
      [hit({ url: "https://b", host: "b" }), hit({ url: "https://a", host: "a" })],
      "subdomains"
    );
    assert.equal(r.summary, "2 subdomains found");
    // sorted by host, so a before b regardless of arrival order
    assert.deepEqual(r.rows!.map((row) => row.host), ["a", "b"]);
    assert.deepEqual(r.seedUrls, ["https://a", "https://b"]);
  });

  test("a stopped run keeps its partials and says so", () => {
    // This is the partial-on-stop contract: streamed hits found before the kill
    // come back rather than an empty result.
    const r = enumerateResult([hit({ url: "https://a", host: "a" })], "paths", true);
    assert.equal(r.summary, "stopped - 1 paths found");
    assert.deepEqual(r.seedUrls, ["https://a"]);
    assert.equal(r.rows!.length, 1);
  });

  test("a stop with nothing found is still a clean, honest result", () => {
    const r = enumerateResult([], "subdomains", true);
    assert.equal(r.summary, "stopped - 0 subdomains found");
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.seedUrls, []);
  });

  test("the table is a 50-row sample while seedUrls carries the rest", () => {
    const hits = Array.from({ length: 120 }, (_, i) => {
      const id = String(i).padStart(3, "0");
      return hit({ url: `https://h/${id}`, host: `h/${id}` });
    });
    const r = enumerateResult(hits, "paths");
    assert.equal(r.rows!.length, 50);
    assert.equal(r.seedUrls!.length, 120);
  });

  test("contentType rides along when present, and is null when a streamed hit lacks it", () => {
    const r = enumerateResult(
      [hit({ url: "https://a", host: "a", contentType: "text/html" }), hit({ url: "https://b", host: "b" })],
      "paths"
    );
    assert.equal(r.rows![0].contentType, "text/html");
    assert.equal(r.rows![1].contentType, null);
  });
});
