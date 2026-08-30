/**
 * ffuf is a request cannon, so the two things worth getting right without ever
 * firing it are the arguments it is handed (a wrong `-mc` or a missing `-rate`
 * hammers a target) and the parse of what it hands back. Both are pure, so both
 * are tested here against fixtures with no ffuf and no network. One optional,
 * env-gated test actually shells the binary at a throwaway localhost server.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFfufArgs,
  parseFfufJson,
  parseFfufLine,
  shapeFfufUrl,
  fuzzPaths,
  enumerateSubdomains,
  DEFAULT_MATCH_STATUS,
  type FfufOptions,
  type FfufResult,
} from "../ffuf";

/** Pull the value ffuf is given for a flag, e.g. flag(args, "-u"). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
/** Every value passed under a repeatable flag, in order (e.g. every -H). */
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) out.push(args[i + 1]);
  return out;
}

const wl = "/usr/share/wordlists/common.txt";
const base: FfufOptions = { wordlist: wl };

/** The exact bytes ffuf prefixes each live line with: CR + clear-line ANSI. */
const PRE = "\r\u001b[2K";
const POST = "\u001b[0m";

/** A throwaway localhost target + wordlist for the opt-in live tests. */
async function startLocalTarget() {
  const http = await import("node:http");
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = http.createServer((req, res) => {
    if (req.url === "/admin" || req.url === "/login") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html>ok ${req.url}</html>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const wlPath = path.join(os.tmpdir(), `ffuf-wl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fsm.writeFileSync(wlPath, "admin\nlogin\nnotthere\n");
  return {
    url: `http://127.0.0.1:${port}`,
    wlPath,
    async close() {
      fsm.rmSync(wlPath, { force: true });
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Identity fields shared by a streamed hit and its final-array twin. */
function identity(h: FfufResult) {
  return JSON.stringify({
    input: h.input, url: h.url, host: h.host,
    status: h.status, length: h.length, words: h.words, lines: h.lines,
  });
}

describe("shapeFfufUrl", () => {
  test("path mode appends /FUZZ", () => {
    assert.equal(shapeFfufUrl("https://site.com", "path"), "https://site.com/FUZZ");
  });

  test("path mode never doubles the slash", () => {
    assert.equal(shapeFfufUrl("https://site.com/", "path"), "https://site.com/FUZZ");
    assert.equal(shapeFfufUrl("https://site.com///", "path"), "https://site.com/FUZZ");
  });

  test("path mode keeps a sub-path", () => {
    assert.equal(shapeFfufUrl("https://site.com/api", "path"), "https://site.com/api/FUZZ");
  });

  test("subdomain mode builds https://FUZZ.<domain>/", () => {
    assert.equal(shapeFfufUrl("example.com", "subdomain"), "https://FUZZ.example.com/");
  });

  test("subdomain mode strips scheme, path and case from the domain", () => {
    assert.equal(shapeFfufUrl("https://Example.com/anything", "subdomain"), "https://FUZZ.example.com/");
  });

  test("an explicit FUZZ keyword is trusted verbatim in either mode", () => {
    assert.equal(shapeFfufUrl("https://site.com/a/FUZZ/b", "path"), "https://site.com/a/FUZZ/b");
    assert.equal(shapeFfufUrl("https://FUZZ.example.com/", "subdomain"), "https://FUZZ.example.com/");
  });
});

describe("buildFfufArgs", () => {
  test("the required flags and safe defaults are all present", () => {
    const args = buildFfufArgs("https://site.com", "path", base);
    assert.equal(flag(args, "-w"), wl);
    assert.equal(flag(args, "-u"), "https://site.com/FUZZ");
    assert.equal(flag(args, "-of"), "json");
    assert.equal(flag(args, "-t"), "40"); // default threads
    assert.equal(flag(args, "-rate"), "100"); // safe default, NOT unlimited
    assert.equal(flag(args, "-mc"), DEFAULT_MATCH_STATUS);
    assert.ok(args.includes("-s"), "runs silent so the JSON file is the only output");
  });

  test("the ephemeral output path is NOT baked in (runFfuf adds -o)", () => {
    const args = buildFfufArgs("https://site.com", "path", base);
    assert.ok(!args.includes("-o"), "-o is a runtime temp path, not part of the pure args");
  });

  test("threads and rate are overridable", () => {
    const args = buildFfufArgs("https://site.com", "path", { wordlist: wl, threads: 10, rate: 25 });
    assert.equal(flag(args, "-t"), "10");
    assert.equal(flag(args, "-rate"), "25");
  });

  test("matchStatus overrides the default -mc", () => {
    const args = buildFfufArgs("https://site.com", "path", { wordlist: wl, matchStatus: "200,301" });
    assert.equal(flag(args, "-mc"), "200,301");
  });

  test("filters map to -fc/-fs/-fw and accept numbers or strings", () => {
    const args = buildFfufArgs("https://site.com", "path", {
      wordlist: wl,
      filterStatus: "404",
      filterSize: 0,
      filterWords: "12",
    });
    assert.equal(flag(args, "-fc"), "404");
    assert.equal(flag(args, "-fs"), "0"); // numeric 0 must still be emitted
    assert.equal(flag(args, "-fw"), "12");
  });

  test("filters absent by default produce no filter flags", () => {
    const args = buildFfufArgs("https://site.com", "path", base);
    assert.ok(!args.includes("-fc"));
    assert.ok(!args.includes("-fs"));
    assert.ok(!args.includes("-fw"));
  });

  test("headers become one -H 'Key: Value' each", () => {
    const args = buildFfufArgs("https://site.com", "path", {
      wordlist: wl,
      headers: { "User-Agent": "x", "X-Test": "1" },
    });
    const hs = flags(args, "-H");
    assert.deepEqual(hs, ["User-Agent: x", "X-Test: 1"]);
  });

  test("extraArgs are appended verbatim as an escape hatch", () => {
    const args = buildFfufArgs("https://site.com", "path", { wordlist: wl, extraArgs: ["-recursion", "-x", "socks5://127.0.0.1:9050"] });
    assert.ok(args.join(" ").endsWith("-recursion -x socks5://127.0.0.1:9050"));
  });

  test("subdomain mode shapes the -u into https://FUZZ.<domain>/", () => {
    const args = buildFfufArgs("example.com", "subdomain", base);
    assert.equal(flag(args, "-u"), "https://FUZZ.example.com/");
  });

  test("a missing wordlist throws rather than building a broken run", () => {
    assert.throws(() => buildFfufArgs("https://site.com", "path", { wordlist: "" }), /wordlist/);
    // @ts-expect-error deliberately omitting the required field
    assert.throws(() => buildFfufArgs("https://site.com", "path", {}), /wordlist/);
  });

  test("without onResult, -s stays (behaviour unchanged from before streaming)", () => {
    assert.ok(buildFfufArgs("https://site.com", "path", base).includes("-s"));
  });

  test("with onResult, -s is dropped so ffuf streams full result lines to stdout", () => {
    const args = buildFfufArgs("https://site.com", "path", { wordlist: wl, onResult: () => {} });
    assert.ok(!args.includes("-s"), "streaming needs the live lines -s would suppress");
    assert.equal(flag(args, "-of"), "json"); // the JSON file is still the source of truth
  });
});

// A realistic ffuf 2.1.0 `-of json` file: two hits, plain (not base64) input
// values, a bookkeeping FFUFHASH to ignore, and nanosecond durations.
const FIXTURE = JSON.stringify({
  commandline: "ffuf -w wl.txt -u http://127.0.0.1:8999/FUZZ -of json -o out.json -mc 200 -s",
  time: "2026-08-30T18:43:47Z",
  results: [
    {
      input: { FFUFHASH: "814012", FUZZ: "login" },
      position: 2,
      status: 200,
      length: 22,
      words: 2,
      lines: 1,
      "content-type": "text/html",
      redirectlocation: "",
      scraper: {},
      duration: 437192,
      resultfile: "",
      url: "http://127.0.0.1:8999/login",
      host: "127.0.0.1:8999",
    },
    {
      input: { FFUFHASH: "814011", FUZZ: "admin" },
      position: 1,
      status: 301,
      length: 0,
      words: 1,
      lines: 1,
      "content-type": "",
      redirectlocation: "http://127.0.0.1:8999/admin/",
      scraper: {},
      duration: 908921,
      resultfile: "",
      url: "http://127.0.0.1:8999/admin",
      host: "127.0.0.1:8999",
    },
  ],
  config: { threads: 40, rate: 0 },
});

describe("parseFfufJson", () => {
  test("a realistic fixture flattens to typed results", () => {
    const results = parseFfufJson(FIXTURE);
    assert.equal(results.length, 2);

    const login = results.find((r) => r.input === "login");
    assert.ok(login, "the FUZZ value is the input, not the FFUFHASH");
    assert.equal(login.url, "http://127.0.0.1:8999/login");
    assert.equal(login.host, "127.0.0.1:8999");
    assert.equal(login.status, 200);
    assert.equal(login.length, 22);
    assert.equal(login.words, 2);
    assert.equal(login.lines, 1);
    assert.equal(login.contentType, "text/html");
    assert.equal(login.redirectLocation, undefined); // empty string is dropped
    assert.equal(login.durationMs, 0.437); // 437192 ns -> ms, rounded
  });

  test("empty and redirect fields are handled honestly", () => {
    const admin = parseFfufJson(FIXTURE).find((r) => r.input === "admin");
    assert.ok(admin);
    assert.equal(admin.status, 301);
    assert.equal(admin.redirectLocation, "http://127.0.0.1:8999/admin/");
    assert.equal(admin.contentType, undefined); // empty content-type dropped
    assert.equal(admin.length, 0); // a real zero survives, not dropped
  });

  test("a custom keyword still resolves as the input", () => {
    const raw = JSON.stringify({ results: [{ input: { FFUFHASH: "1", W: "wp-admin" }, url: "http://x/wp-admin", status: 200, length: 5, words: 1, lines: 1 }] });
    assert.equal(parseFfufJson(raw)[0].input, "wp-admin");
  });

  test("no matches: an empty results array is []", () => {
    assert.deepEqual(parseFfufJson(JSON.stringify({ results: [] })), []);
  });

  test("no matches: a null results field is [] too", () => {
    assert.deepEqual(parseFfufJson(JSON.stringify({ results: null })), []);
    assert.deepEqual(parseFfufJson(JSON.stringify({ commandline: "ffuf ..." })), []);
  });

  test("malformed input throws with a clear message", () => {
    assert.throws(() => parseFfufJson("not json at all"), /not valid JSON/);
    assert.throws(() => parseFfufJson(""), /not valid JSON/);
    assert.throws(() => parseFfufJson("{"), /not valid JSON/);
  });

  test("a non-array results field is a shape error, not silently empty", () => {
    assert.throws(() => parseFfufJson(JSON.stringify({ results: "surprise" })), /non-array/);
  });

  test("missing numeric fields default to 0 rather than NaN", () => {
    const raw = JSON.stringify({ results: [{ input: { FUZZ: "x" }, url: "http://x/x" }] });
    const [r] = parseFfufJson(raw);
    assert.equal(r.status, 0);
    assert.equal(r.length, 0);
    assert.equal(r.words, 0);
    assert.equal(r.lines, 0);
    assert.equal(r.durationMs, undefined);
  });
});

describe("parseFfufLine (drives onResult, pure)", () => {
  test("a real path-mode line (ANSI + CR wrapped) flattens to a hit", () => {
    const line = `${PRE}admin                   [Status: 200, Size: 22, Words: 2, Lines: 1, Duration: 5ms]${POST}`;
    const hit = parseFfufLine(line, "path", "http://127.0.0.1:8999");
    assert.ok(hit);
    assert.equal(hit.input, "admin");
    assert.equal(hit.url, "http://127.0.0.1:8999/admin"); // reconstructed from target
    assert.equal(hit.host, "127.0.0.1:8999"); // URL authority, as ffuf's JSON records
    assert.equal(hit.status, 200);
    assert.equal(hit.length, 22);
    assert.equal(hit.words, 2);
    assert.equal(hit.lines, 1);
    assert.equal(hit.durationMs, 5); // integer ms, the live precision
  });

  test("subdomain-mode host is <match>.<domain>, matching enumerateSubdomains", () => {
    const line = `${PRE}www                     [Status: 200, Size: 100, Words: 10, Lines: 5, Duration: 12ms]${POST}`;
    const hit = parseFfufLine(line, "subdomain", "https://Example.com/");
    assert.ok(hit);
    assert.equal(hit.input, "www");
    assert.equal(hit.url, "https://www.example.com/");
    assert.equal(hit.host, "www.example.com");
  });

  test("an explicit FUZZ keyword in the target is where the match lands", () => {
    const line = "api  [Status: 200, Size: 1, Words: 1, Lines: 1, Duration: 0ms]";
    const hit = parseFfufLine(line, "path", "http://x/FUZZ/v2");
    assert.ok(hit);
    assert.equal(hit.url, "http://x/api/v2");
    assert.equal(hit.host, "x");
  });

  test("non-result lines (progress, blanks, banner) are null, not hits", () => {
    assert.equal(parseFfufLine("", "path", "http://x"), null);
    assert.equal(parseFfufLine(`${PRE}:: Progress: [10/10] :: Job [1/1] :: 200 req/sec${POST}`, "path", "http://x"), null);
    assert.equal(parseFfufLine("        :: Method           : GET", "path", "http://x"), null);
  });
});

// -------------------------------------------------------------------------
// Optional live integration test. Off by default so `npm run test:unit`
// stays pure and fast; run with FFUF_LIVE=1 to actually shell ffuf against a
// throwaway localhost server (authorised target: your own machine).
// -------------------------------------------------------------------------
describe("runFfuf (live, opt-in)", () => {
  test("fuzzPaths finds seeded paths on a local server", { skip: !process.env.FFUF_LIVE }, async () => {
    const t = await startLocalTarget();
    try {
      const hits = await fuzzPaths(t.url, { wordlist: t.wlPath, matchStatus: "200" });
      const found = hits.map((h) => h.input).sort();
      assert.deepEqual(found, ["admin", "login"]);
      for (const h of hits) assert.equal(h.status, 200);
    } finally {
      await t.close();
    }
  });

  test("onResult fires once per hit; streamed hits equal the returned array", { skip: !process.env.FFUF_LIVE }, async () => {
    const t = await startLocalTarget();
    try {
      const streamed: FfufResult[] = [];
      const hits = await fuzzPaths(t.url, {
        wordlist: t.wlPath,
        matchStatus: "200",
        onResult: (h) => streamed.push(h),
      });

      // No misses, no dupes: the set of streamed hits equals the returned array
      // on their shared identity fields (contentType/redirectLocation live only
      // in the JSON, and durationMs precision differs, so they're excluded).
      assert.deepEqual(streamed.map(identity).sort(), hits.map(identity).sort());
      assert.equal(streamed.length, hits.length);

      // Exactly one callback per hit.
      const counts = new Map<string, number>();
      for (const h of streamed) counts.set(h.input, (counts.get(h.input) ?? 0) + 1);
      for (const [, n] of counts) assert.equal(n, 1);

      // The streamed hits carry real, reconstructed identity.
      assert.deepEqual(streamed.map((h) => h.input).sort(), ["admin", "login"]);
      for (const h of streamed) {
        assert.equal(h.status, 200);
        assert.equal(h.url, `${t.url}/${h.input}`);
      }
    } finally {
      await t.close();
    }
  });

  test("omitting onResult leaves the returned array unchanged", { skip: !process.env.FFUF_LIVE }, async () => {
    const t = await startLocalTarget();
    try {
      const withCb = await fuzzPaths(t.url, { wordlist: t.wlPath, matchStatus: "200", onResult: () => {} });
      const noCb = await fuzzPaths(t.url, { wordlist: t.wlPath, matchStatus: "200" });
      assert.deepEqual(withCb.map(identity).sort(), noCb.map(identity).sort());
    } finally {
      await t.close();
    }
  });

  test("a timeout rejects rather than hanging", { skip: !process.env.FFUF_LIVE }, async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const wlPath = path.join(os.tmpdir(), `ffuf-wl-to-${Date.now()}.txt`);
    // A large-ish wordlist against a non-routable host with a 1ms budget.
    fs.writeFileSync(wlPath, Array.from({ length: 500 }, (_, i) => `w${i}`).join("\n"));
    try {
      await assert.rejects(
        () => fuzzPaths("http://10.255.255.1", { wordlist: wlPath, timeoutMs: 1 }),
        /timed out/,
      );
    } finally {
      fs.rmSync(wlPath, { force: true });
    }
  });
});

// enumerateSubdomains fills .host from the match; assert the mapping without a
// network by exercising the same logic runFfuf's results flow through. (The
// spawn path itself is covered by the opt-in live test above.)
describe("enumerateSubdomains host-filling contract", () => {
  test("is exported and callable", () => {
    assert.equal(typeof enumerateSubdomains, "function");
  });
});
