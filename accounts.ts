/**
 * Accounts: one per browser, created and signed into by the browser that owns
 * it.
 *
 *   const spec = defineSite({ name: "demo", loginUrl, signupUrl });
 *   const book = accountBook({ path: "accounts.db" });
 *
 *   await createAccounts(spec, { count: 5, book });   // five browsers, five signups
 *   await signInAll(spec, { count: 5, book });        // each back into its own
 *
 * The rule the whole file exists to keep is one account per fingerprint. Five
 * accounts created by five browsers are five users; five accounts created by
 * one browser, or one account used from five, is one user behaving oddly - and
 * the correlation is in the site's data whatever the fingerprints claim. So
 * identities are claimed per profile, and the book enforces it with a unique
 * index rather than a convention.
 *
 * Everything here goes through `human` for typing and clicking, and through
 * `turnstile` on every navigation: a challenge on the login POST is common,
 * and a form that submits into an interstitial looks like wrong credentials
 * unless something checks.
 */
import type { Locator, Page } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomInt } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { humanize, type Human } from "./human";
import { passChallenge, type ChallengeOptions } from "./turnstile";
import { openStack, type StackKind } from "./stack";
import { runActions, type Action, type ActionsOutcome } from "./actions";
import type { BrowserProfile, Engine } from "./browsers";
import type { ProxyLike } from "./proxies";

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type Identity = {
  email: string;
  password: string;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
};

const FIRST = [
  "mara", "jonas", "elif", "noah", "svea", "tomas", "irina", "kaspar",
  "lena", "otto", "vera", "ilse", "rafa", "nadia", "bruno", "elsa",
];
const LAST = [
  "vogel", "keller", "brandt", "novak", "haas", "riedel", "sommer", "kraus",
  "lindqvist", "moreau", "berg", "wex", "olsen", "duarte", "farkas", "reiss",
];
const SYMBOLS = "!@#$%^&*-_=+?";

const pick = <T,>(items: T[]) => items[randomInt(items.length)];

/**
 * A password that satisfies the policies sites actually enforce.
 *
 * Upper, lower, digit and symbol, sixteen characters. Generated from
 * `node:crypto`, not `Math.random`: these are written to a database and reused
 * later, so a predictable stream is a real problem rather than a stylistic one.
 */
export function newPassword(length = 16): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", SYMBOLS];
  const chars = sets.map((set) => set[randomInt(set.length)]);
  const all = sets.join("");
  while (chars.length < length) chars.push(all[randomInt(all.length)]);

  // Shuffle, or the first four characters always follow the same pattern.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/**
 * A fresh identity.
 *
 * The email local part carries a random suffix rather than a counter: two
 * processes generating identities at once must not collide, and a site can
 * read `jonas.keller1`, `jonas.keller2`, `jonas.keller3` for what it is.
 */
export function newIdentity(overrides: Partial<Identity> & { domain?: string } = {}): Identity {
  const { domain = "example.com", ...fields } = overrides;
  const firstName = fields.firstName ?? pick(FIRST);
  const lastName = fields.lastName ?? pick(LAST);
  const tag = randomUUID().replace(/-/g, "").slice(0, 8);
  const username = fields.username ?? `${firstName}.${lastName}.${tag}`.toLowerCase();

  return {
    firstName,
    lastName,
    fullName: fields.fullName ?? `${cap(firstName)} ${cap(lastName)}`,
    username,
    email: fields.email ?? `${username}@${domain}`,
    password: fields.password ?? newPassword(),
  };
}

const cap = (word: string) => word.slice(0, 1).toUpperCase() + word.slice(1);

// ---------------------------------------------------------------------------
// Describing a site's forms
// ---------------------------------------------------------------------------

export type FieldKind =
  | "email"
  | "password"
  | "confirm"
  | "username"
  | "firstName"
  | "lastName"
  | "fullName";

export type AuthSpec = {
  /** Site label; also the key accounts are filed under. */
  name: string;
  loginUrl: string;
  /** Omit for a site with no self-service signup. */
  signupUrl?: string;
  /** Selector overrides. Anything not given here is discovered. */
  fields?: Partial<Record<FieldKind, string>>;
  /** Submit buttons, if the discovered one is wrong. */
  submit?: { login?: string; signup?: string };
  /** Checkboxes to tick before submitting a signup - terms, age, and so on. */
  accept?: string[];
  /** Overrides the signed-in heuristic below. */
  signedIn?: (page: Page) => Promise<boolean>;
  /** Anything else the form needs, run after the fields are filled. */
  before?: (page: Page, human: Human) => Promise<void>;
};

