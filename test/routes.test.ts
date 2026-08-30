/**
 * Route parsing has no browser in it, but getting it wrong is expensive: a
 * mistyped proxy that silently becomes "direct" attributes a whole run's
 * results to the wrong exit IP.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRoutes, withDirect, selectRoutes, describeRoute } from "../routes";
import { ConfigError } from "../errors";

describe("parseRoutes", () => {
  test("a labelled single hop", () => {
    assert.deepEqual(parseRoutes("home=socks5://127.0.0.1:1080"), [
      { label: "home", proxy: "socks5://127.0.0.1:1080" },
    ]);
  });

  test("newlines and commas both separate entries", () => {
    assert.equal(parseRoutes("a=http://1:1\nb=http://2:2").length, 2);
    assert.equal(parseRoutes("a=http://1:1,b=http://2:2").length, 2);
  });

  test("a chain becomes an ordered hop list", () => {
    const [route] = parseRoutes("chain=http://a:8080 > http://b:3128 > http://c:9000");
    assert.deepEqual(route.proxy, [
      { server: "http://a:8080" },
      { server: "http://b:3128" },
      { server: "http://c:9000" },
    ]);
  });

  test("credentials in the URL survive parsing", () => {
    const [route] = parseRoutes("t=http://user:pass@gate:7000");
    assert.equal(route.proxy, "http://user:pass@gate:7000");
  });

  test("an unlabelled entry gets a positional name", () => {
    assert.deepEqual(parseRoutes("http://a:8080").map((r) => r.label), ["proxy1"]);
    assert.deepEqual(parseRoutes("http://a:8080\nhttp://b:8080").map((r) => r.label), ["proxy1", "proxy2"]);
  });

  test("comments and blank lines are ignored", () => {
    const routes = parseRoutes("# a note\n\nhome=http://a:8080\n\n#another");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].label, "home");
  });

  test("empty input yields no routes", () => {
    assert.deepEqual(parseRoutes(""), []);
    assert.deepEqual(parseRoutes("\n\n  \n"), []);
  });

  test("a label with no value is dropped, not turned into a broken route", () => {
    // "home=" would otherwise produce a route with an empty server, which
    // Playwright accepts and then ignores - looking exactly like a proxy that
    // did not help.
    assert.deepEqual(parseRoutes("home="), []);
    assert.deepEqual(parseRoutes("home= > "), []);
  });

  test("surrounding whitespace is trimmed everywhere", () => {
    const [route] = parseRoutes("  home  =  http://a:8080  >  http://b:3128  ");
    assert.equal(route.label, "home");
    assert.deepEqual(route.proxy, [{ server: "http://a:8080" }, { server: "http://b:3128" }]);
  });
});

describe("withDirect", () => {
  test("puts the control first", () => {
    const routes = withDirect(parseRoutes("home=http://a:8080"));
    assert.equal(routes[0].label, "direct");
    assert.equal(routes[0].proxy, undefined);
    assert.equal(routes[1].label, "home");
  });
});

describe("selectRoutes", () => {
  const routes = withDirect(parseRoutes("home=http://a:8080,trial=http://b:8080"));

  test("no flag runs everything", () => {
    assert.equal(selectRoutes(routes, ["node", "script"]).length, 3);
  });

  test("--only narrows to the named routes", () => {
    const chosen = selectRoutes(routes, ["--only=home"]);
    assert.deepEqual(chosen.map((r) => r.label), ["home"]);
  });

  test("--only takes a list", () => {
    const chosen = selectRoutes(routes, ["--only=home,trial"]);
    assert.deepEqual(chosen.map((r) => r.label), ["home", "trial"]);
  });

  test("a typo throws instead of silently running every route", () => {
    assert.throws(() => selectRoutes(routes, ["--only=hme"]), /matched no routes.*direct, home, trial/);
  });
});

describe("describeRoute", () => {
  test("direct is named, not blank", () => {
    assert.equal(describeRoute({ label: "direct" }), "direct");
  });

  test("credentials are masked for printing", () => {
    assert.equal(
      describeRoute({ label: "t", proxy: "http://user:secret@gate:7000" }),
      "http://***@gate:7000"
    );
  });

  test("a chain renders in order", () => {
    assert.equal(
      describeRoute({ label: "c", proxy: [{ server: "http://a:8080" }, { server: "http://b:3128" }] }),
      "http://a:8080 -> http://b:3128"
    );
  });
});

describe("typed errors", () => {
  test("--only matching no routes is a ConfigError, message unchanged", () => {
    const routes = parseRoutes("home=http://1.1.1.1:8080");
    assert.throws(() => selectRoutes(routes, ["--only=nope"]), ConfigError);
    assert.throws(() => selectRoutes(routes, ["--only=nope"]), /matched no routes/);
  });
});
