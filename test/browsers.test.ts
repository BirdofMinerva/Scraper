import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { devices } from "playwright";
import {
  PROFILES, getProfile, filterProfiles, randomProfile, profileRotator,
  contextOptionsFor, syncUserAgent, hardeningScript, launchOptionsFor, selectEvasions,
  localeFor, acceptLanguageFor,
} from "../browsers";

describe("catalog", () => {
  test("ids are unique", () => {
    const ids = PROFILES.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("10 of each form factor", () => {
    for (const form of ["desktop", "mobile", "tablet"] as const) {
      assert.equal(filterProfiles({ formFactor: form }).length, 10, form);
    }
  });

  test("every device key exists in playwright", () => {
    for (const p of PROFILES) {
      if (p.device) assert.ok(devices[p.device], `${p.id} -> ${p.device}`);
    }
  });

  test("firefox never claims mobile emulation", () => {
    // Playwright's firefox does not support isMobile; a mobile firefox profile
    // would throw at launch rather than fail a check.
    for (const p of filterProfiles({ engine: "firefox" })) {
      assert.equal(p.formFactor, "desktop", p.id);
    }
  });
});

describe("fingerprint consistency", () => {
  test("GPU matches the claimed platform", () => {
    for (const p of PROFILES) {
      const { platform, webgl } = p.fingerprint;
      const { vendor, renderer } = webgl;
      const apple = platform === "MacIntel" || platform === "iPhone" || platform === "iPad";
      const android = platform === "Linux armv8l";

      if (android) {
        assert.match(renderer, /Adreno|Mali/, `${p.id}: ${renderer} on Android`);
      } else {
        assert.doesNotMatch(renderer, /Adreno|Mali/, `${p.id}: phone GPU on ${platform}`);
      }

      if (apple) {
        // Apple vendor covers Apple silicon and the AMD dGPUs in Intel Macs.
        assert.match(vendor, /Apple/, `${p.id}: ${vendor} on ${platform}`);
        assert.doesNotMatch(renderer, /NVIDIA|Direct3D/, `${p.id}: ${renderer} on ${platform}`);
      } else if (platform === "Win32" || platform === "Linux x86_64") {
        assert.doesNotMatch(vendor, /Apple/, `${p.id}: ${vendor} on ${platform}`);
        assert.doesNotMatch(renderer, /Apple GPU|Metal/, `${p.id}: ${renderer} on ${platform}`);
      }
    }
  });

  test("Direct3D renderers only appear on Windows", () => {
    for (const p of PROFILES) {
      if (/Direct3D/.test(p.fingerprint.webgl.renderer)) {
        assert.equal(p.fingerprint.platform, "Win32", p.id);
      }
    }
  });

  test("locale and timezone agree on a region", () => {
    const regions: Record<string, RegExp> = {
      "en-US": /^America\//, "en-GB": /^Europe\/London$/, "de-DE": /^Europe\/Berlin$/,
      "fr-FR": /^Europe\/Paris$/, "nl-NL": /^Europe\/Amsterdam$/, "en-CA": /^America\/Toronto$/,
      "en-AU": /^Australia\//, "es-ES": /^Europe\/Madrid$/,
    };
    for (const p of PROFILES) {
      const locale = localeFor(p);
      const { timezoneId } = contextOptionsFor(p);
      assert.ok(regions[locale], `${p.id}: unmapped locale ${locale}`);
      assert.match(timezoneId!, regions[locale], `${p.id}: ${locale} in ${timezoneId}`);
    }
  });

  test("deviceMemory only where the API exists", () => {
    for (const p of PROFILES) {
      if (p.engine !== "chromium") {
        assert.equal(p.fingerprint.deviceMemory, undefined, `${p.id} is ${p.engine}`);
      }
    }
  });

  test("mobile and tablet profiles carry an android model", () => {
    for (const p of PROFILES) {
      if (p.fingerprint.platform === "Linux armv8l") {
        assert.ok(p.fingerprint.model, `${p.id} has no model`);
      }
    }
  });
});

describe("context options", () => {
  test("Accept-Language is a weighted list, never a bare locale", () => {
    // Playwright's `locale` sends a bare "de-DE" on the main navigation
    // request. Real Chrome always sends q-values, so a bare one is a tell.
    assert.equal(acceptLanguageFor(getProfile("desktop-edge")), "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7");
    assert.equal(acceptLanguageFor(getProfile("desktop-chrome")), "en-US,en;q=0.9");

    for (const p of PROFILES) {
      const header = acceptLanguageFor(p);
      assert.match(header, /^[a-z]{2}-[A-Z]{2},/, `${p.id}: ${header}`);
      assert.ok(header.includes(";q=0."), `${p.id} has no q-values`);
    }
  });

  test("chromium drops locale so the header survives, others keep it", () => {
    assert.equal(contextOptionsFor(getProfile("desktop-edge")).locale, undefined);
    assert.equal(contextOptionsFor(getProfile("desktop-firefox")).locale, "en-US");
    assert.equal(contextOptionsFor(getProfile("desktop-safari")).locale, "en-US");
  });

  test("localeFor still reports what a chromium profile claims", () => {
    assert.equal(localeFor(getProfile("desktop-edge")), "de-DE");
    assert.equal(localeFor(getProfile("mobile-galaxy-a55")), "fr-FR");
  });

  test("chromium launches with native language flags and env", () => {
    const options = launchOptionsFor(getProfile("desktop-edge"));
    assert.ok(options.args!.includes("--accept-lang=de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"));
    assert.ok(options.args!.includes("--lang=de-DE"));
    assert.equal(options.env!.LANG, "de_DE.UTF-8");
  });

  test("every profile has a viewport", () => {
    for (const p of PROFILES) assert.ok(contextOptionsFor(p).viewport, p.id);
  });
});

describe("syncUserAgent", () => {
  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/151.0.7922.34 Safari/537.36";

  test("chrome uses the reduced major.0.0.0 form", () => {
    assert.match(syncUserAgent(CHROME_UA, "chromium", "152.0.7977.64"), /Chrome\/152\.0\.0\.0/);
  });

  test("edge token tracks the same version", () => {
    const ua = syncUserAgent(CHROME_UA + " Edg/151.0.0.0", "chromium", "152.0.7977.64");
    assert.match(ua, /Edg\/152\.0\.0\.0/);
  });

  test("firefox syncs rv and Firefox tokens", () => {
    const ua = syncUserAgent("Mozilla/5.0 (X11; rv:140.0) Firefox/140.0", "firefox", "153.0");
    assert.match(ua, /rv:153\.0/);
    assert.match(ua, /Firefox\/153\.0/);
  });

  test("webkit is left alone", () => {
    const ua = "Mozilla/5.0 (iPhone) Version/17.0 Safari/605.1.15";
    assert.equal(syncUserAgent(ua, "webkit", "26.5"), ua);
  });
});

describe("hardening script", () => {
  const script = hardeningScript(getProfile("mobile-pixel-7"), "152.0.7977.64");

  test("is syntactically valid standalone JS", () => {
    assert.doesNotThrow(() => new Function(script));
  });

  test("carries no bundler helpers that would throw in the page", () => {
    // The bug this guards: tsx rewrites function bodies with __name, which is
    // undefined inside the page and silently kills the whole script.
    assert.doesNotMatch(script, /__name/);
  });

  test("pins the profile's own values", () => {
    assert.match(script, /Adreno \(TM\) 730/);
    assert.match(script, /Linux armv8l/);
    assert.match(script, /"hardwareConcurrency":8/);
  });

  test("sets webdriver false rather than deleting it", () => {
    assert.match(script, /'webdriver', false/);
  });

  test("client hints only when a version is known", () => {
    assert.match(script, /"uaData":\{/);
    assert.match(hardeningScript(getProfile("mobile-pixel-7")), /"uaData":null/);
  });

  test("webkit profiles get no userAgentData", () => {
    assert.match(hardeningScript(getProfile("mobile-iphone-15"), "26.5"), /"uaData":null/);
  });
});

describe("launch options", () => {
  test("headed by default, overridable", () => {
    assert.equal(launchOptionsFor(getProfile("desktop-chrome")).headless, false);
    assert.equal(launchOptionsFor(getProfile("desktop-chrome"), { headless: true }).headless, true);
  });

  test("chromium hides the automation flags", () => {
    const options = launchOptionsFor(getProfile("desktop-chrome"));
    assert.ok(options.args!.includes("--disable-blink-features=AutomationControlled"));
    assert.ok((options.ignoreDefaultArgs as string[]).includes("--enable-automation"));
  });

  test("window size is set from the viewport", () => {
    const options = launchOptionsFor(getProfile("desktop-chrome"));
    assert.ok(options.args!.some((a) => a === "--window-size=1920,1080"));
  });

  test("caller args are kept", () => {
    const options = launchOptionsFor(getProfile("desktop-chrome"), { args: ["--mute-audio"] });
    assert.ok(options.args!.includes("--mute-audio"));
  });

  test("non-chromium engines get no chromium flags", () => {
    assert.equal(launchOptionsFor(getProfile("desktop-safari")).args, undefined);
  });
});

describe("selection", () => {
  test("getProfile throws helpfully on a typo", () => {
    assert.throws(() => getProfile("desktop-chrom"), /Unknown browser profile/);
  });

  test("filters compose", () => {
    const found = filterProfiles({ engine: "webkit", formFactor: "tablet" });
    assert.equal(found.length, 7);
    assert.ok(found.every((p) => p.engine === "webkit" && p.formFactor === "tablet"));
  });

  test("rotator hands out every profile before repeating", () => {
    const next = profileRotator({ formFactor: "mobile" });
    const seen = Array.from({ length: 10 }, next).map((p) => p.id);
    assert.equal(new Set(seen).size, 10);
  });

  test("rotator reshuffles rather than stopping", () => {
    const next = profileRotator({ formFactor: "tablet" });
    const seen = Array.from({ length: 25 }, next);
    assert.equal(seen.length, 25);
  });

  test("randomProfile respects the filter", () => {
    for (let i = 0; i < 30; i++) {
      assert.equal(randomProfile({ engine: "firefox" }).engine, "firefox");
    }
  });

  test("an impossible filter throws instead of returning undefined", () => {
    assert.throws(() => randomProfile({ engine: "firefox", formFactor: "mobile" }), /No browser profile/);
  });
});

describe("evasion selection", () => {
  // The plugin's evasions are scored by fingerprinting engines, so which ones
  // survive is a measured tradeoff: chrome.* only was headless 0% / stealth 60%
  // against CreepJS, all of them 0%/80%, none of them 33%/40%.
  const AVAILABLE = [
    "chrome.app", "chrome.csi", "chrome.loadTimes", "chrome.runtime", "media.codecs",
    "navigator.plugins", "navigator.vendor", "navigator.webdriver", "navigator.permissions",
    "iframe.contentWindow", "window.outerdimensions", "user-agent-override", "sourceurl", "defaultArgs",
  ];

  test("the default keeps only the chrome surface set", () => {
    assert.deepEqual(selectEvasions(AVAILABLE), [
      "chrome.app", "chrome.csi", "chrome.loadTimes", "chrome.runtime", "media.codecs",
    ]);
  });

  test("none disables everything", () => {
    assert.deepEqual(selectEvasions(AVAILABLE, "none"), []);
  });

  test("all keeps everything except the UA override", () => {
    const kept = selectEvasions(AVAILABLE, "all");
    assert.equal(kept.length, AVAILABLE.length - 1);
    assert.ok(!kept.includes("user-agent-override"));
  });

  test("user-agent-override never survives, whatever is asked for", () => {
    // It rewrites every context to the host UA, turning each Pixel and iPad
    // profile back into desktop Chrome on Windows.
    for (const set of ["chrome", "none", "all", "nonsense"]) {
      assert.ok(!selectEvasions(AVAILABLE, set).includes("user-agent-override"), set);
    }
  });

  test("an unknown name falls back to the default rather than disabling all", () => {
    assert.deepEqual(selectEvasions(AVAILABLE, "typo"), selectEvasions(AVAILABLE, "chrome"));
  });

  test("names absent from the build are not invented", () => {
    assert.deepEqual(selectEvasions(["chrome.app"], "chrome"), ["chrome.app"]);
    assert.deepEqual(selectEvasions([], "all"), []);
  });
});