export function defineSite(spec: AuthSpec): AuthSpec {
  return spec;
}

/**
 * Candidate selectors per field, most specific first.
 *
 * A spec that has to name every selector is a spec nobody writes for the
 * second site, so the default is discovery and `fields` is the escape hatch
 * for when a form is unusual. Ordering matters: `input[type=email]` before
 * `[name*=mail]`, because a "confirm email" field matches the latter too.
 */
export const FIELD_SELECTORS: Record<FieldKind, string[]> = {
  email: [
    "input[type=email]",
    "input[name=email]",
    "input#email",
    "input[autocomplete=email]",
    "input[name*='mail' i]",
  ],
  password: [
    "input[type=password][name=password]",
    "input#password",
    "input[autocomplete=current-password]",
    "input[autocomplete=new-password]",
    "input[type=password]",
  ],
  confirm: [
    "input[name*='confirm' i][type=password]",
    "input[name*='password_confirmation' i]",
    "input#password-confirm",
    "input#password_confirmation",
  ],
  username: [
    "input[name=username]",
    "input#username",
    "input[autocomplete=username]:not([type=email])",
    "input[name*='user' i]:not([type=password])",
  ],
  firstName: ["input[name*='first' i]", "input#first_name", "input#firstName"],
  lastName: ["input[name*='last' i]", "input#last_name", "input#lastName"],
  fullName: ["input[name=name]", "input#name", "input[autocomplete=name]"],
};

/** A field that is actually on the page, and the selector that found it. */
export type FoundField = { selector: string; locator: Locator };

/**
 * The first visible, enabled match for a field, or null.
 *
 * The selector comes back with it because `human.type` works in selectors -
 * it clicks, types and corrects through the page, and handing it a locator
 * would mean a second way of doing the same thing.
 */
export async function findField(
  page: Page,
  kind: FieldKind,
  spec: AuthSpec = { name: "", loginUrl: "" }
): Promise<FoundField | null> {
  const candidates = spec.fields?.[kind]
    ? [spec.fields[kind] as string]
    : FIELD_SELECTORS[kind];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await visible(locator)) return { selector, locator };
  }
  return null;
}

const visible = (locator: Locator) =>
  locator
    .isVisible({ timeout: 1000 })
    .then((v) => v && locator.isEnabled().catch(() => false))
    .catch(() => false);

const SUBMIT_SELECTORS = [
  "button[type=submit]",
  "input[type=submit]",
  "#submit-button",
  "#login-button",
  // A button with no type attribute is not `button[type=submit]`, and one
  // outside a <form> is not `form button` either. Both are common enough that
  // leaving them out cost a real site (practicetestautomation.com).
  "button#submit",
  "button:has-text('Sign in')",
  "button:has-text('Log in')",
  "button:has-text('Login')",
  "button:has-text('Sign up')",
  "button:has-text('Register')",
  "button:has-text('Create account')",
  "button:has-text('Submit')",
  "form button",
];

