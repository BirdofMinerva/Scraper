/**
 * Reading what an anti-bot response actually means.
 *
 * The distinction that matters when debugging: a 403 with an empty body is a
 * rejection at the edge, before any JavaScript was served - the browser
 * fingerprint was never looked at, so improving it changes nothing. A
 * challenge page, or a 200 carrying the vendor's cookies, means the JS layer
 * ran and made a decision about the browser. Those two failures have opposite
 * fixes, and conflating them wastes a lot of time.
 */

export type Verdict = "clean" | "challenged" | "edge-blocked" | "js-blocked";

export type Protection = {
  /** Vendors whose cookies or markup are present, blocking or not. */
  vendors: string[];
  /** True when a vendor issued a "you're fine" token. */
  passedChallenge: boolean;
};

/** Cookie names and markup fragments each vendor leaves behind. */
const VENDORS: Array<{ name: string; cookies: RegExp; markup?: RegExp }> = [
  { name: "Cloudflare", cookies: /^(__cf_bm|cf_clearance|_cfuvid|__cflb)$/i, markup: /challenges\.cloudflare\.com|cf-chl|cdn-cgi\/challenge-platform/i },
  { name: "DataDome", cookies: /^datadome$/i, markup: /captcha-delivery\.com|datadome/i },
  { name: "PerimeterX/HUMAN", cookies: /^(_px\w*|pxcts)$/i, markup: /px-captcha|perimeterx|px-cdn/i },
  { name: "Kasada", cookies: /^KP_UIDz/i, markup: /kpsdk|kasada|browsing activity has been paused/i },
  { name: "Akamai", cookies: /^(_abck|bm_sz|ak_bmsc|bm_sv)$/i, markup: /akam|_abck/i },
  { name: "Imperva", cookies: /^(incap_ses\w*|visid_incap\w*|nlbi\w*)$/i, markup: /incapsula|imperva/i },
  { name: "Queue-it", cookies: /^Queue-it/i, markup: /queue-it\.net/i },
];

/**
 * Cookies that mean a vendor evaluated the browser and *let it through*.
 *
 * Deliberately narrow. `datadome` and `_px3` are set on every response,
 * rejections included, so treating them as clearance made a hard IP block on
 * zillow look like a browser that had passed - the opposite of the truth.
 * `cf_clearance` and `reese84` are only issued after a challenge succeeds.
 */
const PASS_TOKENS = /^(cf_clearance|reese84)$/i;

export function detectProtection(cookies: string[], markup = ""): Protection {
  const vendors = VENDORS.filter(
    (v) => cookies.some((c) => v.cookies.test(c)) || (v.markup?.test(markup) ?? false)
  ).map((v) => v.name);

  return { vendors, passedChallenge: cookies.some((c) => PASS_TOKENS.test(c)) };
}

const CHALLENGE =
  /just a moment|checking your browser|verify (you are|yourself)|are you a robot|captcha|press & hold|enable javascript and cookies|additional verification|browsing activity has been paused/i;
const BLOCKED =
  /access denied|access to this page has been denied|forbidden|you have been blocked|unusual traffic|request blocked|pardon our interruption|activity from your device/i;

/**
 * Classify a landing response.
 *
 * `bodyChars` is what separates the two block kinds: an edge rejection ships a
 * stub page because the vendor never intended to run anything, while a JS-layer
 * block ships a real challenge or interstitial with content in it.
 */
export function classify(
  status: number,
  title: string,
  text: string,
  bodyChars = text.length,
  protection?: Protection
): Verdict {
  const head = `${title}\n${text.slice(0, 4000)}`;
  const rejected = status === 403 || status === 429 || status === 503 || BLOCKED.test(head);

  if (rejected) {
    // A clearance token proves the JS layer ran and passed us, so a rejection
    // after it came from something further in - not from the IP. Observed on
    // g2.com, which returns an empty-bodied 403 while holding a cf_clearance
    // cookie, identically from a datacenter and a residential IP.
    if (protection?.passedChallenge) return "js-blocked";

    // Otherwise a stub body means nothing was served to evaluate: the decision
    // was made on the connection, not on the browser.
    return bodyChars < 2000 ? "edge-blocked" : "js-blocked";
  }
  if (CHALLENGE.test(head)) return "challenged";
  if (status >= 400) return "edge-blocked";
  return "clean";
}

