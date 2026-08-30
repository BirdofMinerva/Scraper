/**
 * The practice-login catalogue: names, URLs and the one entry that is allowed
 * to be strange.
 *
 * Cheap, and it earns its place the same way `targets.test.ts` does - a
 * catalogue is a fixture, and a fixture with a duplicate name or an http URL
 * produces results attributed to the wrong site.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LOGIN_SITES, selectSites } from "../login-sites";

describe("the catalogue", () => {
  test("names are unique", () => {
    const names = LOGIN_SITES.map((s) => s.spec.name);
    assert.equal(new Set(names).size, names.length);
  });

  test("every site is https and carries credentials", () => {
    for (const site of LOGIN_SITES) {
      assert.match(site.spec.loginUrl, /^https:\/\//, site.spec.name);
      assert.ok(site.credentials.password, `${site.spec.name} has no password`);
      assert.ok(
        site.credentials.username || site.credentials.email,
        `${site.spec.name} has no identifier`
      );
      assert.ok(site.note.length > 10, `${site.spec.name} does not say what it is for`);
    }
  });

  test("only the fake login is exempt from the negative test", () => {
    // `acceptsAnything` disables the half of the probe that proves the
    // detector can say no. Exactly one site here deserves it.
    const exempt = LOGIN_SITES.filter((s) => s.acceptsAnything).map((s) => s.spec.name);
    assert.deepEqual(exempt, ["quotes-toscrape"]);
  });

  test("the site with no account UI brings its own signedIn", () => {
    const rahul = LOGIN_SITES.find((s) => s.spec.name === "rahulshetty");
    assert.equal(typeof rahul?.spec.signedIn, "function");
  });
});

describe("--only", () => {
  test("selects by name", () => {
    const chosen = selectSites(LOGIN_SITES, ["--only=saucedemo,parabank"]);
    assert.deepEqual(chosen.map((s) => s.spec.name), ["saucedemo", "parabank"]);
  });

  test("no flag means everything", () => {
    assert.equal(selectSites(LOGIN_SITES, []).length, LOGIN_SITES.length);
  });

  test("a name that matches nothing throws rather than running the lot", () => {
    assert.throws(() => selectSites(LOGIN_SITES, ["--only=saucedemoo"]), /matched no sites/);
  });
});