async function findSubmit(page: Page, override?: string): Promise<FoundField | null> {
  for (const selector of override ? [override] : SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await visible(locator)) return { selector, locator };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the outcome
// ---------------------------------------------------------------------------

const ERROR_SELECTORS = [
  ".alert-danger",
  ".invalid-feedback",
  "[data-test*='error' i]",
  ".error-message-container",
  ".oxd-alert-content",
  "[role=alert]",
  ".error",
  ".errorlist",
  "#error",
  "#flash.error",
];

/** The form's own complaint, if it made one. */
export async function formError(page: Page): Promise<string | undefined> {
  for (const selector of ERROR_SELECTORS) {
    const found = page.locator(selector).first();
    if (!(await visible(found))) continue;

    // Several frameworks put success and failure in the same box with a
    // different modifier class - expandtesting's "You logged into a secure
    // area!" arrives in `.alert.alert-success`. Reading that as the reason a
    // login failed would be worse than reporting nothing.
    const classes = (await found.getAttribute("class").catch(() => "")) ?? "";
    if (/success/i.test(classes)) continue;

    const text = (await found.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 160);
  }
  return undefined;
}

/**
 * Anything that only exists for a session that exists.
 *
 * Matched by **presence, not visibility**: saucedemo keeps its "Logout" inside
 * a burger menu that is closed until you open it, and OrangeHRM behind a
 * dropdown. A hidden sign-out link is still a sign-out link; a signed-out page
 * does not have one at all.
 */
const SIGN_OUT_SELECTORS = [
  "a[href*='logout' i]",
  "a[href*='signout' i]",
  "a[href*='sign-out' i]",
  "a[href*='logoff' i]",
  "[id*='logout' i]",
  "[data-test*='logout' i]",
  "form[action*='logout' i] button",
  // By its own words, for the sites whose link is a plain href - guru99's
  // "SIGN-OFF" points at index.php and says nothing about logging out.
  "a:text-matches('^\\s*(log ?out|sign ?out|sign[- ]?off)\\s*$', 'i')",
  "button:text-matches('^\\s*(log ?out|sign ?out|sign[- ]?off)\\s*$', 'i')",
];

/**
 * Are we signed in?
 *
 * Deliberately not "the URL changed": a form that redirects back to itself
 * with an error also changes URL, and a site that signs you in on the same
 * path does not. The signal that generalises is a sign-out affordance, with a
 * visible password field as the counter-signal.
 *
 * It polls, because this is asked immediately after a submit and a success
 * page is often one redirect and a render away. A single look answered "no"
 * for sites that were signing us in perfectly well.
 */
export async function isSignedIn(page: Page, spec?: AuthSpec, timeout = 6000): Promise<boolean> {
  if (spec?.signedIn) return spec.signedIn(page);

  const deadline = Date.now() + timeout;
  do {
    for (const selector of SIGN_OUT_SELECTORS) {
      if ((await page.locator(selector).count().catch(() => 0)) > 0) return true;
    }

    const stillOnForm = await visible(page.locator("input[type=password]").first());
    if (!stillOnForm) {
      const text = await page.locator("body").innerText().catch(() => "");
      if (/\b(dashboard|my account|welcome back|signed in|logged in|success)\b/i.test(text)) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (Date.now() < deadline);

  return false;
}

// ---------------------------------------------------------------------------
// The flows
// ---------------------------------------------------------------------------

export type AuthOptions = {
  /** Reuse a session's persona instead of sampling a new one. */
  human?: Human;
  /** Budget for the whole flow, ms. Default 60s. */
  timeout?: number;
  /** Challenge handling on every navigation. `false` to leave it alone. */
  challenge?: false | ChallengeOptions;
  log?: (message: string) => void;
};

export type AuthOutcome = {
  ok: boolean;
  action: "signup" | "signin";
  site: string;
  email: string;
  /** The full identity, on a signup - the password exists nowhere else. */
  identity?: Identity;
  /** True if a Cloudflare challenge appeared at any point in the flow. */
  challenged: boolean;
  url: string;
  durationMs: number;
  detail: string;
};

/** Navigate, and get past whatever is in front of the page. */
async function visit(page: Page, url: string, options: AuthOptions): Promise<boolean> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return settle(page, options);
}

/**
 * Submit, and wait for the page that answers.
 *
 * The wait has to be armed before the click: a challenge served on the
 * response is only visible once the navigation commits, and checking straight
 * after the click reads the form we just left - which has no challenge on it,
 * and is how a solved-in-a-moment interstitial gets reported as "submitted,
 * still not signed in".
 *
 * Forms that answer without navigating (a fetch and a re-render) simply time
 * the wait out, which costs the grace period and nothing else.
 */
/**
 * Wait for the form itself to exist.
 *
 * `domcontentloaded` fires before a client-rendered login form has been
 * written, so discovery on a React app finds nothing and reports "no login
 * form on the page" for a page that grows one a second later. OrangeHRM's
 * demo is exactly this.
 */
async function waitForForm(page: Page, spec: AuthSpec, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    if (await findField(page, "password", spec)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
}

async function submitAndWait(
  page: Page,
  selector: string,
  human: Human,
  byKeyboard = false
): Promise<void> {
  const navigated = page
    .waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
      timeout: 8000,
    })
    .catch(() => null);

  if (byKeyboard) {
    await page.locator(selector).first().press("Enter");
  } else {
    await human.click(selector);
  }
  await navigated;
}

/**
 * Let a navigation finish, then check for a challenge.
 *
 * Called after every submit as well as every goto. A challenge served on the
 * POST is the case that matters: the form disappears, the interstitial does
 * not say "wrong password", and a flow that only checked the fields would
 * report bad credentials for a site that never saw them.
 */
async function settle(page: Page, options: AuthOptions): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (options.challenge === false) return false;

  const outcome = await passChallenge(page, {
    human: options.human,
    log: options.log,
    ...(options.challenge ?? {}),
  });
  if (outcome.challenged) {
    options.log?.(outcome.detail);
    if (!outcome.passed) throw new Error(`challenge not passed: ${outcome.detail}`);
  }
  return outcome.challenged;
}

