/**
 * The typed-error taxonomy: the contract a library consumer branches on.
 *
 * Every subclass has to stay an `Error` (so `instanceof Error` and existing
 * `catch` blocks keep working), carry its stable `code`, report its own class
 * `name`, preserve the message verbatim, and thread `cause` through. Plus a
 * smoke that a real converted call site throws the right subclass, so the
 * taxonomy is proven wired in, not just constructible.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ScraperError,
  ConfigError,
  LaunchError,
  ProxyError,
  ChallengeError,
  FfufError,
  StorageError,
} from "../errors";
import { validate } from "../jobs";
import { buildFfufArgs, parseFfufJson } from "../ffuf";

/** Each concrete subclass, its expected code, and its name. */
const SUBCLASSES = [
  { Cls: ConfigError, code: "CONFIG", name: "ConfigError" },
  { Cls: LaunchError, code: "LAUNCH", name: "LaunchError" },
  { Cls: ProxyError, code: "PROXY", name: "ProxyError" },
  { Cls: ChallengeError, code: "CHALLENGE", name: "ChallengeError" },
  { Cls: FfufError, code: "FFUF", name: "FfufError" },
  { Cls: StorageError, code: "STORAGE", name: "StorageError" },
] as const;

describe("error taxonomy", () => {
  for (const { Cls, code, name } of SUBCLASSES) {
    describe(name, () => {
      test("is both a ScraperError and an Error", () => {
        const err = new Cls("boom");
        assert.ok(err instanceof Cls);
        assert.ok(err instanceof ScraperError);
        assert.ok(err instanceof Error);
      });

      test(`carries code "${code}" and its own name`, () => {
        const err = new Cls("boom");
        assert.equal(err.code, code);
        assert.equal(err.name, name);
      });

      test("preserves the message verbatim", () => {
        const message = "a very specific message, unchanged 123";
        assert.equal(new Cls(message).message, message);
      });

      test("threads the cause through", () => {
        const cause = new Error("the underlying reason");
        const err = new Cls("wrapped", { cause });
        assert.equal(err.cause, cause);
      });

      test("a non-Error cause is kept as given", () => {
        const cause = { kind: "not an error" };
        assert.equal(new Cls("wrapped", { cause }).cause, cause);
      });
    });
  }

  test("ScraperError is usable directly and carries the code it is given", () => {
    const err = new ScraperError("direct", "CUSTOM");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ScraperError");
    assert.equal(err.code, "CUSTOM");
    assert.equal(err.message, "direct");
  });

  test("code is a stable string per subclass, not shared", () => {
    const codes = SUBCLASSES.map(({ Cls }) => new Cls("x").code);
    assert.equal(new Set(codes).size, codes.length); // all distinct
  });
});

describe("converted call sites throw the right subclass", () => {
  test("jobs validate() rejects a bad config with ConfigError", () => {
    // A scrape config with no URLs cannot work; it is a ConfigError, and the
    // message is the same one a message-matching test would have asserted.
    assert.throws(
      () => validate({ mode: "scrape", urls: [], rowSelector: ".r", fields: [{ name: "t" }] } as any),
      ConfigError
    );
  });

  test("ffuf buildFfufArgs() with no input source throws FfufError's sibling ConfigError", () => {
    // A missing wordlist/input-cmd is a config problem, per the taxonomy.
    assert.throws(() => buildFfufArgs("https://x", "path", {} as any), ConfigError);
    assert.throws(() => buildFfufArgs("https://x", "path", {} as any), /needs an input source/);
  });

  test("ffuf parseFfufJson() rejects unparseable output with FfufError", () => {
    assert.throws(() => parseFfufJson("{not json"), FfufError);
    assert.throws(() => parseFfufJson("{not json"), /valid JSON/);
  });
});
