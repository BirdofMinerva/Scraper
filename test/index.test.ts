/**
 * The public library surface is a contract: `index.ts` is what a consumer of
 * the published package sees, and it is easy to break silently — a rename in a
 * source module, an export dropped from the barrel, or the app layer
 * (server/jobs/dashboard glue) leaking in where it does not belong.
 *
 * This runs against the SOURCE barrel via tsx (no dist build needed), so it
 * guards the surface on every `test:unit` run. The expected-names arrays are
 * deliberately explicit: adding or removing a public export forces an edit
 * here, which is the point.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../index";

// Representative public value exports (functions + consts). Not exhaustive, but
// covers one from every module group so a whole group vanishing is caught.
const EXPECTED_VALUES = [
  // crawl
  "crawl", "pageRange",
  // missions
  "defineMission", "runMission", "runOnce", "runEach", "partition",
  // browsers
  "launchProfile", "getProfile", "PROFILES",
  // stack
  "openStack", "planStack",
  // storage
  "sqliteStore", "jsonlStore", "csvStore", "memoryStore", "multiStore", "customStore", "toRows",
  // proxies
  "resolveProxy", "proxyPool", "withProxy", "describeProxy",
  // routes
  "parseRoutes", "withDirect", "selectRoutes", "describeRoute",
  // accounts
  "accountBook", "defineSite", "createAccounts", "ensureAccounts", "signInAll", "signInEach",
  // actions
  "parseActions", "runActions", "describeAction",
  // turnstile
  "passChallenge", "gotoAndPass",
  // ffuf
  "fuzzPaths", "enumerateSubdomains", "runFfuf", "buildFfufArgs", "parseFfufJson",
  "DEFAULT_MATCH_STATUS", "DEFAULT_THREADS", "DEFAULT_RATE", "DEFAULT_INPUT_NUM",
  // targets
  "TARGETS", "selectTargets",
  // errors
  "ScraperError", "ConfigError", "LaunchError", "ProxyError", "ChallengeError", "FfufError", "StorageError",
] as const;

// The 7 error classes and the code each carries.
const ERROR_CLASSES = [
  "ConfigError", "LaunchError", "ProxyError", "ChallengeError", "FfufError", "StorageError",
] as const;

// App-layer names that must NEVER be re-exported from the library barrel — the
// dashboard/server/jobs glue is how the app runs, not an API to build against.
const MUST_NOT_LEAK = [
  "runJob", "runScrape", "runBot", "runEnumerate", "validate", "parseCredentials",
  "resolveSite", "startUrls", "verifyRoutes", "seedUrlsFrom", "ffufOptionsFrom",
  "createServer", "createRuns",
];

describe("public barrel (index.ts)", () => {
  test("every intended value export is present and defined", () => {
    const missing = EXPECTED_VALUES.filter((name) => (lib as Record<string, unknown>)[name] === undefined);
    assert.deepEqual(missing, [], `missing exports: ${missing.join(", ")}`);
  });

  test("the error classes are the real taxonomy, wired through the barrel", () => {
    // FfufError specifically, per the contract.
    const fe = new lib.FfufError("boom");
    assert.ok(fe instanceof lib.ScraperError, "FfufError must extend ScraperError");
    assert.ok(fe instanceof Error, "ScraperError must extend Error");
    assert.equal(fe.code, "FFUF");

    // Every subclass: a real ScraperError with a non-empty string code.
    for (const name of ERROR_CLASSES) {
      const Cls = (lib as Record<string, new (msg: string) => Error & { code?: unknown }>)[name];
      assert.equal(typeof Cls, "function", `${name} must be exported as a class`);
      const err = new Cls("x");
      assert.ok(err instanceof lib.ScraperError, `${name} must extend ScraperError`);
      assert.equal(typeof err.code, "string", `${name} must carry a string code`);
      assert.ok((err.code as string).length > 0, `${name}.code must be non-empty`);
    }
  });

  test("the app layer does NOT leak into the public surface", () => {
    const leaked = MUST_NOT_LEAK.filter((name) => name in (lib as Record<string, unknown>));
    assert.deepEqual(leaked, [], `app-layer names leaked into the barrel: ${leaked.join(", ")}`);
  });

  test("spot-check: a re-exported function actually behaves", () => {
    // buildFfufArgs is pure — proves the re-export is the real implementation,
    // not just a defined-but-hollow binding.
    const args = lib.buildFfufArgs("https://example.com", "path", { wordlist: "/tmp/wl.txt" });
    assert.ok(args.includes("-w") && args.includes("-u"));
    assert.equal(lib.DEFAULT_RATE, 100);
    assert.equal(lib.DEFAULT_THREADS, 40);
  });
});
