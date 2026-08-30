/**
 * Identities and the account book - the parts that need no browser.
 *
 * The book is where "one account per fingerprint" is either true or a comment
 * in a file, so most of this is about what it refuses to store.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  newIdentity,
  newPassword,
  accountBook,
  FIELD_SELECTORS,
  SCRAPINGCOURSE,
  type Account,
} from "../accounts";
import { defineSite, signInEach } from "../accounts";
import { ConfigError } from "../errors";

const book = () => accountBook({ path: ":memory:" });

const identityFor = (profile: string, site = "demo"): Omit<Account, "createdAt" | "status"> => ({
  ...newIdentity(),
  site,
  profile,
});

describe("identities", () => {
  test("every identity is distinct", () => {
    const emails = new Set(Array.from({ length: 500 }, () => newIdentity().email));
    // 500 collisions-free draws is not proof, but a counter-based suffix - the
    // obvious alternative - fails this the moment two runs overlap.
    assert.equal(emails.size, 500);
  });

  test("the local part is not a numbered series", () => {
    const locals = Array.from({ length: 20 }, () => newIdentity().email.split("@")[0]);
    for (const local of locals) {
      assert.match(local, /^[a-z]+\.[a-z]+\.[0-9a-f]{8}$/);
    }
  });

  test("passwords satisfy the usual policy", () => {
    for (let i = 0; i < 200; i++) {
      const password = newPassword();
      assert.equal(password.length, 16);
      assert.match(password, /[A-Z]/);
      assert.match(password, /[a-z]/);
      assert.match(password, /[0-9]/);
      assert.match(password, /[!@#$%^&*\-_=+?]/);
    }
  });

  test("the required characters are not always in front", () => {
    // Unshuffled, every password would begin upper-lower-digit-symbol, which
    // is both a fingerprint and a weaker password than it looks.
    const shapes = new Set(
      Array.from({ length: 100 }, () => newPassword().slice(0, 4).replace(/[A-Z]/g, "U")
        .replace(/[a-z]/g, "l").replace(/[0-9]/g, "d").replace(/[^Uld]/g, "s"))
    );
    assert.ok(shapes.size > 5, `only ${shapes.size} distinct opening shapes`);
  });

  test("fields can be pinned, and the rest still generated", () => {
    const identity = newIdentity({ email: "fixed@example.org", firstName: "ada" });
    assert.equal(identity.email, "fixed@example.org");
    assert.equal(identity.firstName, "ada");
    assert.ok(identity.password.length >= 16);
    assert.match(identity.fullName, /^Ada /);
  });

  test("the domain is settable, for a catch-all inbox", () => {
    assert.match(newIdentity({ domain: "inbox.test" }).email, /@inbox\.test$/);
  });
});

describe("the account book", () => {
  test("an account comes back for the profile that owns it", () => {
    const b = book();
    const account = b.add(identityFor("desktop-chrome"));
    const found = b.forProfile("demo", "desktop-chrome");

    assert.equal(found?.email, account.email);
    assert.equal(found?.password, account.password);
    assert.equal(found?.status, "pending");
    b.close();
  });

  test("a second account for the same profile is refused", () => {
    const b = book();
    b.add(identityFor("desktop-chrome"));
    // Not a nicety: two accounts on one fingerprint is the correlation the
    // whole design is avoiding, and a convention would not survive two
    // concurrent runs.
    assert.throws(() => b.add(identityFor("desktop-chrome")), /UNIQUE|constraint/i);
    b.close();
  });

  test("the same profile may hold an account on each site", () => {
    const b = book();
    b.add(identityFor("desktop-chrome", "demo"));
    b.add(identityFor("desktop-chrome", "other"));

    assert.equal(b.all("demo").length, 1);
    assert.equal(b.all("other").length, 1);
    b.close();
  });

  test("the same email cannot be registered twice on one site", () => {
    const b = book();
    const first = identityFor("desktop-chrome");
    b.add(first);
    assert.throws(() => b.add({ ...first, profile: "desktop-edge" }), /UNIQUE|constraint/i);
    b.close();
  });

  test("accounts with no profile do not collide", () => {
    const b = book();
    // The unique index is partial, so a pool of unassigned identities is fine.
    b.add({ ...newIdentity(), site: "demo" });
    b.add({ ...newIdentity(), site: "demo" });
    assert.equal(b.all("demo").length, 2);
    b.close();
  });

  test("status and notes survive an update", () => {
    const b = book();
    const account = b.add(identityFor("mobile-pixel-7"));
    b.update("demo", account.email, { status: "active", note: "signed in" });

    const found = b.get("demo", account.email);
    assert.equal(found?.status, "active");
    assert.equal(found?.note, "signed in");
    // The password is what makes the row worth keeping; an update must not
    // quietly drop it.
    assert.equal(found?.password, account.password);
    b.close();
  });

  test("an empty patch changes nothing rather than writing empty SQL", () => {
    const b = book();
    const account = b.add(identityFor("desktop-edge"));
    b.update("demo", account.email, {});
    assert.equal(b.get("demo", account.email)?.status, "pending");
    b.close();
  });

  test("all() filters by site and status", () => {
    const b = book();
    const a = b.add(identityFor("desktop-chrome"));
    b.add(identityFor("desktop-edge"));
    b.update("demo", a.email, { status: "active" });

    assert.equal(b.all("demo").length, 2);
    assert.equal(b.all("demo", "active").length, 1);
    assert.equal(b.all("demo", "pending").length, 1);
    b.close();
  });
});

describe("field discovery", () => {
  test("the email selectors prefer the typed input to a name match", () => {
    // "confirm email" matches [name*=mail] too, so ordering is what keeps the
    // right field in front.
    assert.equal(FIELD_SELECTORS.email[0], "input[type=email]");
    assert.ok(FIELD_SELECTORS.email.indexOf("input[name*='mail' i]") > 0);
  });

  test("password selectors do not match the confirmation first", () => {
    assert.ok(FIELD_SELECTORS.password.every((s) => !/confirm/i.test(s)));
    assert.ok(FIELD_SELECTORS.confirm.every((s) => /confirm|confirmation/i.test(s)));
  });

  test("the username selectors exclude email and password inputs", () => {
    assert.ok(FIELD_SELECTORS.username.some((s) => s.includes(":not([type=email])")));
    assert.ok(FIELD_SELECTORS.username.some((s) => s.includes(":not([type=password])")));
  });
});

describe("the shipped site", () => {
  test("scrapingcourse has a login and no signup", () => {
    // It publishes one demo account and has no registration - a spec claiming
    // otherwise would send every run at a 404.
    assert.match(SCRAPINGCOURSE.loginUrl, /^https:\/\/www\.scrapingcourse\.com\/login$/);
    assert.equal(SCRAPINGCOURSE.signupUrl, undefined);
  });
});

describe("typed errors", () => {
  test("too few credentials for the browser count is a ConfigError, before any launch", async () => {
    const spec = defineSite({ name: "demo", loginUrl: "https://demo.example/login" });
    await assert.rejects(() => signInEach(spec, [], { count: 1 }), ConfigError);
    await assert.rejects(() => signInEach(spec, [], { count: 1 }), /credentials/);
  });
});