/**
 * Type into a field the way a person does, then check what landed.
 *
 * `human.type` makes typos and corrects them, which is the behaviour worth
 * having and also the reason for the read-back. A correction that did not take
 * leaves a password that is not the one written to the book, and an account
 * whose password is wrong is not recoverable - it is a dead email address. So
 * the value is verified, and repaired with `fill` if it drifted.
 */
async function typeField(
  page: Page,
  field: FoundField,
  value: string,
  human: Human
): Promise<void> {
  await field.locator.scrollIntoViewIfNeeded().catch(() => {});
  await human.type(field.selector, value);

  if ((await field.locator.inputValue().catch(() => "")) !== value) {
    await field.locator.fill(value);
  }
}

async function fillCommon(
  page: Page,
  spec: AuthSpec,
  identity: Partial<Identity>,
  human: Human
): Promise<string[]> {
  const filled: string[] = [];
  const order: Array<[FieldKind, string | undefined]> = [
    ["email", identity.email],
    ["username", identity.username],
    ["fullName", identity.fullName],
    ["firstName", identity.firstName],
    ["lastName", identity.lastName],
    ["password", identity.password],
    ["confirm", identity.password],
  ];

  for (const [kind, value] of order) {
    if (!value) continue;
    // A login form has no name fields, and a signup form may have no
    // username. A missing field is normal; only a missing email or password
    // is a problem, and the caller checks for those.
    const field = await findField(page, kind, spec);
    if (!field) continue;
    await typeField(page, field, value, human);
    filled.push(kind);
  }
  return filled;
}

/** Terms, age gates, "remember me" - whatever the form insists on. */
async function tickBoxes(page: Page, spec: AuthSpec): Promise<void> {
  for (const selector of spec.accept ?? []) {
    const box = page.locator(selector).first();
    if (await visible(box)) await box.check().catch(() => {});
  }
}

/** Create an account, as this browser. */
export async function signUp(
  page: Page,
  identity: Identity,
  spec: AuthSpec,
  options: AuthOptions = {}
): Promise<AuthOutcome> {
  const started = Date.now();
  const human = options.human ?? humanize(page);
  const opts = { ...options, human };
  const done = (ok: boolean, detail: string, challenged: boolean): AuthOutcome => ({
    ok,
    action: "signup",
    site: spec.name,
    email: identity.email,
    identity,
    challenged,
    url: page.url(),
    durationMs: Date.now() - started,
    detail,
  });

  if (!spec.signupUrl) return done(false, "site has no signup URL", false);
  let challenged = false;

  try {
    challenged = (await visit(page, spec.signupUrl, opts)) || challenged;
    await waitForForm(page, spec);
    const filled = await fillCommon(page, spec, identity, human);
    if (!filled.includes("email") || !filled.includes("password")) {
      return done(false, `signup form incomplete: filled ${filled.join(", ") || "nothing"}`, challenged);
    }

    await tickBoxes(page, spec);
    await spec.before?.(page, human);

    const submit = await findSubmit(page, spec.submit?.signup);
    const password = await findField(page, "password", spec);
    if (!submit && !password) return done(false, "no submit button on the signup form", challenged);

    await human.pause(400);
    await submitAndWait(page, submit?.selector ?? password!.selector, human, !submit);
    challenged = (await settle(page, opts)) || challenged;
    await page.waitForTimeout(1200);

    if (await isSignedIn(page, spec)) {
      return done(true, `registered and signed in as ${identity.email}`, challenged);
    }

    const error = await formError(page);
    return done(false, error ? `rejected: ${error}` : "submitted, but not signed in", challenged);
  } catch (error) {
    return done(false, (error as Error).message.split("\n")[0].slice(0, 140), challenged);
  }
}

