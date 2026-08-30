/**
 * Cases taken from a real field run (field-test-live.db, 2026-08-29), so these
 * are the exact strings and cookie names five live sites actually returned.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, detectProtection, advise, diagnosticHeaders, compareBaseline } from "../detect";

const OBSERVED = {
  zillow:       { status: 403, title: "Access to this page has been denied", chars: 106,
                  cookies: ["_pxvid", "_px3", "pxcts"] },
  g2:           { status: 403, title: "g2.com", chars: 0,
                  cookies: ["datadome", "cf_clearance", "__cf_bm"] },
  ticketmaster: { status: 403, title: "Your Browsing Activity Has Been Paused", chars: 210,
                  cookies: ["eps_sid", "OptanonGroups", "KP_UIDz-ssn", "KP_UIDz"] },
  indeed:       { status: 200, title: "Job Search | Indeed", chars: 939,
                  cookies: ["CTK", "CSRF", "_cfuvid", "cf_clearance", "__cf_bm", "__cflb"] },
  walmart:      { status: 200, title: "Walmart | Save Money. Live better.", chars: 26885,
                  cookies: ["s", "isoLoc", "_pxvid", "pxcts", "ACID"] },
};

describe("vendor detection", () => {
  test("Kasada is identified from KP_UIDz", () => {
    // The bug: ticketmaster reported "none identified" while plainly running Kasada.
    const { vendors } = detectProtection(OBSERVED.ticketmaster.cookies);
    assert.deepEqual(vendors, ["Kasada"]);
  });

  test("Kasada is also identified from its interstitial copy", () => {
    const { vendors } = detectProtection([], "Your Browsing Activity Has Been Paused");
    assert.deepEqual(vendors, ["Kasada"]);
  });

  test("two vendors on one response are both reported", () => {
    assert.deepEqual(detectProtection(OBSERVED.g2.cookies).vendors, ["Cloudflare", "DataDome"]);
  });

  test("PerimeterX is caught from _pxvid and pxcts", () => {
    assert.deepEqual(detectProtection(OBSERVED.zillow.cookies).vendors, ["PerimeterX/HUMAN"]);
  });

  test("a clearance token is reported as a pass", () => {
    assert.equal(detectProtection(OBSERVED.indeed.cookies).passedChallenge, true);
    assert.equal(detectProtection(OBSERVED.walmart.cookies).passedChallenge, false);
  });

  test("ordinary cookies do not name a vendor", () => {
    assert.deepEqual(detectProtection(["session", "csrf", "lang", "s", "ACID"]).vendors, []);
  });

  test("Akamai and Imperva are recognised", () => {
    assert.deepEqual(detectProtection(["_abck", "bm_sz"]).vendors, ["Akamai"]);
    assert.deepEqual(detectProtection(["visid_incap_123", "incap_ses_4_5"]).vendors, ["Imperva"]);
  });
});

describe("verdicts", () => {
  test("403 with a stub body is an edge block, not a fingerprint failure", () => {
    for (const site of [OBSERVED.zillow, OBSERVED.g2, OBSERVED.ticketmaster]) {
      assert.equal(
        classify(site.status, site.title, "x".repeat(site.chars), site.chars),
        "edge-blocked",
        site.title
      );
    }
  });

  test("a full-sized interstitial is a JS-layer block", () => {
    const body = "Pardon our interruption. " + "x".repeat(5000);
    assert.equal(classify(403, "Pardon our interruption", body, body.length), "js-blocked");
  });

  test("200s with real content are clean", () => {
    for (const site of [OBSERVED.indeed, OBSERVED.walmart]) {
      assert.equal(classify(site.status, site.title, "x".repeat(site.chars), site.chars), "clean");
    }
  });

  test("a 403 with an empty body is never reported as clean", () => {
    // The original bug: classify() only read the text, so a hard 403 with no
    // body passed as clean.
    assert.notEqual(classify(403, "", "", 0), "clean");
  });

  test("a challenge page is distinguished from a block", () => {
    assert.equal(classify(200, "Just a moment...", "Checking your browser before accessing"), "challenged");
  });

  test("429 counts as a rejection", () => {
    assert.equal(classify(429, "Too Many Requests", ""), "edge-blocked");
  });
});

describe("advice", () => {
  test("edge blocks point at the IP, not the profile", () => {
    const message = advise("edge-blocked", detectProtection(OBSERVED.zillow.cookies));
    assert.match(message, /IP, not the fingerprint/);
    assert.match(message, /PerimeterX/);
  });

  test("js blocks point at the fingerprint", () => {
    const message = advise("js-blocked", { vendors: ["DataDome"], passedChallenge: false });
    assert.match(message, /DataDome/);
    assert.match(message, /a different IP will not help/);
  });

  test("a clean pass names what it got past", () => {
    assert.match(advise("clean", detectProtection(OBSERVED.indeed.cookies)), /passed Cloudflare.*clearance token/);
  });
});

describe("route comparison (real data, direct vs residential)", () => {
  // Observed 2026-08-29: same profile, datacenter IP then a residential one.
  const zillowDirect = { status: 403, chars: 106, cookies: ["_pxvid", "_px3", "pxcts"] };
  const zillowHome = { status: 200, chars: 3170, cookies: ["_pxvid", "_px3", "pxcts"] };
  const g2Direct = { status: 403, chars: 0, cookies: ["datadome", "cf_clearance", "__cf_bm"] };
  const g2Home = { status: 403, chars: 0, cookies: ["datadome", "cf_clearance", "__cf_bm"] };
  const tmDirect = { status: 403, chars: 210, cookies: ["eps_sid", "KP_UIDz"] };

  test("vendor cookies alone are not a clearance", () => {
    // _px3 and datadome are set on rejections too; treating them as a pass made
    // an IP block look like a browser that had been let through.
    assert.equal(detectProtection(zillowDirect.cookies).passedChallenge, false);
    assert.equal(detectProtection(["datadome"]).passedChallenge, false);
    assert.equal(detectProtection(["cf_clearance"]).passedChallenge, true);
  });

  test("zillow's block is diagnosed as the IP — and it was", () => {
    const p = detectProtection(zillowDirect.cookies);
    assert.equal(classify(403, "Access to this page has been denied", "x".repeat(106), 106, p), "edge-blocked");
    assert.match(advise("edge-blocked", p), /IP, not the fingerprint/);
    // Same profile, residential IP: clean. Which is what "edge-blocked" predicted.
    assert.equal(classify(zillowHome.status, "Zillow", "x".repeat(zillowHome.chars), zillowHome.chars,
      detectProtection(zillowHome.cookies)), "clean");
  });

  test("ticketmaster's block is diagnosed as the IP — and it was", () => {
    const p = detectProtection(tmDirect.cookies);
    assert.equal(classify(403, "Your Browsing Activity Has Been Paused", "x".repeat(210), 210, p), "edge-blocked");
    assert.equal(classify(200, "Ticketmaster", "x".repeat(9546), 9546, detectProtection(["KP_UIDz", "_GRECAPTCHA"])), "clean");
  });

  test("g2 holds a clearance token while returning 403, so it is not the IP", () => {
    for (const observation of [g2Direct, g2Home]) {
      const p = detectProtection(observation.cookies);
      assert.equal(p.passedChallenge, true, "cf_clearance was issued");
      assert.equal(
        classify(observation.status, "g2.com", "", observation.chars, p),
        "js-blocked",
        "an empty 403 behind a clearance token is a vendor rejection, not an edge block"
      );
    }
    assert.match(advise("js-blocked", detectProtection(g2Home.cookies)), /a different IP will not help/);
  });
});

describe("response evidence", () => {
  test("keeps only the headers that name a layer", () => {
    const kept = diagnosticHeaders({
      "Server": "cloudflare",
      "CF-RAY": "8f2a1b3c4d5e6f00-FRA",
      "cf-mitigated": "challenge",
      "content-type": "text/html",
      "set-cookie": "secret=value",
      "x-datadome": "protected",
    });
    assert.deepEqual(Object.keys(kept).sort(), ["cf-mitigated", "cf-ray", "server", "x-datadome"]);
    assert.equal(kept["cf-mitigated"], "challenge");
  });

  test("header names are matched case-insensitively", () => {
    assert.deepEqual(diagnosticHeaders({ "SERVER": "nginx" }), { server: "nginx" });
  });

  test("no diagnostic headers yields an empty object, not noise", () => {
    assert.deepEqual(diagnosticHeaders({ "content-type": "text/html", date: "now" }), {});
  });
});

describe("baseline comparison", () => {
  const protection = { vendors: ["DataDome"], passedChallenge: true };

  test("both refused means the browser was never consulted", () => {
    const message = compareBaseline("js-blocked", { status: 403, bytes: 0 }, protection);
    assert.match(message, /plain HTTP client is refused too/);
    assert.match(message, /IP, ASN or geo/);
  });

  test("curl served while the browser is refused means fingerprint", () => {
    const message = compareBaseline("js-blocked", { status: 200, bytes: 51_000 }, protection);
    assert.match(message, /block is browser-specific/);
  });

  test("browser passing where curl fails is the profile working", () => {
    const message = compareBaseline("clean", { status: 403, bytes: 0 }, protection);
    assert.match(message, /profile is doing its job/);
  });

  test("without a baseline it falls back to the ordinary advice", () => {
    assert.equal(
      compareBaseline("edge-blocked", undefined, protection),
      advise("edge-blocked", protection)
    );
  });

  test("a 5xx baseline counts as refused, not as served", () => {
    assert.match(
      compareBaseline("js-blocked", { status: 503, bytes: 0 }, protection),
      /refused too/
    );
  });
});

describe("baseline soundness", () => {
  const protection = { vendors: ["DataDome"], passedChallenge: false };

  test("a redirect is inconclusive, not a pass", () => {
    // Observed: `curl https://g2.com` returns 301 to www and stops without -L.
    // Reading that as "served" would have concluded "browser-specific block"
    // from a request that never reached the page.
    const message = compareBaseline("js-blocked", { status: 301, bytes: 0 }, protection);
    assert.match(message, /inconclusive/);
    assert.match(message, /redirect/);
  });

  test("every 3xx is treated the same way", () => {
    for (const status of [301, 302, 307, 308]) {
      assert.match(compareBaseline("js-blocked", { status, bytes: 0 }, protection), /inconclusive/);
    }
  });

  test("a failed connection is inconclusive too", () => {
    assert.match(compareBaseline("js-blocked", { status: 0, bytes: 0 }, protection), /inconclusive/);
  });

  test("the g2 case reads as network level", () => {
    // browser 403 / 0 bytes, curl 403 / 1704 bytes, over the same residential route.
    const message = compareBaseline("js-blocked", { status: 403, bytes: 1704 }, protection);
    assert.match(message, /refused too/);
    assert.match(message, /IP, ASN or geo/);
  });
});
