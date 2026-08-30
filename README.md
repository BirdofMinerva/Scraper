# Scraper

`browsers.ts` gives you 30 believable browser fingerprints, `proxies.ts`
routes them through other IPs, `missions.ts` sends them at a page and brings
back a result, `crawl.ts` splits one site across many browsers, `storage.ts`
puts what they bring back into a database, `stack.ts` opens a batch of browsers
to drive by hand, `turnstile.ts` gets a page through a Cloudflare interstitial,
`accounts.ts` gives each browser its own login, and `actions.ts` says what it
does once it is in. `human.ts` holds the timing and pointer behaviour the rest
of them share, `login-sites.ts` is nine
real login forms to check `accounts.ts` against, `server.ts` puts a dashboard
in front of the lot — `npm run dash` — and `clean.ts` clears the databases
again when the project changes hands.

```ts
import { defineMission, runMission, partition } from "./missions";

const store = sqliteStore({ path: "data.db", table: "pages" });

const results = await runMission(
  defineMission({
    name: "titles",
    url: "https://example.com",
    run: async ({ page }) => ({ title: await page.title() }),
  }),
  { runs: 6, concurrency: 3, store }
);

await store.close();
const { values, failures } = partition(results);
```

Six visits, six different machines, three at a time, rows written to SQLite as
each finishes. Nothing else to set up — launching starts a virtual display if
the machine has none, and SQLite ships with Node.

## Install

```sh
npm install
npx playwright install chromium firefox webkit
npm test
```