export type Credentials = {
  password: string;
  /** Either identifier will do; whichever field the form has is the one used. */
  email?: string;
  username?: string;
};

/** Sign in with credentials this browser already owns. */
export async function signIn(
  page: Page,
  credentials: Credentials,
  spec: AuthSpec,
  options: AuthOptions = {}
): Promise<AuthOutcome> {
  const started = Date.now();
  const human = options.human ?? humanize(page);
  const opts = { ...options, human };
  const done = (ok: boolean, detail: string, challenged: boolean): AuthOutcome => ({
    ok,
    action: "signin",
    site: spec.name,
    email: credentials.email ?? credentials.username ?? "",
    challenged,
    url: page.url(),
    durationMs: Date.now() - started,
    detail,
  });

  let challenged = false;
  try {
    challenged = (await visit(page, spec.loginUrl, opts)) || challenged;
    await waitForForm(page, spec);

    // Whichever identifier the form actually has. Plenty of login forms take a
    // username in a plain text input, and one that only looked for an email
    // field would report "no login form" for a form that is plainly there.
    const identifier =
      (credentials.email && (await findField(page, "email", spec))) ||
      (await findField(page, "username", spec)) ||
      (await findField(page, "email", spec));
    const password = await findField(page, "password", spec);
    if (!identifier || !password) return done(false, "no login form on the page", challenged);

    const value =
      identifier.selector === (spec.fields?.email ?? "") ||
      FIELD_SELECTORS.email.includes(identifier.selector)
        ? credentials.email ?? credentials.username
        : credentials.username ?? credentials.email;
    if (!value) return done(false, "no identifier to sign in with", challenged);

    await typeField(page, identifier, value, human);
    await typeField(page, password, credentials.password, human);
    await tickBoxes(page, spec);
    await spec.before?.(page, human);

    const submit = await findSubmit(page, spec.submit?.login);
    await human.pause(350);
    // Enter in the password field is what a person does anyway, and it is the
    // only way in on a form whose button none of the selectors match.
    await submitAndWait(page, submit?.selector ?? password.selector, human, !submit);
    challenged = (await settle(page, opts)) || challenged;
    await page.waitForTimeout(1000);

    if (await isSignedIn(page, spec)) {
      return done(true, `signed in as ${credentials.email ?? credentials.username}`, challenged);
    }

    const error = await formError(page);
    return done(false, error ? `refused: ${error}` : "submitted, still not signed in", challenged);
  } catch (error) {
    return done(false, (error as Error).message.split("\n")[0].slice(0, 140), challenged);
  }
}

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

export type AccountStatus = "pending" | "active" | "failed";

export type Account = Identity & {
  site: string;
  /** The fingerprint that owns it. One account per profile, per site. */
  profile?: string;
  status: AccountStatus;
  createdAt: string;
  lastUsedAt?: string;
  note?: string;
};

export type AccountBook = {
  /** Record an identity before it is submitted anywhere. */
  add: (account: Omit<Account, "createdAt" | "status"> & { status?: AccountStatus }) => Account;
  update: (site: string, email: string, patch: Partial<Account>) => void;
  /** This profile's account for this site, if it has one. */
  forProfile: (site: string, profile: string) => Account | undefined;
  get: (site: string, email: string) => Account | undefined;
  all: (site?: string, status?: AccountStatus) => Account[];
  close: () => void;
};

/**
 * Where accounts live between runs.
 *
 * SQLite through Node's built-in driver, same as `storage.ts` - no dependency
 * and no server. The unique index on `(site, profile)` is the part that
 * matters: one account per fingerprint is the entire premise, and a premise
 * kept by a convention is a premise broken by the first concurrent run.
 */