/** One line explaining what to do about a verdict. */
export function advise(verdict: Verdict, protection: Protection): string {
  switch (verdict) {
    case "edge-blocked":
      return `rejected before any JS ran — this is the IP, not the fingerprint. Retry through a residential proxy.${
        protection.vendors.length ? ` (${protection.vendors.join(", ")})` : ""
      }`;
    case "js-blocked":
      return `${protection.vendors.join(", ") || "the vendor"} ran and rejected the browser${
        protection.passedChallenge ? " after issuing a clearance token" : ""
      } — a different IP will not help; this is the fingerprint or the behaviour.`;
    case "challenged":
      return `challenge served; it did not resolve within the dwell time. Try a longer DWELL_MS before blaming the profile.`;
    case "clean":
      return protection.vendors.length
        ? `passed ${protection.vendors.join(", ")}${protection.passedChallenge ? " (clearance token issued)" : ""}.`
        : `no protection detected.`;
  }
}


// ---------------------------------------------------------------------------
// Response-level evidence
// ---------------------------------------------------------------------------

/** The response headers worth keeping: they name the layer that said no. */
const DIAGNOSTIC_HEADERS = [
  "server",
  "cf-ray",
  "cf-mitigated",
  "cf-cache-status",
  "x-datadome",
  "x-datadome-cid",
  "x-dd-b",
  "x-akamai-transformed",
  "x-iinfo",
  "retry-after",
  "content-length",
];

export function diagnosticHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (DIAGNOSTIC_HEADERS.includes(key)) kept[key] = value.slice(0, 120);
  }
  return kept;
}

export type Baseline = {
  /** Status a plain HTTP client got for the same URL, over the same route. */
  status: number;
  bytes: number;
};

/**
 * Compare a browser result against a plain HTTP client on the same route.
 *
 * This is the question no amount of fingerprint work can answer from inside
 * the browser: if curl - with none of the JS, none of the browser TLS, none of
 * the client hints - is served the page while the browser is refused, the
 * block is about the browser. If curl is refused too, nothing about the
 * browser is being consulted and the fingerprint is not the problem.
 */
export function compareBaseline(
  verdict: Verdict,
  baseline: Baseline | undefined,
  protection: Protection
): string {
  if (!baseline) return advise(verdict, protection);

  const browserBlocked = verdict === "edge-blocked" || verdict === "js-blocked";
  const baselineBlocked = baseline.status === 403 || baseline.status === 429 || baseline.status >= 500;

  // A redirect is neither served nor refused: the request never reached the
  // page. Concluding anything from it would be reading a measurement that was
  // not taken - curl needs -L, or the URL needs its final form.
  if (baseline.status >= 300 && baseline.status < 400) {
    return `inconclusive: a plain HTTP client got ${baseline.status} (a redirect, not an answer) — follow it before comparing.`;
  }
  if (baseline.status === 0) {
    return `inconclusive: the plain HTTP client could not connect at all over this route.`;
  }

  if (browserBlocked && baselineBlocked) {
    return `a plain HTTP client is refused too (${baseline.status}) — nothing about the browser is being consulted. Network level: IP, ASN or geo.`;
  }
  if (browserBlocked && !baselineBlocked) {
    return `a plain HTTP client gets ${baseline.status} on this same route while the browser is refused — the block is browser-specific, so fingerprint or behaviour.`;
  }
  if (!browserBlocked && baselineBlocked) {
    return `browser passed where a plain client is refused (${baseline.status}) — the profile is doing its job.`;
  }
  return advise(verdict, protection);
}