Dependencies are `playwright`, `playwright-extra` and
`puppeteer-extra-plugin-stealth`. On a headless Linux box you also want
`apt install xvfb` (see [Display handling](#display-handling)).

---

# missions.ts

A mission is one function that receives a ready page and returns something.
The runner handles picking a fingerprint, launching, retrying, running several
at once, and closing everything afterwards.

## defineMission

```ts
const mission = defineMission({
  name: "product-price",           // used in logs
  url: "https://example.com/p/1",  // navigated to before run(), optional
  profiles: { formFactor: "mobile" }, // restrict fingerprints, optional
  retries: 2,                      // extra attempts after failure (default 2)
  timeout: 60_000,                 // per-attempt budget incl. launch (default 60s)
  persona: undefined,              // pin behaviour instead of sampling it
  proxy: undefined,                // proxy or chain (RunOptions.proxies wins)
  challenge: undefined,            // Cloudflare handling after navigating; false to opt out
  run: async ({ page, human, fetch, proxy, profile, attempt, log }) => {
    await human.scroll(2);
    return page.locator(".price").innerText();
  },
});
```

`defineMission` only exists so the return type of `run` flows through to the
results. `run` receives a `MissionContext`:

| Field | What it is |
| --- | --- |
| `page` | Playwright `Page`, already navigated if `url` was set |
| `context`, `browser` | the objects behind it, if you need more tabs |
| `profile` | the `BrowserProfile` this attempt is wearing |
| `attempt` | 1 on the first try, 2 on the first retry |
| `log` | prefixed logger, silent unless `verbose` |
| `human` | the behaviour helpers below |
| `fetch` | HTTP through the browser's own stack — see [HTTP](#http-through-the-browser) |
| `proxy` | the hops this attempt is routed through, if any |
| `save` | write rows to the run's store mid-mission |
| `challenge` | pass a Cloudflare interstitial, for navigations `run` makes itself |

After navigating to `url`, the runner checks for a Cloudflare interstitial and
passes it before `run` sees the page — see
[turnstile.ts](#turnstilets). An interstitial that does not resolve fails the
attempt, so the retry moves to a new profile and the next proxy, which is what
an unresolved challenge calls for. `challenge: false` leaves it in place, which
is what a probe measuring blocks wants.

A challenge can be served on any request, not just the first, so `ctx.challenge()`
is there for navigations the mission makes itself.

## Running

```ts
runMission(mission, options)   // run one mission N times
runEach(targets, buildMission, options)  // one mission per target
runOnce(mission, nextProfile)  // a single run, retries included
```

`RunOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `runs` | `1` | how many times to run the mission |
| `concurrency` | `3` | how many browsers at once |
| `profiles` | rotation | fixed profiles to use, in order |
| `stagger` | `[0, 2500]` | random delay before each run starts, ms |
| `proxies` | none | proxies or chains to rotate over, one per run |
| `store` | none | where results are written, see [storage.ts](#storagets) |
| `verbose` | `false` | print per-attempt progress |

`runEach` is the "scrape these 50 URLs" shape — each target gets its own
fingerprint, and results come back with the `target` attached:

```ts
const results = await runEach(
  urls,
  (url) => defineMission({ name: "scrape", url, run: ({ page }) => page.title() }),
  { concurrency: 5 }
);
results.forEach((r) => console.log(r.target, r.ok ? r.value : r.error.message));
```

## Results

Nothing throws. Every run comes back as:

```ts
{ ok: true,  value: T,     profile, attempts, durationMs, proxy? }
{ ok: false, error: Error, profile, attempts, durationMs, proxy? }
```

`partition(results)` splits them into `{ values, failures }`. `proxy` is the
route that ran, e.g. `"1.2.3.4:8080 -> 5.6.7.8:3128"`.

Retries always move to a **different** profile, and to the next proxy when
`proxies` is set — a block is usually specific to the fingerprint or the IP
that earned it, and retrying on the same one just spends another attempt.

## HTTP through the browser

Use `ctx.fetch`, not `context.request`. Playwright's `APIRequestContext` is
issued by the Node driver, so it carries **Node's** TLS fingerprint while the
page beside it carries Chrome's. Measured against `tls.browserleaks.com`, same
session, same profile:

```
ctx.fetch          ja4  t13d1517h2_8daaf6152771_cb7bf5808d99   <- Chrome
context.request    ja4  t13d521100_b262b3658495_8e6e362c5eac   <- Node
```

A site that fingerprints TLS sees a browser session whose API calls are not a
browser — a sharper signal than anything the JS patches hide.

```ts
const res = await ctx.fetch("/api/products?page=2");
const data = res.json<Product[]>();     // { status, headers, body, json() }
```

It runs `fetch` inside the page, so it inherits the page's cookies and TLS
stack. That call is subject to CORS; a cross-origin GET that CORS blocks falls
back automatically to loading the URL in a throwaway tab, which is not subject
to CORS and is still the browser's own stack. `fetchViaPage(page)` is the same
helper if you are working outside a mission.

## human

Uniform delays are their own tell: real gaps cluster around a typical value
with a long tail, and never form the flat histogram `Math.random()` produces.
Every delay here is drawn log-normally instead.

```ts
await human.pause(400);          // log-normal delay around 400ms
await human.read();              // dwell in proportion to the page's word count
await human.move("#target");     // curved, variable-speed pointer travel
await human.click("#buy");       // move, dwell, press, release
await human.type("#q", "hello"); // per-key jitter, word pauses, typos
await human.scroll(3);           // multi-notch gestures, reading pauses
await human.moveTo({ x, y });    // the same travel, aimed at a coordinate
await human.clickAt({ x, y });   // and the same press
human.persona;                   // this session's traits
```

These live in `human.ts` and are re-exported here — `turnstile.ts` needs the
pointer, and this file needs `turnstile.ts`, so the shared half sits below
both rather than between them. `humanize(page)` builds the set outside a
mission.

`moveTo` and `clickAt` are for targets no selector reaches — anything inside a
cross-origin iframe, where the only handle is the frame's box in the parent
page.

- **Mouse** follows a quadratic bezier with a randomised control point and
  ease-in/out, overshoots and settles on longer throws, and stays where you
  left it between actions. Click targets land somewhere inside the element,
  never dead centre twice.
- **Typing** varies per key, pauses longer after spaces and sentence
  punctuation, stalls mid-thought occasionally, and sometimes hits an adjacent
  key, notices a beat later, and backspaces.
- **Scrolling** is several wheel notches per gesture with reading pauses,
  occasional scroll-back, and idle pointer drift.

### Persona

Traits are sampled once per attempt and held for the whole session, so a fast
typist stays a fast typist. Re-rolling per action would average every session
into the same statistical profile — which is the thing being avoided.

```ts
type Persona = {
  speed: number;           // <1 quicker than typical, >1 slower
  keyDelay: number;        // mean gap between keystrokes, ms
  typoRate: number;        // chance per character of a corrected typo
  scrollBackRate: number;  // chance per scroll step of re-reading
};
```

Pass `persona` on a mission to pin it, or call `randomPersona()` yourself.
Three concurrent sessions typing the same sentence, measured:

```
mean gap 285ms  sd 383  range 73–1784   speed 1.10   20 keys (18 chars, 1 typo fixed)
mean gap 163ms  sd 136  range 38–552    speed 0.86   20 keys
mean gap 311ms  sd 217  range 83–922    speed 1.47   22 keys (2 typos fixed)
```

---

# proxies.ts

Playwright accepts exactly one upstream proxy per browser. To chain several,
`startProxyChain` runs a small local proxy that the browser talks to and
forwards through each hop in turn:

```
browser -> 127.0.0.1:auto -> hop1 -> hop2 -> target
```

Only the last hop's IP reaches the target, and no single hop sees both the
browser and the destination.

## Using proxies

Anywhere a proxy is accepted, these three shapes work:

```ts
"http://1.2.3.4:8080"                                  // a URL
{ server: "http://1.2.3.4:8080", username, password }  // one hop with auth
[hopA, hopB, hopC]                                     // a chain, browser outwards
```

Per mission, or rotated across runs:

```ts
await runMission(mission, {
  runs: 20,
  proxies: [
    "http://a.example:8080",           // route 1: single hop
    [hopA, hopB],                      // route 2: two hops deep
    { server: "socks5://c.example:1080" },
  ],
});
```

Each run takes the next route, and each retry moves on again. Directly:

```ts
const active = await resolveProxy([hopA, hopB]);
const { browser } = await launchProfile(profile, { proxy: active.proxy });
// ...
await browser.close();
await active.close();          // shuts the local listener down

await withProxy([hopA, hopB], async ({ proxy }) => { /* ... */ });  // same, scoped
```

| Export | Purpose |
| --- | --- |
| `resolveProxy(proxyLike)` | normalise anything above into `{ proxy, hops, close }` |
| `startProxyChain(hops)` | the local listener behind a chain |
| `withProxy(proxyLike, fn)` | run something with the chain up, always tear down |
| `proxyPool(list)` | round-robin over routes |
| `describeProxy(hops)` | `"1.2.3.4:8080 -> 5.6.7.8:3128"` for logs |

A **single** hop skips the local listener entirely and goes straight to
Playwright's native proxy support, so `socks5://` works there. Chains are HTTP
`CONNECT` only — a SOCKS hop inside a chain throws rather than silently
routing around itself. `https://` hops are supported and get TLS-wrapped per
hop.

Each hop's credentials authenticate the CONNECT *to the next hop*, which is
the offset that is easy to get wrong; `dialChain` handles it. Both `https://`
(tunnelled) and plain `http://` traffic go through the chain.

Verified with two local CONNECT proxies, the first requiring auth: hop A saw
only `CONNECT hopB`, hop B saw only `CONNECT example.com:443`, the page loaded,
and wrong credentials on hop A produced `ERR_TUNNEL_CONNECTION_FAILED` rather
than leaking past.

---

# stack.ts

A stack is a batch of browsers, opened together, each wearing a different
fingerprint. Use it when you want to drive them yourself rather than hand work
to `runMission`.

```ts
const stack = await openStack({ kind: "mixed", count: 5 });
for (const { page, profile } of stack.sessions) { /* ... */ }
await stack.close();
```

From the shell, which opens them and holds them open until Ctrl+C:

```sh
npx tsx stack.ts --kind=mobile --count=4
npx tsx stack.ts --kind=mixed --count=6 --url=https://example.com
npx tsx stack.ts --kind=handheld --count=3 --engine=chromium --plan
```

| Option | Values | Default |
| --- | --- | --- |
| `kind` | `mixed`, `desktop`, `mobile`, `tablet`, `handheld` | `mixed` |
| `count` | how many browsers | `3` |
| `profiles` | exact fingerprints, by id or profile; overrides the three above | rotation |
| `engine` | `chromium`, `firefox`, `webkit` | any |
| `url` | open a page in each and navigate | none |
| `proxies` | routes, one per browser, in order | none |
| `allowSharedProxies` | let browsers share a route when routes are short | off |
| `allowDuplicates` | reuse a fingerprint when `count` exceeds the pool | off |
| `--plan` | print the profiles and exit, launching nothing | — |

`handheld` is phones and tablets together. `--plan` is worth using first: it
shows exactly which fingerprints you would get without spending a minute
launching them.

`profiles` is there because the rotation is **shuffled**: asking twice for
"three desktop browsers" gets three different ones, which is right for scraping
and wrong for anything holding state per fingerprint. An account created by
`desktop-edge` has to be signed into by `desktop-edge`, so `accounts.ts`
passes the owners explicitly.

```ts
await openStack({ profiles: ["desktop-edge", "mobile-pixel-7"] });
```

**Asking for more browsers than there are distinct profiles throws**, rather
than quietly repeating one:

```
Asked for 15 browsers but only 10 distinct mobile profiles exist.
Pass allowDuplicates to reuse fingerprints, or lower count.
```

Duplicates share a fingerprint, which is precisely the correlation a stack
exists to avoid — fine when the browsers point at different targets, so it is
available, but it has to be asked for. A failed launch mid-way tears down the
browsers that did start, so a partial stack never leaks processes.

---

# crawl.ts

Point many browsers at one site and get one coherent result. Work is claimed
from a shared queue, rows are merged and deduplicated as they arrive, and every
request across every browser passes one per-host throttle.

```ts
const result = await crawl({
  start: pageRange((n) => `https://site/list?page=${n}`, 1, 60),
  browsers: 30,
  key: (row) => String(row.id),
  store: sqliteStore({ path: "out.db", table: "items" }),
  extract: ({ page }) => page.$$eval(".item", (nodes) =>
    nodes.map((n) => ({ id: n.dataset.id, title: n.textContent }))
  ),
});

result.rows;          // deduplicated, in discovery order
result.stats;         // visited, failed, byProfile, relaunches, duplicatesDropped
result.failures;      // url, error, attempts
```

| Option | Default | Meaning |
| --- | --- | --- |
| `start` | required | URLs to begin with; `pageRange()` builds a numbered set |
| `extract` | required | what to pull from each page; return rows or nothing |
| `browsers` | `4` | how many fingerprints work the queue |
| `kind` / `engine` | `mixed` / any | which profiles the stack draws from |
| `proxies` | none | routes, one per browser; too few throws |
| `allowSharedProxies` | off | let browsers share an exit IP |
| `stop` | none | checked between pages; true winds the crawl down |
| `key` | none | row identity; repeats are dropped |
| `store` | none | rows land here as they are found |
| `retries` | `2` | requeue attempts per URL |
| `maxPages` | ∞ | stop after this many successful pages |
| `perHostDelayMs` | `250` | minimum gap between requests to one host, shared |
| `timeout` | `45s` | per-page budget |
| `challenge` | on | pass a Cloudflare interstitial per page; `false` to leave it |

## Why it is built this way

**Work is claimed, not sharded.** Handing browser 7 pages 21–30 means the run
lasts as long as its unluckiest shard — one slow proxy and everything waits.
Each browser instead takes the next URL nobody holds, so a fast browser simply
does more. Across 80 pages and 6 browsers the split came out 11–16 pages each,
unprompted.

**Discovery feeds the same queue.** `extract` gets `enqueue()`, so a crawl can
start from one URL and follow pagination or links; discovered URLs are
deduplicated against everything already seen, so cycles cannot loop.

**Rows are merged, not concatenated.** With `key`, an item found on two
overlapping pages is stored once, and `stats.duplicatesDropped` tells you how
often that happened — a useful signal that your pagination overlaps.

**One throttle for all browsers.** Thirty browsers with no shared limiter is
thirty simultaneous requests to one origin: rude, and the fastest way to earn a
block that has nothing to do with fingerprints. `HostLimiter` reserves each
slot synchronously before awaiting, so concurrent workers queue instead of all
reading the same timestamp and firing together.

## Failure handling

A failed URL goes back on the queue with an attempt counted against it, and is
reported in `failures` only once it runs out. Verified at 40 pages with one in
five requests failing at random: all 200 items still collected, exactly once,
with every browser contributing.

**A dying browser is the case worth knowing about.** When one crashes, its
worker is holding a URL and faces a page that can no longer load anything.
Measured before this was handled: **one crash lost 170 of 200 items** — the
dead worker kept claiming URLs and burning their retries in seconds. Now a
browser-level failure is told apart from a page-level one: the URL goes back
untouched (`returnUnused`, no attempt charged, front of the queue), the browser
is relaunched on the same profile, and the worker carries on. After two failed
replacements it retires rather than poisoning the queue. Re-measured: 12 of 12
pages, 60 of 60 items, zero failures, `relaunches: 1`.

---

# turnstile.ts

Cloudflare's interstitial — the "Performing security verification" page — with
a Turnstile checkbox on it. `passChallenge` waits it out and presses the
checkbox when it is asked to.

```ts
import { gotoAndPass } from "./turnstile";

const outcome = await gotoAndPass(page, "https://example.com/gated");
if (!outcome.passed) throw new Error(outcome.detail);
```

| Export | Purpose |
| --- | --- |
| `passChallenge(page, options?)` | wait out the interstitial on the current page |
| `gotoAndPass(page, url, options?)` | navigate, then the same |
| `challengeState(page)` | `clean`-ish read: `clear`, `waiting` or `interactive` |
| `widgetBox(page)` | the widget's box in the top page's coordinates |
| `isChallenged(page)` | is the interstitial up |
| `clearanceToken(page)` | the `cf_clearance` cookie, if one was issued |

## Where it runs on its own

Nothing has to call this file for a challenge to be handled. It is wired into
every navigation the toolkit makes:

| Caller | When | Opt out |
| --- | --- | --- |
| `runMission` | after navigating to `mission.url` | `challenge: false` on the mission |
| `MissionContext.challenge()` | whenever the mission asks | — |
| `crawl` | after every page load | `challenge: false` in the options |
| `accounts.ts` | every navigation *and* every form submit | `challenge: false` in the options |

The two probes opt out (`challenge: false` on their missions). A probe measures
what the site served, and solving the challenge would turn a `challenged`
verdict into a `clean` one — deleting the finding rather than reporting it.

In `runMission` and `crawl` an unresolved challenge fails the attempt rather
than handing an interstitial to `extract`: the URL is requeued onto another
browser and another route, which is the only thing that helps. Twelve rows of
challenge-page HTML in the store is the outcome that is worth avoiding, and it
is the one that looks like success.

The cost when there is no challenge is a single `page.evaluate` per navigation.

`ChallengeOptions` are `timeout` (45s), `attempts` (3 presses), `human` (reuse
a session's persona) and `log`. Nothing throws — a challenge that did not
resolve comes back as `{ passed: false, detail }`, the same shape as everything
else here.

```ts
{ passed, challenged, clicks, waitedMs, clearance?, detail }
```

`challenged` is the field worth reading. It is `false` when the page was never
challenged at all, so "solved it" stays distinguishable from "there was nothing
there" — a probe that reports a pass on every page is not measuring anything.

## What actually gets it through

Three things, and only the third is in this file.

**A real browser, headed.** Everything `browsers.ts` already does. Against a
headless launch the widget renders, the click lands, and nothing happens.

**A pointer that travelled.** The widget reads the movement leading into the
press, not the press. `human.clickAt` arcs onto the checkbox over 20-odd
positions with log-normal gaps; `page.mouse.click` teleports. This is why
`moveTo`/`clickAt` were added to `human` rather than the file doing its own
mouse work — same curves, same persona, one implementation.

**Finding the checkbox.** The widget is a cross-origin iframe inside a
**closed** shadow root, so `page.$("iframe[src*=cloudflare]")` returns `null`
while the thing is plainly on screen. Going the other way works: find the frame
by URL in `page.frames()`, then ask Playwright for the element hosting it,
which crosses the shadow boundary from the inside.

```ts
const frame = page.frames().find((f) => f.url().includes("challenges.cloudflare.com"));
const box = await (await frame.frameElement()).boundingBox();
```

Two smaller details that were each a failed run first:

- **Re-measure between the move and the press.** The travel takes about a
  second and the interstitial reflows underneath it. Pressing the coordinate
  measured before the move is how a click lands beside the checkbox.
- **A widget under 100×40 is the invisible variant.** It resolves itself, and
  clicking it is both pointless and a tell. `challengeState` reports it as
  `waiting`, and nothing presses it.

The state is read from `window._cf_chl_opt`, the challenge script's own config
object, set inline before anything renders — steadier than the title, which is
localised, or the body text, which differs between challenge templates.

## What it is not

Not a Turnstile solver. Nothing here computes a token, replays one, or talks to
a solving service: the widget is satisfied by the browser and the pointer, or
it is not satisfied. Against a challenge that has already decided the IP is bad
— `cType: "interactive"` with an image grid, or a hard block — this waits its
timeout out and reports `passed: false`, which is the honest answer. A better
route is what changes that, the same as everywhere else in these files.

---

# accounts.ts

One account per browser: created by that browser, signed into by that browser,
and filed against the fingerprint that owns it.

```ts
import { defineSite, accountBook, createAccounts, signInAll } from "./accounts";

const site = defineSite({
  name: "demo",
  loginUrl: "https://demo.example/login",
  signupUrl: "https://demo.example/register",
  accept: ["#terms"],                 // checkboxes to tick before submitting
});
const book = accountBook({ path: "accounts.db" });

await createAccounts(site, { count: 5, kind: "desktop", book });  // five signups
await signInAll(site, { book });                                  // each back into its own
```

Five browsers, five identities, five signups, one row each in `accounts.db`.
`signInAll` needs no `count`: it signs in the fingerprints the book says own an
account.

| Export | Purpose |
| --- | --- |
| `newIdentity(overrides?)` | email, password, username, names |
| `newPassword(length?)` | upper/lower/digit/symbol, from `node:crypto` |
| `defineSite(spec)` | describe a site's forms |
| `signUp(page, identity, spec, opts?)` | register, on this page |
| `signIn(page, credentials, spec, opts?)` | log in, on this page |
| `isSignedIn(page, spec?)` / `formError(page)` | read the outcome |
| `findField(page, kind, spec?)` | the field and the selector that found it |
| `accountBook({ path, table? })` | where accounts live between runs |
| `createAccounts(spec, opts)` | one signup per browser |
| `signInAll(spec, opts)` | one sign-in per browser, into its own account |
| `ensureAccounts(spec, opts)` | sign in, or register if this browser has no account |
| `signInEach(spec, credentials, opts)` | one supplied credential per browser |

All four take `after` — an [action list](#actionsts) each browser runs once it
is signed in — and `shotDir`, where its screenshots land.

Nothing throws. Every flow returns
`{ ok, action, site, email, identity?, challenged, url, durationMs, detail }`,
and `detail` carries the site's own words when it refused.

Credentials are `{ password, email?, username? }` — whichever identifier the
form actually has is the one that gets typed. Most real login forms take a
username in a plain text input, and a flow that only looked for an email field
reports "no login form" for a form that is plainly there.

## One account per fingerprint

This is the whole premise, and it is the reason the module exists rather than
a `page.fill` in each script. Five accounts created by five browsers are five
users. Five accounts created by one browser, or one account signed into from
five, is one user behaving strangely — and that correlation sits in the site's
own data no matter what the fingerprints claim.

So it is enforced structurally, not by convention:

```sql
CREATE UNIQUE INDEX accounts_profile ON accounts (site, profile) WHERE profile IS NOT NULL;
```

A second account for a fingerprint that already has one throws. The index is
partial, so a pool of unassigned identities is still fine. `(site, email)` is
the primary key, so the same fingerprint can hold one account per site and no
email is registered twice.

**The identity is written before the form is submitted**, as `pending`, and
updated to `active` or `failed` afterwards. A submit that times out may well
have created the account server-side, and an account whose password was never
written down is not an account — it is a dead email address. A row saying
`pending` is worth more than a clean table.

## Finding the form

A spec that has to name every selector is a spec nobody writes for the second
site, so fields are discovered and `fields` is the escape hatch:

```ts
FIELD_SELECTORS.email      // input[type=email], input[name=email], #email, ...
```

Order is the whole trick. `input[type=email]` comes before `[name*=mail]`
because a *confirm email* field matches the latter too; the password list
excludes anything matching `confirm`, and the confirmation list matches only
those. `findField` returns the selector along with the locator, because
`human.type` works in selectors and two ways of typing into a field is one too
many.

## Reading the outcome

`isSignedIn` deliberately does not test whether the URL changed. A form that
redirects back to itself with an error also changes URL, and a site that signs
you in on the same path does not. What generalises is a **sign-out affordance**
— it only exists for a session that exists — with a visible password field as
the counter-signal.

Three details, each of which a real site taught:

- **Presence, not visibility.** saucedemo keeps its "Logout" in a burger menu
  that is closed, and OrangeHRM behind a dropdown. A hidden sign-out link is
  still a sign-out link; a signed-out page does not have one at all.
- **By its own words as well as its href.** guru99's link says `SIGN-OFF` and
  points at `index.php`.
- **It polls, for six seconds.** This is asked right after a submit, and a
  success page is usually one redirect and a render away. A single look
  answered "no" for sites that were signing us in perfectly well.

Some sites give a generic reader nothing to work with: rahulshettyacademy drops
you into a shop with no account UI at all. That is what `spec.signedIn` is
for, and using it there is not a workaround — no heuristic can read a page that
does not say anything.

The failure modes are told apart, which is the same discipline as `detect.ts`:

| `detail` | Meaning |
| --- | --- |
| `refused: <site's message>` | the site saw the credentials and said no |
| `challenge not passed: …` | never reached the site; a route problem, not a password one |
| `no login form on the page` | the page is not what we thought it was |
| `submitted, still not signed in` | it went through and nothing came back |

## Typing a password

Fields are typed with `human.type`, which makes typos and corrects them. That
behaviour is worth having and is also why every field is **read back after
typing** and repaired with `fill` if it drifted. A correction that did not take
leaves an account whose password is not the one in the book, and that is
unrecoverable rather than merely wrong.

## The submit

Buttons are found the same way fields are, and the list has to cover a button
with **no `type` attribute sitting outside any `<form>`** —
practicetestautomation.com's is exactly that, matching neither
`button[type=submit]` nor `form button`. When no button matches at all, the
password field gets an `Enter`, which is what a person does anyway.

Forms that are written by script arrive late: at `domcontentloaded` OrangeHRM's
React demo has no fields at all, so both flows wait for a password field to
exist before discovering anything.

The wait for the response is armed **before** the click:

```ts
const navigated = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame() });
await human.click(submit);
await navigated;
```

Checking straight after the click reads the form we just left, which has no
challenge on it. That is exactly how a Cloudflare interstitial served on the
login POST gets reported as "submitted, still not signed in" — the form is
gone, nothing on the page mentions credentials, and the flow concludes the
password was wrong. `test/accounts-flow.test.ts` serves that response
deliberately.

## Live results: nine practice logins

`login-sites.ts` is a catalogue of real sites that publish their own
credentials, and `login-test.ts` signs in to each of them twice:

```sh
npx tsx login-test.ts
npx tsx login-test.ts --only=saucedemo,orangehrm
npx tsx login-test.ts --list
```

Twice, because "signed in" on its own proves nothing — a detector that answers
yes to everything passes the first half. Each site is asked with its published
credentials and then with a wrong password, and only a site that accepts one
and refuses the other counts. 2026-08-30, direct route, one headed Chrome:

```
site                    signed in   wrong password
the-internet            yes         refused: Your password is invalid!
expandtesting           yes         refused: Your password is invalid!
saucedemo               yes         refused: Epic sadface: Username and password do not match
practicetestautomation  yes         refused: Your password is invalid!
quotes-toscrape         yes         accepts anything, as expected
parabank                yes         refused: The username and password could not be verified.
rahulshetty             yes         submitted, still not signed in
orangehrm               yes         refused: Invalid credentials
guru99-tours            yes         submitted, still not signed in

9/9 sites signed in and refused a wrong password
```

Two of the refusals carry no message: rahulshetty and guru99 re-render the
login page with nothing an error selector matches, so `detail` falls back to
*submitted, still not signed in*. That is the honest reading — the site said
no without saying why.

The first run was **3 of 9**, and every one of the six failures was a gap in
`accounts.ts` rather than a site being difficult:

| Site | Reported | Actually |
| --- | --- | --- |
| orangehrm | `no login form on the page` | React had not written the fields yet |
| practicetestautomation | `no submit button` | button with no `type`, outside any `<form>` |
| saucedemo | `submitted, still not signed in` | signed in; sign-out link hidden in a closed menu |
| guru99-tours | `submitted, still not signed in` | signed in; the link says `SIGN-OFF` |
| expandtesting | `submitted, still not signed in` | signed in; the check ran before the redirect landed |
| rahulshetty | `refused: Old password …` | the site had changed its published password |

Only the last of those was the site's doing, and it was reported correctly —
the form's own words came back in `detail`, which is how it got noticed at all.
The fixes are all in [Reading the outcome](#reading-the-outcome) and
[The submit](#the-submit), and each one has a fixture shape in
`test/accounts-flow.test.ts` so it stays fixed without the network.

`quotes-toscrape` is in the catalogue as the control: its login accepts any
credentials, so it is flagged `acceptsAnything` and its wrong-password run is
expected to succeed. A single site that behaves that way is what keeps
"refused everything" from looking like a pass.

## Sites

`SCRAPINGCOURSE` ships with the module: one published demo account and no
registration, so it is the site to check the sign-in path against. The
`login` step of `challenges.ts` runs it both ways — the demo credentials pass,
a wrong password is refused — because a flow that reports success on both is
reporting nothing.

---

# actions.ts

What a browser does once it is signed in.

```ts
import { runActions } from "./actions";

const outcome = await runActions(page, [
  { do: "visit", url: "https://site/inventory" },
  { do: "click", selector: "#add-to-cart" },
  { do: "read", name: "cart", selector: ".cart-badge" },
  { do: "shot", label: "cart" },
]);

outcome.data;   // { cart: "1" }
outcome.shots;  // ["runs/ab12cd34/desktop-chrome-04-cart.png"]
```

A session that logs in and stops is a login, not a session. The interesting
part is what happens next — and a site watching for automation is watching that
part too, so every step goes through `human`: clicks arrive with pointer travel
behind them, typing has per-key timing, scrolling is wheel notches with reading
pauses.

| Step | What it does |
| --- | --- |
| `visit` | navigate, passing any challenge that appears |
| `click` | move the pointer there and press |
| `type` | click into a field and type, with the usual jitter |
| `scroll` | wheel gestures with reading pauses |
| `wait` | for a selector, or for a number of milliseconds |
| `read` | pull a value into the run's results, by name |
| `shot` | a picture of what this browser is looking at |

Every step takes `optional: true`, which changes what a failure means —
"close the cookie banner if there is one" is a real step and its absence is not
a failure. Without it, a failed step **stops the list**: carrying on after a
click that never landed produces results that look fine and mean nothing.

```ts
{ ok, steps: [{ step, do, ok, ms, detail, shot? }], data, shots, detail }
```

Nothing throws. `detail` on a failure is `step 2 (click) failed: …`, because
these lists are written in a web form and the step number is what turns the
message into a fix.

## read

`read` is how a bot brings something back. `{ do: "read", name: "price",
selector: ".price" }` puts one value under `price`; `all: true` collects every
match; `attribute: "href"` takes an attribute instead of the text. Each name
becomes a **column in the results table**, so a run where six accounts each
read their own balance is a table rather than six log lines.

## shot

Screenshots are the "view" half — what this browser was actually looking at,
which is the only honest answer to "did it work?" for a session you cannot
watch. They are named `<profile>-<step>-<label>.png`, so a gallery of eight
pictures says which fingerprint took each one, and the step number is padded
because ten screenshots sorted as text otherwise put 10 before 2.

The label comes from a text box and ends up in a filename, so it is stripped to
`[a-z0-9_-]` — `../../etc/passwd` becomes `etc-passwd`.

## Typed text is never logged

`describeAction` counts characters rather than printing them:

```
type 15 characters into #password
```

These lines go to the terminal panel and the run log, and an action list
carries search terms, messages, and occasionally a password typed into the
wrong row of the form.

## With accounts

`createAccounts`, `signInAll`, `signInEach` and `ensureAccounts` all take
`after`, run per browser on its signed-in page:

```ts
await signInEach(spec, credentials, {
  after: [{ do: "visit", url: shop }, { do: "click", selector: "#buy" }],
  shotDir: "runs/tonight",
});
```

The list only runs for a browser that actually got in. Running "click add to
cart" against a login form produces a confusing failure about a missing
selector rather than the sign-in problem that caused it. Results come back on
`result.actions`, and the browser's overall `ok` is the sign-in **and** the
steps.

---

# The dashboard

A local web UI for the whole toolkit: two modes, a form each, and the run's
output streaming into a terminal panel.

```sh
npm run dash                              # http://127.0.0.1:8420
npx tsx server.ts --port=9000             # somewhere else
```

Three files. `server.ts` is `node:http` — no framework, no build step — and
serves `dashboard.html`, a single page with no dependencies of its own.
`jobs.ts` holds the two run shapes and, crucially, the validation: a config
that cannot work is refused in the form rather than three minutes into a crawl.

**It binds to 127.0.0.1 and has no authentication**, because it can launch
browsers, write files and use whatever proxies it is handed. `--host` will bind
elsewhere and says what that means when you do.

## Scrape mode

Start URLs and/or a numbered range (`{n}` is the page number), a repeating-row
selector, and a field list — name, selector within the row, and an optional
attribute to read instead of the text. Plus a selector for links to follow,
which join the same queue, and a field to deduplicate on.

Everything below that is `crawl`'s options with a label: browsers, kind,
engine, per-host delay, retries, max pages, timeout, challenge handling, and a
SQLite file to write to. Rows appear in the results table as the run finishes,
and in the database as they are found.

## Bot mode

The same idea over `accounts.ts`. The action decides where the logins come
from:

| Action | Where the logins come from |
| --- | --- |
| from the credential list | the box below, one line per browser |
| the preset's published login | the catalogue site's demo account, shared by every browser |
| accounts on file | the book, each browser into the account it owns |
| create an account per browser | generated identities, one each |
| sign in or register | the book, registering for browsers that have none |

The **credential list** is `user:pass` per line, `#` comments ignored, browser 1
takes line 1. Splitting on the first separator only, so a password containing a
colon survives. Two browsers cannot be given the same login: that is the
correlation the module exists to avoid, and it is the easiest paste mistake to
make. The one deliberate exception is the preset action — those practice sites
have exactly one demo account each — and it says so in the log when it runs.

The site itself is either a preset from `login-sites.ts` (which fills the URLs
and carries a note about what makes that site awkward) or described by hand:
login and signup URLs, checkboxes to tick, selector overrides, and *signed in
when the URL contains* for sites with no sign-out link to find.

## Once signed in

Under the login list is a step builder — a row per action, `do` from a
dropdown, and the fields that step needs. Rows drag to reorder, because these
run in sequence and *click then read* is a different bot from *read then
click*. Each row has a checkbox for **optional**, and the *example* button
fills in a working list against saucedemo.

The whole vocabulary is [actions.ts](#actionsts): visit, click, type, scroll,
wait, read, shot. Every `read` name becomes a column in the results table; every
`shot` becomes a picture in the gallery.

## Screenshots

Bot runs write their screenshots to `runs/<run id>/`, and the panel beside the
results has a **Screenshots** tab: thumbnails named for the browser that took
them, click to open full size, Escape or click again to close. A run that
produced any opens on that tab, because a picture nobody looked at is not worth
having taken.

This is the closest thing to watching the browsers work. They run headed on a
virtual display, so there is nothing to watch directly; a `shot` step at the
point you care about is what "view" means here.

## An IP per browser

Proxy routes are `label=url` per line, hops separated by `>`, the same syntax as
`PROXIES` everywhere else — **one route per browser, in order**.

Fewer routes than browsers now **throws** rather than quietly reusing one, the
same rule that already applied to fingerprints:

```
4 browsers but 2 routes - two browsers would leave from the same IP.
Add routes, lower the browser count, or pass allowSharedProxies.
```

Silently sharing an exit is indistinguishable from a run that had an IP each,
which makes every conclusion drawn from it unsafe — including "this fingerprint
got blocked", when what got blocked was the address two browsers were sharing.
The same list with one proxy in it twice is refused for the same reason. The
form shows the arithmetic as you type: *3 routes for 3 browsers — an IP each*.

`allowSharedProxies` (a checkbox, or the `openStack`/`crawl`/accounts option)
allows it when it is deliberate.

**Check each route's exit IP before starting** spends a browser per route on
`ipinfo.io` first and reports what each one comes out as:

```
home: 203.0.113.x · ASxxxxx a residential ISP
vps:  198.51.100.x · ASxxxxx a host
b:    203.0.113.x - same exit as home, so those browsers share an IP
```

Worth the minute before a long run: a proxy that is quietly dead, or two
entries that resolve to the same exit, produce results attributed to a route
that never carried them.

## The terminal panel

Every line the run produces, with a level and a timestamp: progress in the
accent colour, successes green, failures red. `console` output from inside the
toolkit is captured too, through `AsyncLocalStorage`, so lines land in the run
that produced them even with two runs going — attributing one browser's errors
to another run would be worse than not capturing them at all.

There is *errors only*, *follow*, and *clear*; the stream replays from the start
when a page is opened or reloaded, so a run watched from a second tab, or read
back from the history, shows the whole thing rather than an empty panel.

**Stop** is cooperative: the crawl finishes the page in flight and stops before
claiming the next URL, and a bot run stops before the next browser starts.
Nothing is killed mid-page, so no browser is left with a page open.

## API

The page is a client of the same HTTP API, so anything it does can be scripted:

| Route | Purpose |
| --- | --- |
| `GET /api/options` | profiles, kinds, engines, login presets |
| `GET /api/accounts?path=` | the account book, passwords masked |
| `POST /api/runs` | validate a config and start it; 400 with a message if not |
| `GET /api/runs` | history |
| `GET /api/runs/:id/events` | SSE: `replay`, `log`, `stats`, `progress`, `done` |
| `GET /api/runs/:id/shots/:name` | a screenshot; the name is rebuilt, never joined |
| `POST /api/runs/:id/stop` | ask a run to wind down |

---

# storage.ts

Give a run a `store` and whatever a mission returns is written as it comes
back — nothing is held in memory until the end, so an interrupted crawl keeps
everything it already collected.

```ts
const store = sqliteStore({ path: "data.db", table: "products" });
await runMission(mission, { runs: 200, store });
await store.close();
```

## What gets stored

The mission's return value, shaped by `toRows`:

| Returned | Stored |
| --- | --- |
| `{ title, price }` | one row |
| `[{...}, {...}]` | one row each |
| `"Example Domain"` | one row, `{ value: "Example Domain" }` |
| `null` / `undefined` | nothing |

Every row also gets `_mission`, `_profile`, `_proxy`, `_target`, `_attempts`,
`_duration_ms` and `_scraped_at`, so you can tell later which fingerprint and
which exit IP produced a given row — which is what you want when a subset of
rows turns out to be blocked-page HTML.

For missions that page through results, write as you go with `ctx.save` and
return nothing (the runner stores the return value too, so doing both stores
twice):

```ts
run: async ({ page, save, fetch }) => {
  for (let p = 1; p <= 10; p++) {
    const batch = (await fetch(`/api/items?page=${p}`)).json<Item[]>();
    if (batch.length === 0) break;
    await save(batch);
  }
},
```

## Stores

| Store | Notes |
| --- | --- |
| `sqliteStore({ path, table?, key? })` | Node's built-in driver — no dependency, no server |
| `jsonlStore(path)` | one JSON object per line, append-only, safe to `tail -f` |
| `csvStore(path, columns?)` | header from the first row unless you pass `columns` |
| `memoryStore()` | keeps rows on `.rows`, for tests and small runs |
| `multiStore(a, b, …)` | write to several at once, e.g. SQLite plus a JSONL backup |
| `customStore(name, save, close?)` | anything else — Postgres, an HTTP endpoint, S3 |

### SQLite specifics

The table is created from the first batch and **widened automatically** when
later rows carry new fields. Scraped shapes drift, and a crawl that dies on an
unexpected field three hours in is worse than a sparse column.

Column affinity is inferred from the first non-null value — integers land in
`INTEGER`, decimals in `REAL`, everything else in `TEXT`, with objects and
arrays JSON-encoded. Without that, a scraped count comes back as `1.0` and
`ORDER BY price` sorts lexically, which is the kind of wrong you find late.

Pass `key` to make rows identifiable, and re-running a crawl updates instead of
duplicating:

```ts
sqliteStore({ path: "data.db", table: "products", key: (row) => String(row.url) })
```

`key` becomes the primary key and writes use `INSERT OR REPLACE`. Without it
rows get an autoincrementing `_id` and every run appends.

### Postgres and friends

`customStore` takes any async writer:

```ts
const pg = new Client();
await pg.connect();

const store = customStore(
  "postgres",
  async (rows) => {
    for (const row of rows) {
      await pg.query("INSERT INTO scraped (data) VALUES ($1)", [row]);
    }
    return rows.length;
  },
  () => pg.end()
);
```

Rows arrive with the `_`-prefixed metadata already attached.

---

# clean.ts

Clearing out what runs leave behind — one database, several, or all of them.

```sh
npx tsx clean.ts --list                  # what is here, and what is in it
npx tsx clean.ts challenges.db           # one
npx tsx clean.ts field-test.db hard-test.db
npx tsx clean.ts --all
npx tsx clean.ts --all --empty           # keep the files and their schema
npx tsx clean.ts --handoff               # everything, before giving this away
npx tsx clean.ts --all --dry-run
```

`npm run clean -- --list` works too; the `--` is npm's, not ours.

```
challenges.db               448 KB  products 2158  [session data]
dashboard-accounts.db        16 KB  accounts 1  [PASSWORDS]
dashboard.db                 24 KB  rows 48
field-test.db                12 KB  results 11  [+2 sidecar]
hard-test.db                492 KB  books 1000  [+2 sidecar]
----------------------------------------------------------------------------
5 databases, 3227 rows, 1.1 MB
dashboard-accounts.db holds passwords in plain text - clear before sharing this directory.
```

## Delete or empty

Deleting removes the file **and its `-wal`, `-shm` and `-journal`**. Removing
the database alone leaves the log files beside it, which is both untidy and
confusing later.

`--empty` keeps the file and its schema and removes the rows, for a database
something else is pointed at. Dropping the file and letting it be recreated
usually works, but a store holding an open handle keeps writing to the deleted
inode and the rows go somewhere nobody can read. Emptying also:

- resets `sqlite_sequence`, or the next run's `_id` starts at 2159 and the
  numbering still tells whoever gets the project how much was here;
- runs `VACUUM` afterwards, or the pages stay allocated and the file looks
  untouched to anyone glancing at the directory.

## The two flags

`PASSWORDS` and `session data` are separate on purpose. A `password` column is
a login someone could use; a `cookies` column is usually a trace, and
`field-test-live.db` has one holding cookie *names*. Labelling that "holds
credentials" spends the warning that `accounts.db` actually needs.

## Handing the project on

`--handoff` clears every database plus the exports and `proxies.txt`. That last
one is there because a route line is `label=http://user:pass@host` — someone
else's proxy credentials, in a file whose name suggests it holds none.

Two things worth knowing when packing this up:

- **`accounts.db` holds passwords in plain text.** It has to: a browser has to
  type them. `.gitignore` keeps it out of a repository and does nothing about a
  zip file or a shared folder.
- **Scraped rows do not carry proxy credentials.** `_proxy` comes from
  `describeProxy`, which is `host:port` per hop and drops any userinfo, so a
  results database is safe to pass on in that respect even when the run went
  through an authenticated proxy.

## Refusing to be casual about it

Nothing is deleted without a confirmation that has to be **typed** —
`Type "clean" to confirm:` — because this is not undoable and `--all` is one
character from `--list`. `--yes` skips it, and is *required* when stdin is not
a terminal: a script that would have prompted stops and says so rather than
guessing. `--dry-run` prints the whole plan and changes nothing.

`--list` is the safe first command, and it leaves nothing behind either.
Opening a WAL database read-only creates `-wal` and `-shm` beside it, so a
plain listing would add two files per database and then report them as
`+2 sidecar` — a listing that changes what it is listing. It opens with the
`immutable=1` URI instead, falling back to a normal read-only open for a
database that already has a `-wal`, where immutable would not see rows still
sitting in that log. Undercounting rows in a report someone is about to delete
things from is the worse failure.

## Why it is not a button in the dashboard

The dashboard has no authentication — it is bound to localhost and it can
already launch browsers and write files. "Delete every database" is a different
class of thing to hand an unauthenticated local service, and the handoff case
is a terminal command anyway.

---

# Tests

```sh
npm test            # everything: unit, then browser-backed
npm run test:unit   # pure logic only, ~0.4s, no browsers
npm run test:browser  # the browser-backed files, serially
npm run test:field  # probe detection pages and report
npm run dash        # the dashboard on http://127.0.0.1:8420
npm run clean -- --list   # what data is on disk; --handoff clears it
npx tsx login-test.ts  # sign in to nine real practice sites, both ways
```

328 tests on `node:test`, no framework dependency. 230 of them are pure logic
(`browsers`, `storage`, `proxies`, `routes`, `detect`, `targets`, `accounts`,
`login-sites`, `jobs`, `clean`, `actions`) and run in under half a second; the
rest launch real browsers and take about seven minutes.

The browser files run with `--test-concurrency=1`. `node:test` parallelises
files by default, and with crawl opening six browsers while stack, missions and
stealth open their own, launches begin failing under contention — tests that
pass alone and fail together. Serialising that half made it deterministic.

| File | Covers |
| --- | --- |
| `browsers.test.ts` | catalog coherence, UA syncing, launch options, selection, evasion sets |
| `stealth.test.ts` | hardened vs unhardened shape parity in a live browser |
| `storage.test.ts` | row shaping, SQLite types and upserts, CSV quoting, composition |
| `proxies.test.ts` | chain ordering, per-hop auth, teardown, SOCKS rejection |
| `routes.test.ts` | proxy config parsing, `--only` selection, credential masking |
| `detect.test.ts` | verdicts and vendor identification, from real captured responses |
| `missions.test.ts` | running, retries, timeouts, filters, store integration |
| `stack.test.ts` | stack planning, pool exhaustion, opening and teardown |
| `crawl.test.ts` | queue claiming and requeueing, host throttling, exact-once merging, crash recovery |
| `turnstile.test.ts` | widget discovery through a closed shadow root, pressing, budgets |
| `accounts.test.ts` | identity generation, the book's uniqueness rules, selector ordering |
| `accounts-flow.test.ts` | signup and sign-in in a real browser, challenges mid-flow, awkward form shapes, actions after login, a browser each |
| `login-sites.test.ts` | the practice-login catalogue: unique names, https, `--only` |
| `jobs.test.ts` | dashboard configs: credential lists, page ranges, one IP per browser |
| `server.test.ts` | the HTTP API, the event stream, and one real run through it |
| `clean.test.ts` | listing, deleting with sidecars, emptying, and leaving no trace |
| `actions.test.ts` | action lists from a half-filled form, and screenshot filenames |
| `targets.test.ts` | catalogue integrity, target filters, control injection |

What they assert, beyond the obvious:

- **Fingerprint coherence** — no Apple GPU on a Windows profile, no Adreno on a
  desktop, `Direct3D` only on Windows, locale and timezone in the same region.
- **Shape parity** — a hardened context must differ from a vanilla one only in
  the values it claims, never in descriptors, function identity, own-vs-
  prototype placement or key order.
- **The hardening script runs to completion** in a real page. The value tests
  all passed while a third of it was dead.
- **Chain integrity** — each hop's credentials authenticate the CONNECT to the
  *next* hop, and a rejected hop fails the tunnel rather than leaking past it.
- **Verdict predictions** — `edge-blocked` on zillow-direct has to be followed
  by `clean` on zillow-home, or the diagnosis was wrong.
- **Pool exhaustion** — asking for more browsers than distinct profiles throws
  rather than quietly repeating a fingerprint.
- **The pointer moved.** The stand-in Turnstile widget counts the `mousemove`
  events that reach it and refuses to call five too few — a change that made
  `clickAt` teleport would still solve the page, so the page has to say how it
  was clicked.
- **One account per fingerprint**, at the database level: a second account for
  a profile that has one throws, and three browsers signing back in must each
  land on the account they created, not merely on *an* account.
- **A challenge on the submit response.** The fixture site can serve an
  interstitial as the answer to `POST /login`, which is the shape that reads as
  wrong credentials if nothing waits for the navigation.
- **The password typed is the password stored** — sign up with a generated
  password, then sign in with it, in a real browser. `human.type` corrects its
  own typos; this asserts the correction took.
- **The page agrees that it was clicked.** The fixture's counter only moves on
  a real click, so the assertion is the page's own account of what happened
  rather than ours. The same trick for typing: `#echo` is filled by an `input`
  event, so it stays empty if the value was assigned instead of typed.
- **A failed step stops the list, and an optional one does not.** Carrying on
  after a click that never landed produces results that look fine and mean
  nothing; carrying on past a cookie banner that was not there is the whole
  point of `optional`.
- **A screenshot label cannot escape its directory**, and the endpoint that
  serves them refuses `../`, `..%2f` and anything that is not a `.png` inside
  the run's own folder.
- **A config that cannot work is refused in the form.** A dedupe key that is
  not one of the fields, a page range with no `{n}`, four browsers behind two
  proxies, the same login twice in a list — each is a sentence in the UI rather
  than a run that fails late or, worse, one that succeeds while meaning
  something other than it appears to.
- **The awkward form shapes, without the network.** The fixture site can serve
  its login page as a form-less button with no `type`, as fields written 1.5s
  after load, or with its sign-out link inside a closed menu — the three shapes
  that each cost a live site on the first run of `login-test.ts`. The
  hidden-menu case is paired with a wrong-password run, because presence-based
  detection must not turn every page into a success.

Six real bugs came out of writing them:

- `csvStore` **never wrote a header** when the file did not exist yet.
  `fs.statSync(..., { throwIfNoEntry: false })` returns `undefined`, and
  `undefined === 0` is false. Manual testing missed it because the write stream
  had already created the file.
- `runEach` **ignored `mission.profiles`**: each target builds its own mission,
  but the shared rotator knew nothing about the filter, so a chromium-only
  probe launched WebKit.
- The hardening script **threw a third of the way in**, silently losing the
  WebGL, permissions and `toString` patches on every chromium profile.
- `webdriver` was left **enumerable: false** by delete-then-define, and
  `deviceMemory` was **created** on builds that do not expose it, landing at the
  end of `getOwnPropertyNames` where no real browser has it.
- `_px3` and `datadome` were read as **clearance tokens**. They are set on
  rejections too, so a hard IP block looked like a browser that had passed.
- `BROWSERS_EVASIONS=all` **silently behaved as `chrome`**: the "all" set is
  deliberately `null`, and `??` treats null as absent.
- A **crashed browser cost 170 of 200 items** in a crawl, because its worker
  kept claiming URLs and spending their retries against a dead page.
- Every chromium profile sent a **bare `Accept-Language`** on the navigation
  request — the one an anti-bot service reads. Later requests carried the
  correct weighted header, which is why it went unnoticed for so long.
- A route entry with an empty value (`home=`) produced a **proxy with an empty
  server**, which Playwright accepts and ignores — indistinguishable from a
  proxy that did not help.

## Field results

Two probes. `field-test.ts` reads detection pages that publish their own
verdict; `field-test-live.ts` loads real commercial homepages and classifies
the response.

### Detection pages

```
bot.sannysoft.com     desktop-chrome    all 58 checks passed
                      mobile-pixel-7    all 58 checks passed
                      desktop-firefox   2/38 failed: "Chrome (New)", "Plugins is of type PluginArray"
```

Sannysoft is a clean pass, and stays one under every evasion setting below.
The two Firefox failures are checks a genuine Firefox also fails: it has no
`window.chrome`, and its `navigator.plugins` is empty.

CreepJS is the harder audience, and tuning against it produced the numbers
that set the current defaults (desktop-chrome, headed, real Chrome):

| evasions | headless | stealth |
| --- | --- | --- |
| every plugin evasion | 0% | 80% |
| **chrome.* only (default)** | **0%** | **60%** |
| none | 33% | 40% |

Three things came out of that tuning, and they are worth keeping in mind
before "improving" the hardening again:

- **The script was silently dead from the `userAgentData` block onward.**
  `Object.assign` onto an object whose prototype has getter-only accessors
  throws, so the WebGL spoof, the permissions fix and the `toString` cloak
  never ran on chromium. Every value test still passed, because everything
  they checked was set before the throw. `test/stealth.test.ts` now executes
  the script in a page and asserts it raises nothing.
- **Repairing it made CreepJS more suspicious, not less** — 60% stealth to
  80%. The engine scores *evidence of patching*, so the broken script was
  accidentally stealthier by doing less. The hardening now reads each value
  before writing it and patches only on a mismatch; where a profile matches
  the host, nothing is touched at all. That took headless from 33% to 0%.
- **The plugin is half the remaining signal.** Dropping its evasions entirely
  halves the stealth score, at the cost of the headless one. The default keeps
  only the `chrome.*` set, which restores the `window.chrome` surface the
  headless score keys on without the published signatures of
  `navigator.plugins`, `iframe.contentWindow` and `window.outerdimensions`.

`BROWSERS_EVASIONS=none` when a target weights stealth-patching detection more
heavily than headless heuristics — which, on the evidence of g2.com below,
DataDome appears to.

### Shape parity

`test/stealth.test.ts` opens the same profile twice in one browser, hardened
and not, and diffs what a detector can read without looking at a single value:
property descriptors, function `name` and `length`, `toString` output, own-vs-
prototype placement, and `Navigator.prototype` key order. They must be
identical; only the claimed values may differ.

That test caught three leaks no value check would:

- `webdriver` came back `enumerable: false` because the script deleted it
  before redefining, while every neighbouring Navigator accessor is
  enumerable. It is redefined in place now.
- `deviceMemory` was being *created* on builds that do not expose it, landing
  at the end of `getOwnPropertyNames` in a position no real browser has. The
  hardening now redefines only what already exists.
- `userAgentData` and `permissions.query` were patched onto instances, so they
  showed as own properties where the engine keeps prototype ones. Both are
  patched on the prototype now, and replaced functions have their `name` and
  `length` restored so a patched `getParameter` no longer answers to
  `patchedGet`.

### The Accept-Language leak

The JS surface was not the whole story. Every chromium profile was sending a
**bare `Accept-Language: en-US`** on the main navigation request - no q-values.
Real Chrome always sends a weighted list, `en-US,de;q=0.9,en-US;q=0.8,en;q=0.7`.

It survived every earlier check because it is only the *first* request:
Playwright's `locale` option wins over `extraHTTPHeaders` on the navigation and
loses on everything after it, so subsequent requests looked correct. The
navigation is the one request an anti-bot service reads before deciding.

Measured, desktop-edge (`en-US`), header on the first request:

```
extraHTTPHeaders in newContext     "en-US"                              wrong
setExtraHTTPHeaders after create   "en-US"                              wrong
no locale, header only             "en-US,de;q=0.9,en-US;q=0.8,en;q=0.7"  correct
```

The fix is native rather than patched, which matters given that patching is
what the fingerprinting engines score. Chromium now launches with
`--accept-lang` and a matching `LANG`/`LC_ALL`, and the context omits `locale`:

| approach | header | navigator.language | Intl |
| --- | --- | --- | --- |
| `locale` (before) | bare `en-US` | en-US | en-US |
| `--accept-lang` + `LANG` | weighted, correct | en-US | de |

Number formatting comes out US-locale either way (`1234.5` → `1.234,5`). Firefox
and WebKit honour `extraHTTPHeaders` on the first request, so they keep
`locale` unchanged - this was a chromium-only bug.

`test/stealth.test.ts` now asserts the header on the wire, from a local server,
for chromium and firefox profiles.

### Live sites: datacenter IP vs residential

Same profile (`desktop-chrome`), same script, two routes. `direct` is a
a region VPS (ASxxxxx a host); `home` is a reverse SSH SOCKS tunnel out through
a consumer line in a city (ASxxxxx a residential ISP). 2026-08-29:

```
site              direct                        home
zillow.com        403  edge-blocked  106 ch     200  clean  3170 ch
ticketmaster.com  403  edge-blocked  210 ch     200  clean  9546 ch
walmart.com       200  clean       26885 ch     200  clean  4104 ch
indeed.com        200  clean         939 ch     200  clean   939 ch
g2.com            403  edge-blocked    0 ch     403  js-blocked  0 ch
```

**Four of five are explained entirely by the IP.** Zillow and Ticketmaster go
from a stub 403 to a full page on the identical fingerprint — PerimeterX and
Kasada were rejecting the ASN, and never looked at the browser. Walmart and
Indeed passed on both. Nothing in `browsers.ts` changed between the columns.

**g2.com is the interesting one, and it is not the IP.** It returns an
empty-bodied 403 from both routes while holding a `cf_clearance` cookie —
Cloudflare ran its challenge and *passed* us, then DataDome rejected the
request anyway. A clearance token is proof the JS layer executed, so this is a
fingerprint or behavioural rejection, and more residential bandwidth will not
fix it. That is consistent with CreepJS scoring these profiles 60% stealth:
DataDome is among the vendors that look for exactly those patching artefacts.

The run also corrected two bugs in `detect.ts`:

- `_px3` and `datadome` were being read as clearance tokens. They are set on
  rejections too, so a hard IP block on zillow looked like a browser that had
  been let through — the opposite of the truth. `PASS_TOKENS` is now only
  `cf_clearance` and `reese84`, which are issued solely on success.
- A rejection was classified purely on body size, so g2's empty 403 was called
  `edge-blocked` and advised "retry through a residential proxy". We then did,
  and got the same 403. `classify()` now takes the protection state: a
  rejection behind a clearance token is `js-blocked` regardless of body size.

Both are locked in by tests built from the observed statuses, cookie names and
body sizes, asserting the *prediction* each verdict makes — `edge-blocked` on
zillow-direct has to be followed by `clean` on zillow-home, or the diagnosis
was wrong.

### The g2 case, settled

g2.com refused every attempt: from the a region VPS, from the a city
residential line, before and after the stealth work. The verdict said
`js-blocked` — vendor JS ran and rejected the browser — so the obvious reading
was that the fingerprint was the problem.

It was not. Two diagnostics settled it:

```
                    browser              curl (same route)
example.com         200                  200  559 B
g2.com              403   0 bytes        403  1704 B
g2 headers          server: cloudflare, x-datadome: protected, x-dd-b: 259
```

**A plain curl is refused too** — no JavaScript, no browser TLS, no client
hints, nothing to fingerprint. Whatever decides against us is deciding before
the browser is consulted at all. And four other DataDome sites (leboncoin,
vinted, seloger, rakuten) serve full pages over the same IP in the same run, so
it is not DataDome rejecting this fingerprint either. It is a rule specific to
g2 — geo or ASN, on the evidence of two IPs on different networks
failing identically while French sites load.

The lesson is in the tooling, not the site: a verdict computed from inside the
browser cannot tell "you were rejected" from "you were never asked". Hence
`--baseline`.

| browser | curl | conclusion |
| --- | --- | --- |
| blocked | blocked | network level — IP, ASN or geo; the browser was never consulted |
| blocked | served | browser-specific — fingerprint or behaviour |
| served | blocked | the profile is doing its job |
| any | 3xx or 0 | inconclusive — the request never reached the page |

That last row is there because `curl https://g2.com` returns 301 to www and
stops unless given `-L`. A redirect is neither served nor refused, and reading
it as "served" would have concluded "browser-specific block" from a request
that never arrived. The probe now follows redirects and reports a 3xx baseline
as inconclusive rather than as evidence.

### The ScrapingCourse challenges

`challenges.ts` runs the nine practice challenges at scrapingcourse.com end to
end, asserting on the data recovered rather than on a status code — a page that
loads and yields nothing is a failure. 2026-08-30, direct route, one headed
Chrome per challenge:

```
javascript-rendering   12 products, all with name and price
button-click           12 -> 175 products over 15 presses
infinite-scrolling     12 -> 187 products over 18 scrolls
pagination             147 products across 14 pages, 12 duplicates dropped
table-parsing          15 of 15 rows with every field populated
login                  signed in as admin@example.com; wrong password refused
ecommerce              182 products across 12 pages, 0 failures
antibot-challenge      bypassed, 1 click, 3.0s, cf_clearance issued
cloudflare-challenge   bypassed, 2 clicks, 9.7s, cf_clearance issued
```

The last two are Cloudflare interstitials — `cf-mitigated: challenge`, a 403
to curl, and a Turnstile checkbox to a browser. They are not a separate
technique: a headed Chrome on a coherent profile, `human.clickAt` onto the
checkbox, and the wait. What `turnstile.ts` adds is finding the checkbox and
knowing when it has been answered.

The clearance token is deliberately *not* what the run asserts on. g2 already
showed a `cf_clearance` cookie sitting alongside a flat refusal, and the
interstitial takes a moment to navigate once the widget is satisfied, so a
check on the cookie can pass while the interstitial is still on screen. What
the run asserts on is the text behind it: *You bypassed the … challenge!*

One press is not always enough — the cloudflare-challenge took two in the run
above. Hence `attempts: 3` by default, with six seconds between presses:
a widget that has been pressed needs time to answer, and the second press
inside a second is the tell, not the first.

### Response headers

The probe navigates inside `run()` and keeps the `Response` object rather than
reading a status out of `performance.getEntriesByType("navigation")`, which
gives a number and nothing else. It records `server`, `cf-ray`, `cf-mitigated`,
`cf-cache-status`, `x-datadome`, `x-dd-b` and `retry-after` — the headers that
name which layer said no. `x-datadome: protected` on g2's 403 is how we know
which of its two vendors answered.

### Reading a verdict

| Verdict | Meaning | What to change |
| --- | --- | --- |
| `clean` | page served | nothing |
| `challenged` | interstitial that did not resolve in `DWELL_MS` | dwell longer before blaming the profile |
| `edge-blocked` | rejected before any JS ran | the route — IP reputation is deciding |
| `js-blocked` | vendor JS ran and said no | the fingerprint or the behaviour; a new IP will not help |

`js-blocked` is a claim about what the response looked like, not proof the
browser was inspected. Confirm it with `--baseline` before spending effort on
the fingerprint: on g2 that verdict was right about the response and wrong
about the cause.

### Targets

`targets.ts` holds the catalogue - 32 sites grouped by the vendor they run,
with a difficulty and a note where one was earned. The `vendor` field is what
the site is *expected* to run; the probe detects what is actually there and
flags a mismatch as `[expected datadome]`, so a wrong guess in the catalogue
surfaces instead of misleading you.

```sh
npx tsx field-test-live.ts --list                    # what would be probed
npx tsx field-test-live.ts --vendor=datadome         # one vendor at a time
npx tsx field-test-live.ts --category=retail --difficulty=hard
npx tsx field-test-live.ts --targets=g2,zillow       # exact names
npx tsx field-test-live.ts --vendor=akamai --limit=3
```

| Group | Sites |
| --- | --- |
| control | example, wikipedia, hn, httpbin |
| detector | sannysoft, creepjs, tls, browserleaks-js |
| cloudflare | indeed, upwork, crunchbase, medium, zoopla |
| datadome | g2, leboncoin, vinted, seloger, rakuten |
| perimeterx | zillow, walmart, wayfair, grubhub, booking |
| kasada | ticketmaster, stubhub, hyatt |
| akamai | nike, target, bestbuy, adidas, homedepot, expedia |
| imperva | ryanair, saks |

**A control is prepended to every run** unless you pass `--no-control`. Without
one, "the site blocked us" and "the tunnel is down" produce identical output.
`httpbin` earns its place too: it echoes the request headers back, which is how
the Accept-Language bug above would have been caught in seconds.

Testing one vendor at a time is the point of the grouping. A fingerprint change
aimed at DataDome can be checked against five DataDome sites in one run,
instead of inferring from a single site whether anything moved.

### Running it

```sh
npx tsx field-test-live.ts --routes          # parse proxy config, mask credentials, exit
npx tsx field-test-live.ts --list            # show the selected targets, exit
npx tsx field-test-live.ts --only=home       # one route only
npx tsx field-test-live.ts --fresh           # re-measure stored pairs instead of resuming
npx tsx field-test-live.ts --baseline        # also ask curl, to locate the block
PROXIES="home=socks5://127.0.0.1:1080" npx tsx field-test-live.ts
```

Routes come from `PROXIES` (or a `proxies.txt`), one `label=url` per line, hops
separated by `>`. Every route proves itself against `ipinfo.io` before any
target is probed and is skipped if that fails, so a silently-dead proxy can
never be misread as "the proxy did not help". Results key on
url+profile+route, so an interrupted run resumes and routes stay comparable.

To route a VPS through a home line without a proxy subscription, add a reverse
dynamic forward from the home machine — `ssh -N -R 1080 you@vps`, or `~C` then
`-R 1080` inside an existing session — and point `PROXIES` at
`socks5://127.0.0.1:1080`. Verified: Chrome, Firefox and the mobile profiles
all drive a SOCKS5 proxy, and DNS resolves remotely, so the VPS never leaks the
hostnames it is asking for.

---

# browsers.ts

30 profiles: 10 desktop, 10 mobile, 10 tablet.

| Form factor | Profiles |
| --- | --- |
| **desktop** | `desktop-chrome`, `-chrome-hidpi`, `-chrome-intel`, `-edge`, `-chrome-mac`, `-chrome-linux`, `-firefox`, `-firefox-linux`, `-safari`, `-safari-intel` |
| **mobile** | `mobile-pixel-7`, `-pixel-5`, `-galaxy-s24`, `-galaxy-s9`, `-galaxy-a55`, `-iphone-15-pro`, `-iphone-15`, `-iphone-14`, `-iphone-13`, `-iphone-se` |
| **tablet** | `tablet-ipad-pro-11`, `-ipad-pro-11-landscape`, `-ipad-mini`, `-ipad-gen-11`, `-ipad-gen-7`, `-ipad-gen-6`, `-ipad-gen-5`, `-galaxy-tab-s9`, `-galaxy-tab-s9-landscape`, `-galaxy-tab-s4` |

Each varies GPU, core count, RAM, viewport, locale and timezone *together*, so
they read as 30 different machines rather than one machine wearing 30 user
agents. Locale and timezone are paired in one table (a `en-US` browser in
`America/New_York` is a giveaway) and GPU strings come from another, so a
Windows profile can never claim an Apple renderer.

## Selecting

```ts
getProfile("mobile-pixel-7")                 // by id, throws if unknown
filterProfiles({ formFactor: "mobile" })     // by form factor and/or engine
filterProfiles({ engine: ["chromium", "webkit"] })
randomProfile({ formFactor: ["desktop", "tablet"] })
profileRotator()                             // () => profile, shuffled, no repeats
```

`profileRotator` hands out every profile in a pool once before reshuffling.
Prefer it to `randomProfile()` in a loop, which will happily serve the same
fingerprint three times running. `runMission` uses it internally.

## Launching

```ts
const { browser, context, profile, channel } = await launchProfile(profile);
const page = await context.newPage();
// ...
await browser.close();
```

`launchProfile(profile, launchOptions?, contextOverrides?)` returns a
`Session`. Both option arguments pass straight through to Playwright, so a
per-session proxy is just:

```ts
await launchProfile(profile, { proxy: { server: "http://ip:port" } });
```

For chains and rotation see [proxies.ts](#proxiests).

Defaults it applies, all overridable:

- **Headed always.** Headless is the one tell the evasions can't patch away.
- **Real Chrome preferred.** Chromium profiles list `channels` and the launcher
  walks them, ending on bundled Chromium if none are installed. An Edge profile
  that falls back to Chrome drops its `Edg/` token rather than claiming to be a
  browser it isn't. `session.channel` tells you what actually ran.
- **Version-synced UA.** `syncUserAgent` rewrites the UA to the build actually
  running, in Chrome's reduced `major.0.0.0` form, so it can't contradict
  `navigator.userAgentData`.

Running many browsers at once is fine, including several of the same profile —
each `launchProfile` is its own process. Duplicates share a fingerprint though,
so for parallel work against one target prefer distinct profiles and separate
proxies. For separate *sessions* on one fingerprint, extra contexts are far
cheaper than extra browsers:

```ts
const ctx = await browser.newContext(contextOptionsFor(profile));
await hardenContext(ctx, profile, { browserVersion: browser.version() });
```

`launchProfile` only hardens the context it creates, so hardening any extra
context is on you.

## What the hardening covers

`playwright-extra` + `puppeteer-extra-plugin-stealth`, with three of its
evasions disabled (`navigator.hardwareConcurrency`, `navigator.languages`,
`webgl.vendor`) because they inject fixed values that contradict the profile —
and `user-agent-override` disabled too, because it rewrites every context to
the *host* browser's UA, silently turning every Pixel and iPad profile back
into desktop Chrome on Windows.

On top of that, `hardenContext` runs an init script before any page script, on
every page and frame, covering Firefox and WebKit where the Chromium evasions
don't apply:

- `navigator.webdriver` → `false` (present and false, as in a real browser —
  not deleted)
- `platform`, `hardwareConcurrency`, `deviceMemory`, `languages` from the profile
- `userAgentData` — brands, platform, and `getHighEntropyValues` — matched to
  the UA string
- WebGL unmasked vendor/renderer
- the notification-permission contradiction headless Chromium gives away
- `Function.prototype.toString`, so the patches above still report as native

The script is built as **source text**, not passed as a function. TS runners
rewrite function bodies with helpers like `__name`, which aren't defined inside
the page and make the whole script throw silently — a string survives any build
pipeline.

## Display handling

Headed browsers need an X display, and a headed Chromium resizes the real OS
window to match the viewport — a resize that fails intermittently once the
window is bigger than the screen, which the HiDPI desktop profile (2560 wide)
and the portrait tablets both are on a 1080p monitor.

So `ensureDisplay()` measures the current display and starts a 2560×2560 Xvfb
when there isn't one, or when the one there is can't fit the largest profile.
It's called for you and cleans up on exit.

```sh
BROWSERS_USE_CURRENT_DISPLAY=1   # stay on your own display and watch them work
                                 # (expect resize errors on the biggest profiles)
```

Without `xvfb` installed and with no `DISPLAY` set, launching fails with a
message telling you to install it.

## What this does not do

### TLS is already the browser's

The browser's own network stack does its TLS, so navigation and in-page
requests carry a genuine engine fingerprint — there is no Playwright TLS
layer in front of it to replace. Measured JA4, one session each:

```
Chrome page navigation    t13d1517h2_8daaf6152771_cb7bf5808d99   genuine Chrome
Chrome ctx.fetch          t13d1517h2_8daaf6152771_cb7bf5808d99   identical
Firefox page navigation   t13d1617h2_86a278354501_3cbfd9057e0d   genuine Firefox
context.request           t13d521100_b262b3658495_8e6e362c5eac   Node — avoid
node fetch                t13d5212h1_b262b3658495_8e6e362c5eac   Node
```

So the TLS work is not a rewrite, it is a routing rule: keep every request
inside the browser, which is what `ctx.fetch` is for. JA3 varies run to run
because Chrome randomises its extension order; JA4 is the stable one to
compare.

Two residual mismatches worth knowing, neither fixable without a
TLS-rewriting proxy:

- **Android and iOS profiles run desktop engine builds.** `mobile-pixel-7`
  presents Chrome-on-Android in every JS surface and header, but its
  ClientHello is desktop Chrome's. In practice the two are near-identical
  because it is the same BoringSSL, but they are not guaranteed equal.
- **WebKit profiles are not Safari.** Playwright's WebKit build on Linux does
  not produce iOS or macOS Safari's ClientHello. If a target fingerprints TLS
  hard, prefer the chromium profiles.

### Genuinely untouched

- **Canvas and audio hashing** — stable per machine and identical across every
  profile here, so 30 profiles look like one machine to a canvas hash.
- **HTTP/2 frame fingerprinting** — settings and priority patterns are the
  engine's, which is right for chromium and wrong for the mobile claims, same
  as TLS above.
- **IP reputation** — the strongest signal of all. This is what `proxies.ts`
  is for; nothing in the profile catalogue substitutes for it.

Good enough for the checks most sites run. Against Cloudflare or DataDome tier
defences, residential proxies matter more than anything else in these files.