export function accountBook(options: { path: string; table?: string }): AccountBook {
  const { path: file, table = "accounts" } = options;
  if (file !== ":memory:") {
    const dir = path.dirname(path.resolve(file));
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
    site TEXT NOT NULL,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    username TEXT,
    firstName TEXT,
    lastName TEXT,
    fullName TEXT,
    profile TEXT,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastUsedAt TEXT,
    note TEXT,
    PRIMARY KEY (site, email)
  )`);
  // Partial, so several accounts may sit unassigned while an assigned profile
  // can hold only one.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_profile" ` +
      `ON "${table}" (site, profile) WHERE profile IS NOT NULL`
  );

  const row = (r: Record<string, unknown> | undefined): Account | undefined =>
    r ? (r as unknown as Account) : undefined;

  return {
    add(account) {
      const full: Account = {
        ...account,
        status: account.status ?? "pending",
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        `INSERT INTO "${table}"
         (site, email, password, username, firstName, lastName, fullName, profile, status, createdAt, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        full.site,
        full.email,
        full.password,
        full.username ?? null,
        full.firstName ?? null,
        full.lastName ?? null,
        full.fullName ?? null,
        full.profile ?? null,
        full.status,
        full.createdAt,
        full.note ?? null
      );
      return full;
    },

    update(site, email, patch) {
      const keys = Object.keys(patch).filter((k) => k !== "site" && k !== "email");
      if (keys.length === 0) return;
      db.prepare(
        `UPDATE "${table}" SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE site = ? AND email = ?`
      ).run(...keys.map((k) => (patch as Record<string, string>)[k] ?? null), site, email);
    },

    forProfile(site, profile) {
      return row(
        db
          .prepare(`SELECT * FROM "${table}" WHERE site = ? AND profile = ?`)
          .get(site, profile) as Record<string, unknown> | undefined
      );
    },

    get(site, email) {
      return row(
        db
          .prepare(`SELECT * FROM "${table}" WHERE site = ? AND email = ?`)
          .get(site, email) as Record<string, unknown> | undefined
      );
    },

    all(site, status) {
      const where = [site && "site = ?", status && "status = ?"].filter(Boolean).join(" AND ");
      const args = [site, status].filter(Boolean) as string[];
      const sql = `SELECT * FROM "${table}"${where ? ` WHERE ${where}` : ""} ORDER BY createdAt`;
      return db.prepare(sql).all(...args) as unknown as Account[];
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// A browser each
// ---------------------------------------------------------------------------

export type AccountRunOptions = {
  /** How many browsers, and so how many accounts. Default 3. */
  count?: number;
  kind?: StackKind;
  engine?: Engine | Engine[];
  /**
   * Exact fingerprints, in order. `signInAll` and `ensureAccounts` default to
   * the profiles that already own an account, because the stack rotation is
   * shuffled - asking twice for "three desktop browsers" gets three different
   * ones, and the second run would find no accounts on file.
   */
  profiles?: Array<BrowserProfile | string>;
  /**
   * Routes, one per browser: an account per IP as well as per fingerprint.
   * Fewer routes than browsers throws rather than putting two accounts behind
   * one address - which is the pattern a site looks for first.
   */
  proxies?: ProxyLike[];
  /** Let browsers share an exit IP anyway. */
  allowSharedProxies?: boolean;
  book?: AccountBook;
  /** Email domain for generated identities. */
  domain?: string;
  /** Gap between browsers starting, ms. Default [500, 4000]. */
  stagger?: [number, number];
  challenge?: false | ChallengeOptions;
  /** Checked before each browser starts its flow; true winds the run down. */
  stop?: () => boolean;
  /**
   * What the browser does once it is in - browse, click, read, screenshot.
   *
   * Run per browser, on the signed-in page, so each one carries its own
   * session through them. A failed step fails that browser's result and
   * leaves the others alone.
   */
  after?: Action[];
  /** Where `shot` steps write. Default the working directory. */
  shotDir?: string;
  verbose?: boolean;
};

export type AccountRunResult = AuthOutcome & {
  profile: string;
  /** Present when `after` steps ran: what they did and what they read. */
  actions?: ActionsOutcome;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);

/** The fingerprints that already own an account on this site. */
function profilesOnFile(book: AccountBook, site: string, limit?: number): string[] {
  const owners = book
    .all(site)
    .filter((account) => account.profile && account.status !== "failed")
    .map((account) => account.profile as string);
  return limit ? owners.slice(0, limit) : owners;
}

/**
 * Run one flow per browser, each on its own fingerprint.
 *
 * The stack is the unit of separation: distinct profiles by construction (it
 * throws rather than repeat one), a route each if proxies are given, and a
 * separate browser process per account. Sessions start staggered - five
 * signups landing on the same second is a pattern regardless of how each one
 * looks alone.
 */
async function perBrowser(
  spec: AuthSpec,
  options: AccountRunOptions,
  work: (page: Page, profile: string, log: (m: string) => void) => Promise<AuthOutcome>
): Promise<AccountRunResult[]> {
  const { count = 3, kind = "mixed", engine, proxies, profiles, stagger = [500, 4000], verbose } = options;

  const stack = await openStack({
    kind,
    count: profiles?.length ?? count,
    engine,
    proxies,
    profiles,
    allowSharedProxies: options.allowSharedProxies,
  });
  try {
    return await Promise.all(
      stack.sessions.map(async (session, index) => {
        const profile = session.profile.id;
        const log = (message: string) =>
          verbose && console.log(`  ${profile.padEnd(24)} ${message}`);

        await sleep(index === 0 ? 0 : between(stagger) * index);
        if (options.stop?.()) {
          return {
            ok: false,
            action: "signin" as const,
            site: spec.name,
            email: "",
            challenged: false,
            url: "",
            durationMs: 0,
            detail: "stopped before this browser started",
            profile,
          };
        }
        const page = session.page ?? (await session.context.newPage());
        const outcome = await work(page, profile, log);
        log(`${outcome.ok ? "ok" : "failed"} - ${outcome.detail}`);

        // Only for a browser that actually got in: running "click add to
        // cart" against a login form produces a confusing failure about a
        // missing selector rather than the sign-in problem that caused it.
        if (!outcome.ok || !options.after?.length) return { ...outcome, profile };

        const actions = await runActions(page, options.after, {
          log,
          shotDir: options.shotDir,
          shotPrefix: profile,
          challenge: options.challenge,
        });
        return {
          ...outcome,
          profile,
          actions,
          ok: outcome.ok && actions.ok,
          detail: `${outcome.detail}; ${actions.detail}`,
        };
      })
    );
  } finally {
    await stack.close();
  }
}

/**
 * One signup per browser, each with its own identity.
 *
 * The identity is written to the book *before* the form is submitted, as
 * `pending`. A submit that times out may well have created the account
 * server-side, and an account whose password was never written down is not an
 * account - it is a dead email address that can never be recovered. Better a
 * row that says `pending` than a silent loss.
 */
export async function createAccounts(
  spec: AuthSpec,
  options: AccountRunOptions = {}
): Promise<AccountRunResult[]> {
  const { book, domain } = options;

  return perBrowser(spec, options, async (page, profile, log) => {
    const identity = newIdentity({ domain });
    book?.add({ ...identity, site: spec.name, profile, status: "pending" });
    log(`signing up as ${identity.email}`);

    const outcome = await signUp(page, identity, spec, {
      challenge: options.challenge,
      log,
    });

    book?.update(spec.name, identity.email, {
      status: outcome.ok ? "active" : "failed",
      lastUsedAt: new Date().toISOString(),
      note: outcome.detail,
    });
    return outcome;
  });
}

/**
 * One sign-in per browser, each into the account that browser created.
 *
 * A profile with no account in the book is a failure rather than a fallback to
 * someone else's: borrowing another fingerprint's account is the exact
 * correlation this file exists to avoid.
 */
export async function signInAll(
  spec: AuthSpec,
  options: AccountRunOptions & { book: AccountBook }
): Promise<AccountRunResult[]> {
  const { book } = options;
  // Default to the fingerprints that own an account: signing in from a
  // freshly shuffled stack would mean every browser meeting a site it has
  // never registered with.
  const owners = options.profiles ?? profilesOnFile(book, spec.name, options.count);

  return perBrowser(spec, { ...options, profiles: owners }, async (page, profile, log) => {
    const account = book.forProfile(spec.name, profile);
    if (!account) {
      return {
        ok: false,
        action: "signin" as const,
        site: spec.name,
        email: "",
        challenged: false,
        url: page.url(),
        durationMs: 0,
        detail: `no account on file for ${profile}`,
      };
    }

    log(`signing in as ${account.email}`);
    const outcome = await signIn(page, account, spec, { challenge: options.challenge, log });
    book.update(spec.name, account.email, {
      lastUsedAt: new Date().toISOString(),
      status: outcome.ok ? "active" : account.status,
      note: outcome.detail,
    });
    return outcome;
  });
}

/**
 * One sign-in per browser, from a list of credentials supplied by the caller.
 *
 * The list a real operator already has - exported from somewhere, or typed
 * into a box. Each browser takes the credential at its own index, so the
 * one-account-per-fingerprint rule holds for accounts this module never
 * created. More credentials than browsers is fine; the surplus waits. Fewer is
 * an error rather than a browser sharing a login with another.
 */
export async function signInEach(
  spec: AuthSpec,
  credentials: Credentials[],
  options: AccountRunOptions & { book?: AccountBook; allowSharedLogin?: boolean } = {}
): Promise<AccountRunResult[]> {
  const count = options.count ?? credentials.length;
  if (credentials.length < count) {
    throw new Error(
      `${count} browsers but only ${credentials.length} credentials. ` +
        `Two browsers sharing a login is the correlation this avoids - add credentials or lower count.`
    );
  }

  const queue = credentials.slice(0, count);
  // The same login twice is two browsers on one account wearing different
  // fingerprints, which is the thing this module exists to avoid - and an easy
  // mistake to make when a list is pasted from two places.
  const identifiers = queue.map((c) => (c.email ?? c.username ?? "").toLowerCase());
  const repeated = identifiers.find((id, i) => identifiers.indexOf(id) !== i);
  if (repeated && !options.allowSharedLogin) {
    throw new Error(
      `"${repeated}" appears twice in the credential list - two browsers would share it. ` +
        `Pass allowSharedLogin if that is deliberate, as it is for a site with one published demo account.`
    );
  }

  let cursor = 0;

  return perBrowser(spec, { ...options, count }, async (page, profile, log) => {
    const credential = queue[cursor++];
    log(`signing in as ${credential.email ?? credential.username}`);
    const outcome = await signIn(page, credential, spec, {
      challenge: options.challenge,
      log,
    });

    // Filed against this fingerprint, so a later run puts the same login back
    // in the same browser.
    if (options.book && outcome.ok) {
      const email = credential.email ?? credential.username ?? "";
      const existing = options.book.get(spec.name, email);
      if (existing) {
        options.book.update(spec.name, email, { lastUsedAt: new Date().toISOString() });
      } else {
        options.book.add({
          ...newIdentity({ email, password: credential.password }),
          username: credential.username ?? email,
          site: spec.name,
          profile,
          status: "active",
        });
      }
    }
    return outcome;
  });
}

/**
 * Sign in if this browser has an account, create one if it does not.
 *
 * The shape a real run wants: the first pass registers, every pass after it
 * logs in, and nothing has to know which one this is.
 */
export async function ensureAccounts(
  spec: AuthSpec,
  options: AccountRunOptions & { book: AccountBook }
): Promise<AccountRunResult[]> {
  const { book, domain } = options;
  // Known owners first, then whatever the stack picks for the rest - so the
  // first run registers, and every run after it signs the same browsers in.
  const owners =
    options.profiles ??
    (options.count && profilesOnFile(book, spec.name).length < options.count
      ? undefined
      : profilesOnFile(book, spec.name, options.count));

  return perBrowser(spec, { ...options, profiles: owners }, async (page, profile, log) => {
    const existing = book.forProfile(spec.name, profile);
    if (existing && existing.status !== "failed") {
      log(`signing in as ${existing.email}`);
      const outcome = await signIn(page, existing, spec, { challenge: options.challenge, log });
      book.update(spec.name, existing.email, {
        lastUsedAt: new Date().toISOString(),
        note: outcome.detail,
      });
      if (outcome.ok) return outcome;
      log(`sign-in failed (${outcome.detail}), registering instead`);
    }

    const identity = newIdentity({ domain });
    book.add({ ...identity, site: spec.name, profile: existing ? undefined : profile, status: "pending" });
    const outcome = await signUp(page, identity, spec, { challenge: options.challenge, log });
    book.update(spec.name, identity.email, {
      status: outcome.ok ? "active" : "failed",
      lastUsedAt: new Date().toISOString(),
      note: outcome.detail,
    });
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/**
 * scrapingcourse.com's login challenge.
 *
 * One published account and no registration, so this is the site to check the
 * sign-in path against, not the signup one. It also proves the negative worth
 * knowing: `signIn` with anything but these credentials comes back
 * `ok: false` with the form's own complaint, rather than a hopeful pass.
 */
export const SCRAPINGCOURSE = defineSite({
  name: "scrapingcourse",
  loginUrl: "https://www.scrapingcourse.com/login",
  submit: { login: "#submit-button" },
});

export const SCRAPINGCOURSE_DEMO: Credentials = {
  email: "admin@example.com",
  password: "password",
};
