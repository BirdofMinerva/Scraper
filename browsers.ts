/**
 * Browser profiles for scraping: 30 fingerprints - 10 desktop, 10 mobile,
 * 10 tablet - launched through playwright-extra with the stealth plugin plus a
 * per-profile hardening script.
 *
 * Every profile is internally consistent: the UA, `navigator.platform`,
 * `userAgentData`, GPU string, core count, locale, timezone and viewport all
 * describe the same plausible machine. That consistency is the point - a
 * Windows UA reporting an Apple GPU fails a check that a plain headless
 * browser would pass.
 *
 * Browsers always launch headed (headless is the one tell the evasions cannot
 * patch away) and chromium profiles prefer an installed Chrome/Edge over the
 * bundled build. Both are handled for you: `launchProfile` starts an Xvfb
 * display if there is none, and falls back to bundled Chromium if no branded
 * build is installed.
 */
import {
  chromium as vanillaChromium,
  firefox as vanillaFirefox,
  webkit as vanillaWebkit,
  devices,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type LaunchOptions,
} from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type Engine = "chromium" | "firefox" | "webkit";
export type FormFactor = "desktop" | "mobile" | "tablet";

export type Fingerprint = {
  /** `navigator.platform` */
  platform: string;
  /** `navigator.hardwareConcurrency` */
  hardwareConcurrency: number;
  /** `navigator.deviceMemory` (GB). Chromium-only API; omit elsewhere. */
  deviceMemory?: number;
  /** UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL */
  webgl: { vendor: string; renderer: string };
  /** `userAgentData.platformVersion`; defaults per platform. */
  platformVersion?: string;
  /** `userAgentData` model - the device name on Android, "" elsewhere. */
  model?: string;
};

export type BrowserProfile = {
  /** Stable id you can pass to `getProfile()`. */
  id: string;
  /** Human readable name, e.g. "Chrome on Pixel 7". */
  name: string;
  engine: Engine;
  formFactor: FormFactor;
  /** Playwright `devices[...]` key, when the profile is device based. */
  device?: keyof typeof devices;
  /** Extra context options merged on top of the device descriptor. */
  contextOptions?: BrowserContextOptions;
  /**
   * Branded build to launch, most specific first. A real Chrome/Edge install
   * has the codecs, GPU stack and version string the bundled Chromium lacks;
   * `launchProfile` walks the list and ends on bundled Chromium if none are
   * installed.
   */
  channels?: string[];
  fingerprint: Fingerprint;
};

// ---------------------------------------------------------------------------
// Building blocks
//
// Shared so that a GPU string is written once and every profile that claims
// that machine reuses it, and so locale can never drift from timezone.
// ---------------------------------------------------------------------------

const WIN = "Win32";
const MAC = "MacIntel";
const LINUX = "Linux x86_64";
const ANDROID = "Linux armv8l";
const IPHONE = "iPhone";
const IPAD = "iPad";

const GPU = {
  nvidiaWin: {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  amdWin: {
    vendor: "Google Inc. (AMD)",
    renderer:
      "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  intelWin: {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  intelWinIris: {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  mesaIntel: {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)",
  },
  appleSilicon: { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" },
  // WebKit reports these unadorned, unlike ANGLE-backed Chromium.
  safariApple: { vendor: "Apple Inc.", renderer: "Apple GPU" },
  mozilla: { vendor: "Mozilla", renderer: "Mozilla" },
  adreno730: { vendor: "Qualcomm", renderer: "Adreno (TM) 730" },
  adreno740: { vendor: "Qualcomm", renderer: "Adreno (TM) 740" },
  adreno750: { vendor: "Qualcomm", renderer: "Adreno (TM) 750" },
  adreno630: { vendor: "Qualcomm", renderer: "Adreno (TM) 630" },
  adreno620: { vendor: "Qualcomm", renderer: "Adreno (TM) 620" },
  maliG72: { vendor: "ARM", renderer: "Mali-G72" },
  maliG68: { vendor: "ARM", renderer: "Mali-G68" },
} as const;

/** Locale and timezone always travel together; splitting them is a tell. */
const REGION = {
  usEast: { locale: "en-US", timezoneId: "America/New_York" },
  usCentral: { locale: "en-US", timezoneId: "America/Chicago" },
  usWest: { locale: "en-US", timezoneId: "America/Los_Angeles" },
  uk: { locale: "en-GB", timezoneId: "Europe/London" },
  de: { locale: "de-DE", timezoneId: "Europe/Berlin" },
  fr: { locale: "fr-FR", timezoneId: "Europe/Paris" },
  nl: { locale: "nl-NL", timezoneId: "Europe/Amsterdam" },
  ca: { locale: "en-CA", timezoneId: "America/Toronto" },
  au: { locale: "en-AU", timezoneId: "Australia/Sydney" },
  es: { locale: "es-ES", timezoneId: "Europe/Madrid" },
} as const;

/**
 * Chrome versions in custom UA strings are placeholders: `launchProfile`
 * rewrites them to the version actually running, so the UA can never
 * contradict `navigator.userAgentData`.
 */
const CHROME_UA_VERSION = "0.0.0.0";
const FIREFOX_UA_VERSION = "0.0";

const chromeUA = (osPart: string) =>
  `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_UA_VERSION} Safari/537.36`;
const firefoxUA = (osPart: string) =>
  `Mozilla/5.0 (${osPart}; rv:${FIREFOX_UA_VERSION}) Gecko/20100101 Firefox/${FIREFOX_UA_VERSION}`;

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/** 10 desktop machines: 6 chromium, 2 firefox, 2 webkit. */
const DESKTOP_PROFILES: BrowserProfile[] = [
  {
    id: "desktop-chrome",
    name: "Chrome on Windows (NVIDIA)",
    engine: "chromium",
    formFactor: "desktop",
    device: "Desktop Chrome",
    channels: ["chrome"],
    contextOptions: { ...REGION.usEast, viewport: { width: 1920, height: 1080 } },
    fingerprint: {
      platform: WIN,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.nvidiaWin,
    },
  },
  {
    id: "desktop-chrome-hidpi",
    name: "Chrome on Windows HiDPI (AMD)",
    engine: "chromium",
    formFactor: "desktop",
    device: "Desktop Chrome HiDPI",
    channels: ["chrome"],
    contextOptions: { ...REGION.usWest, viewport: { width: 2560, height: 1440 } },
    fingerprint: {
      platform: WIN,
      hardwareConcurrency: 16,
      deviceMemory: 16,
      webgl: GPU.amdWin,
    },
  },
  {
    id: "desktop-chrome-intel",
    name: "Chrome on Windows (Intel laptop)",
    engine: "chromium",
    formFactor: "desktop",
    device: "Desktop Chrome",
    channels: ["chrome"],
    contextOptions: { ...REGION.uk, viewport: { width: 1536, height: 864 } },
    fingerprint: {
      platform: WIN,
      hardwareConcurrency: 12,
      deviceMemory: 16,
      webgl: GPU.intelWinIris,
    },
  },
  {
    id: "desktop-edge",
    name: "Edge on Windows",
    engine: "chromium",
    formFactor: "desktop",
    device: "Desktop Edge",
    channels: ["msedge", "chrome"],
    contextOptions: { ...REGION.de, viewport: { width: 1920, height: 1080 } },
    fingerprint: {
      platform: WIN,
      hardwareConcurrency: 8,
      deviceMemory: 16,
      webgl: GPU.intelWin,
    },
  },
  {
    id: "desktop-chrome-mac",
    name: "Chrome on macOS",
    engine: "chromium",
    formFactor: "desktop",
    device: "Desktop Chrome",
    channels: ["chrome"],
    contextOptions: {
      ...REGION.usCentral,
      userAgent: chromeUA("Macintosh; Intel Mac OS X 10_15_7"),
      viewport: { width: 1512, height: 945 },
      deviceScaleFactor: 2,
    },
    fingerprint: {
      platform: MAC,
      hardwareConcurrency: 10,
      deviceMemory: 8,
      webgl: GPU.appleSilicon,
      platformVersion: "14.6.0",
    },
  },
  {
    id: "desktop-chrome-linux",
    name: "Chrome on Linux",
    engine: "chromium",
    formFactor: "desktop",
    device: "Desktop Chrome",
    channels: ["chrome"],
    contextOptions: {
      ...REGION.nl,
      userAgent: chromeUA("X11; Linux x86_64"),
      viewport: { width: 1920, height: 1080 },
    },
    fingerprint: {
      platform: LINUX,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.mesaIntel,
      platformVersion: "6.8.0",
    },
  },
  {
    id: "desktop-firefox",
    name: "Firefox on Windows",
    engine: "firefox",
    formFactor: "desktop",
    device: "Desktop Firefox",
    contextOptions: { ...REGION.usEast, viewport: { width: 1920, height: 1080 } },
    fingerprint: { platform: WIN, hardwareConcurrency: 8, webgl: GPU.mozilla },
  },
  {
    id: "desktop-firefox-linux",
    name: "Firefox on Linux",
    engine: "firefox",
    formFactor: "desktop",
    device: "Desktop Firefox",
    contextOptions: {
      ...REGION.fr,
      userAgent: firefoxUA("X11; Linux x86_64"),
      viewport: { width: 1680, height: 1050 },
    },
    fingerprint: { platform: LINUX, hardwareConcurrency: 12, webgl: GPU.mozilla },
  },
  {
    id: "desktop-safari",
    name: "Safari on macOS (Apple silicon)",
    engine: "webkit",
    formFactor: "desktop",
    device: "Desktop Safari",
    contextOptions: {
      ...REGION.usWest,
      viewport: { width: 1728, height: 1080 },
      deviceScaleFactor: 2,
    },
    fingerprint: {
      platform: MAC,
      hardwareConcurrency: 10,
      webgl: GPU.safariApple,
    },
  },
  {
    id: "desktop-safari-intel",
    name: "Safari on macOS (Intel)",
    engine: "webkit",
    formFactor: "desktop",
    device: "Desktop Safari",
    contextOptions: { ...REGION.au, viewport: { width: 1440, height: 900 } },
    fingerprint: {
      platform: MAC,
      hardwareConcurrency: 8,
      webgl: { vendor: "Apple Inc.", renderer: "AMD Radeon Pro 5500M OpenGL Engine" },
    },
  },
];

/** 10 phones: 5 Android (chromium), 5 iPhone (webkit). */
const MOBILE_PROFILES: BrowserProfile[] = [
  {
    id: "mobile-pixel-7",
    name: "Chrome on Pixel 7",
    engine: "chromium",
    formFactor: "mobile",
    device: "Pixel 7",
    channels: ["chrome"],
    contextOptions: REGION.usEast,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.adreno730,
      platformVersion: "14.0.0",
      model: "Pixel 7",
    },
  },
  {
    id: "mobile-pixel-5",
    name: "Chrome on Pixel 5",
    engine: "chromium",
    formFactor: "mobile",
    device: "Pixel 5",
    channels: ["chrome"],
    contextOptions: REGION.usWest,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.adreno620,
      platformVersion: "13.0.0",
      model: "Pixel 5",
    },
  },
  {
    id: "mobile-galaxy-s24",
    name: "Chrome on Galaxy S24",
    engine: "chromium",
    formFactor: "mobile",
    device: "Galaxy S24",
    channels: ["chrome"],
    contextOptions: REGION.uk,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.adreno750,
      platformVersion: "14.0.0",
      model: "SM-S921B",
    },
  },
  {
    id: "mobile-galaxy-s9",
    name: "Chrome on Galaxy S9+",
    engine: "chromium",
    formFactor: "mobile",
    device: "Galaxy S9+",
    channels: ["chrome"],
    contextOptions: REGION.de,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 6,
      webgl: GPU.maliG72,
      platformVersion: "10.0.0",
      model: "SM-G965F",
    },
  },
  {
    id: "mobile-galaxy-a55",
    name: "Chrome on Galaxy A55",
    engine: "chromium",
    formFactor: "mobile",
    device: "Galaxy A55",
    channels: ["chrome"],
    contextOptions: REGION.fr,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.maliG68,
      platformVersion: "14.0.0",
      model: "SM-A556B",
    },
  },
  {
    id: "mobile-iphone-15-pro",
    name: "Safari on iPhone 15 Pro",
    engine: "webkit",
    formFactor: "mobile",
    device: "iPhone 15 Pro",
    contextOptions: REGION.usEast,
    fingerprint: {
      platform: IPHONE,
      hardwareConcurrency: 6,
      webgl: GPU.safariApple,
    },
  },
  {
    id: "mobile-iphone-15",
    name: "Safari on iPhone 15",
    engine: "webkit",
    formFactor: "mobile",
    device: "iPhone 15",
    contextOptions: REGION.usWest,
    fingerprint: {
      platform: IPHONE,
      hardwareConcurrency: 6,
      webgl: GPU.safariApple,
    },
  },
  {
    id: "mobile-iphone-14",
    name: "Safari on iPhone 14",
    engine: "webkit",
    formFactor: "mobile",
    device: "iPhone 14",
    contextOptions: REGION.ca,
    fingerprint: {
      platform: IPHONE,
      hardwareConcurrency: 6,
      webgl: GPU.safariApple,
    },
  },
  {
    id: "mobile-iphone-13",
    name: "Safari on iPhone 13",
    engine: "webkit",
    formFactor: "mobile",
    device: "iPhone 13",
    contextOptions: REGION.au,
    fingerprint: {
      platform: IPHONE,
      hardwareConcurrency: 6,
      webgl: GPU.safariApple,
    },
  },
  {
    id: "mobile-iphone-se",
    name: "Safari on iPhone SE (3rd gen)",
    engine: "webkit",
    formFactor: "mobile",
    device: "iPhone SE (3rd gen)",
    contextOptions: REGION.es,
    fingerprint: {
      platform: IPHONE,
      hardwareConcurrency: 6,
      webgl: GPU.safariApple,
    },
  },
];

/** 10 tablets: 7 iPad (webkit), 3 Galaxy Tab (chromium). */
const TABLET_PROFILES: BrowserProfile[] = [
  {
    id: "tablet-ipad-pro-11",
    name: "Safari on iPad Pro 11",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad Pro 11",
    contextOptions: REGION.usEast,
    fingerprint: { platform: IPAD, hardwareConcurrency: 8, webgl: GPU.safariApple },
  },
  {
    id: "tablet-ipad-pro-11-landscape",
    name: "Safari on iPad Pro 11 (landscape)",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad Pro 11 landscape",
    contextOptions: REGION.usWest,
    fingerprint: { platform: IPAD, hardwareConcurrency: 8, webgl: GPU.safariApple },
  },
  {
    id: "tablet-ipad-mini",
    name: "Safari on iPad Mini",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad Mini",
    contextOptions: REGION.uk,
    fingerprint: { platform: IPAD, hardwareConcurrency: 6, webgl: GPU.safariApple },
  },
  {
    id: "tablet-ipad-gen-11",
    name: "Safari on iPad (gen 11)",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad (gen 11)",
    contextOptions: REGION.de,
    fingerprint: { platform: IPAD, hardwareConcurrency: 8, webgl: GPU.safariApple },
  },
  {
    id: "tablet-ipad-gen-7",
    name: "Safari on iPad (gen 7)",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad (gen 7)",
    contextOptions: REGION.fr,
    fingerprint: { platform: IPAD, hardwareConcurrency: 4, webgl: GPU.safariApple },
  },
  {
    id: "tablet-ipad-gen-6",
    name: "Safari on iPad (gen 6)",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad (gen 6)",
    contextOptions: REGION.nl,
    fingerprint: { platform: IPAD, hardwareConcurrency: 4, webgl: GPU.safariApple },
  },
  {
    id: "tablet-ipad-gen-5",
    name: "Safari on iPad (gen 5)",
    engine: "webkit",
    formFactor: "tablet",
    device: "iPad (gen 5)",
    contextOptions: REGION.ca,
    fingerprint: { platform: IPAD, hardwareConcurrency: 4, webgl: GPU.safariApple },
  },
  {
    id: "tablet-galaxy-tab-s9",
    name: "Chrome on Galaxy Tab S9",
    engine: "chromium",
    formFactor: "tablet",
    device: "Galaxy Tab S9",
    channels: ["chrome"],
    contextOptions: REGION.usCentral,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.adreno740,
      platformVersion: "14.0.0",
      model: "SM-X710",
    },
  },
  {
    id: "tablet-galaxy-tab-s9-landscape",
    name: "Chrome on Galaxy Tab S9 (landscape)",
    engine: "chromium",
    formFactor: "tablet",
    device: "Galaxy Tab S9 landscape",
    channels: ["chrome"],
    contextOptions: REGION.au,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: GPU.adreno740,
      platformVersion: "14.0.0",
      model: "SM-X710",
    },
  },
  {
    id: "tablet-galaxy-tab-s4",
    name: "Chrome on Galaxy Tab S4",
    engine: "chromium",
    formFactor: "tablet",
    device: "Galaxy Tab S4",
    channels: ["chrome"],
    contextOptions: REGION.es,
    fingerprint: {
      platform: ANDROID,
      hardwareConcurrency: 8,
      deviceMemory: 4,
      webgl: GPU.adreno630,
      platformVersion: "10.0.0",
      model: "SM-T835",
    },
  },
];

export const PROFILES: BrowserProfile[] = [
  ...DESKTOP_PROFILES,
  ...MOBILE_PROFILES,
  ...TABLET_PROFILES,
];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Look up a profile by id. Throws if it does not exist. */
export function getProfile(id: string): BrowserProfile {
  const profile = PROFILES.find((p) => p.id === id);
  if (!profile) {
    throw new Error(
      `Unknown browser profile "${id}". Known: ${PROFILES.map((p) => p.id).join(", ")}`
    );
  }
  return profile;
}

/** Filter the catalog, e.g. `filterProfiles({ formFactor: "mobile" })`. */
export function filterProfiles(
  filter: {
    engine?: Engine | Engine[];
    formFactor?: FormFactor | FormFactor[];
  } = {}
): BrowserProfile[] {
  const engineList = filter.engine
    ? ([] as Engine[]).concat(filter.engine)
    : undefined;
  const formList = filter.formFactor
    ? ([] as FormFactor[]).concat(filter.formFactor)
    : undefined;

  return PROFILES.filter(
    (p) =>
      (!engineList || engineList.includes(p.engine)) &&
      (!formList || formList.includes(p.formFactor))
  );
}

/** Pick a random profile, optionally restricted by the same filter. */
export function randomProfile(
  filter?: Parameters<typeof filterProfiles>[0]
): BrowserProfile {
  const pool = filterProfiles(filter);
  if (pool.length === 0) {
    throw new Error("No browser profile matches the given filter");
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Endless non-repeating rotation over a pool: it shuffles, hands out every
 * profile once, then reshuffles. Better than `randomProfile()` in a loop,
 * which will happily serve the same fingerprint three times in a row.
 */
export function profileRotator(
  filter?: Parameters<typeof filterProfiles>[0]
): () => BrowserProfile {
  const pool = filterProfiles(filter);
  if (pool.length === 0) {
    throw new Error("No browser profile matches the given filter");
  }

  let queue: BrowserProfile[] = [];
  return () => {
    if (queue.length === 0) {
      queue = [...pool];
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
    }
    return queue.pop()!;
  };
}

// ---------------------------------------------------------------------------
// Context configuration
// ---------------------------------------------------------------------------

/** The locale a profile claims, before any context is built. */
export function localeFor(profile: BrowserProfile): string {
  const device = profile.device ? (devices[profile.device] as { locale?: string }) : undefined;
  return profile.contextOptions?.locale ?? device?.locale ?? "en-US";
}

/**
 * The Accept-Language header a real browser would send for that locale.
 *
 * Chrome sends a weighted list - `de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7` - never
 * a bare locale. Playwright's `locale` option produces exactly that bare form
 * on the main navigation request, which is the one an anti-bot service reads.
 */
export function acceptLanguageFor(profile: BrowserProfile): string {
  return languagesFor(localeFor(profile))
    .map((lang, i) => (i === 0 ? lang : `${lang};q=${(1 - i * 0.1).toFixed(1)}`))
    .join(",");
}

/** The language list a locale implies, in the order a real browser sends it. */
function languagesFor(locale: string): string[] {
  const base = locale.split("-")[0];
  const languages = [locale, base];
  if (base !== "en") languages.push("en-US", "en");
  return languages;
}

/**
 * The context options a profile maps to: the device descriptor, the profile
 * overrides, plus defaults that keep a fresh context from standing out (a real
 * browser always sends an Accept-Language header).
 */
export function contextOptionsFor(
  profile: BrowserProfile
): BrowserContextOptions {
  const merged: BrowserContextOptions = {
    ...(profile.device ? devices[profile.device] : {}),
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "light",
    ...profile.contextOptions,
  };

  const options: BrowserContextOptions = {
    ...merged,
    extraHTTPHeaders: {
      "Accept-Language": acceptLanguageFor(profile),
      ...merged.extraHTTPHeaders,
    },
  };

  // Chromium only: Playwright's `locale` wins over extraHTTPHeaders on the
  // main navigation request and sends the bare locale with no q-values, which
  // no real Chrome does. `launchOptionsFor` passes --accept-lang and a LANG
  // env instead, which sets the header, navigator.language and number
  // formatting natively - no patching, and correct on the first request.
  // Firefox and WebKit honour extraHTTPHeaders as-is, so they keep `locale`.
  if (profile.engine === "chromium") delete options.locale;

  return options;
}

/** Rewrite engine versions in a UA so it matches the browser actually running. */
export function syncUserAgent(
  userAgent: string,
  engine: Engine,
  browserVersion: string
): string {
  const major = browserVersion.split(".")[0];
  if (engine === "chromium") {
    // Chrome's UA has been version-reduced since 101: the string carries
    // `major.0.0.0` and the real build number lives in the client hints only.
    return userAgent
      .replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`)
      .replace(/Edg\/[\d.]+/, `Edg/${major}.0.0.0`);
  }
  if (engine === "firefox") {
    return userAgent
      .replace(/rv:[\d.]+/, `rv:${major}.0`)
      .replace(/Firefox\/[\d.]+/, `Firefox/${major}.0`);
  }
  return userAgent;
}

/** `navigator.userAgentData` values, or null for engines that lack the API. */
function uaDataFor(
  profile: BrowserProfile,
  browserVersion: string,
  brand: "chrome" | "edge"
) {
  if (profile.engine !== "chromium") return null;

  const { platform, platformVersion, model } = profile.fingerprint;
  const uaPlatform =
    platform === WIN
      ? "Windows"
      : platform === MAC
        ? "macOS"
        : platform === ANDROID
          ? "Android"
          : "Linux";

  const major = browserVersion.split(".")[0];
  const brands = [
    { brand: "Chromium", version: major },
    { brand: brand === "edge" ? "Microsoft Edge" : "Google Chrome", version: major },
    { brand: "Not_A Brand", version: "24" },
  ];

  return {
    brands,
    fullVersionList: brands.map((b) => ({
      brand: b.brand,
      version: b.brand === "Not_A Brand" ? "24.0.0.0" : browserVersion,
    })),
    mobile: profile.formFactor !== "desktop",
    platform: uaPlatform,
    platformVersion:
      platformVersion ?? (uaPlatform === "Windows" ? "15.0.0" : "14.0.0"),
    architecture: uaPlatform === "Android" ? "arm" : "x86",
    bitness: "64",
    model: model ?? "",
    uaFullVersion: browserVersion,
    wow64: false,
  };
}

// ---------------------------------------------------------------------------
// Hardening
// ---------------------------------------------------------------------------

const stealth = StealthPlugin();

/**
 * Which of the plugin's evasions to keep - measured, not assumed.
 *
 * Against CreepJS (chromium, headed, real Chrome), same profiles each time:
 *
 *   every evasion       headless 0%    stealth 80%
 *   chrome.* only       headless 0%    stealth 60%   <- default
 *   none at all         headless 33%   stealth 40%
 *
 * The default trades a little stealth score for the headless score; use
 * BROWSERS_EVASIONS=none when a target weights stealth-patching detection
 * more heavily than headless heuristics, which DataDome appears to.
 *
 * The chrome.* evasions restore the `window.chrome` surface that the headless
 * score keys on. The louder ones - navigator.plugins, iframe.contentWindow,
 * window.outerdimensions - are published signatures that fingerprinting engines
 * score directly, and they buy nothing for a headed real Chrome that already
 * has what they fake.
 *
 * `user-agent-override` must stay off whatever else changes: it rewrites every
 * context to the host browser's UA, silently turning each Pixel and iPad
 * profile back into desktop Chrome on Windows.
 *
 * BROWSERS_EVASIONS=none | chrome | all
 */
const EVASION_SETS: Record<string, string[] | null> = {
  chrome: ["chrome.app", "chrome.csi", "chrome.loadTimes", "chrome.runtime", "media.codecs"],
  none: [],
  all: null, // everything except user-agent-override
};

/**
 * Which evasions survive, given the available set and a chosen name.
 *
 * Pure so it can be tested without launching anything: an unknown name must
 * fall back rather than silently disable everything, and `user-agent-override`
 * must never survive, whatever is asked for.
 */
export function selectEvasions(
  available: Iterable<string>,
  setName = "chrome"
): string[] {
  // `in`, not `??`: the "all" set is deliberately null, and nullish-coalescing
  // would treat it as absent and quietly fall back to the default.
  const keep = setName in EVASION_SETS ? EVASION_SETS[setName] : EVASION_SETS.chrome;
  return [...available].filter((evasion) =>
    evasion === "user-agent-override"
      ? false
      : keep === null || keep.includes(evasion)
  );
}

const kept = new Set(
  selectEvasions(stealth.enabledEvasions, process.env.BROWSERS_EVASIONS ?? "chrome")
);
for (const evasion of [...stealth.enabledEvasions]) {
  if (!kept.has(evasion)) stealth.enabledEvasions.delete(evasion);
}

const stealthChromium = addExtra(vanillaChromium);
if (stealth.enabledEvasions.size > 0) {
  stealthChromium.use(stealth);
}

const launchers = {
  chromium: stealthChromium,
  firefox: addExtra(vanillaFirefox),
  webkit: addExtra(vanillaWebkit),
} as const;

/**
 * The hardening script, as source text.
 *
 * It is built as a string rather than passed to `addInitScript` as a function
 * on purpose: TS runners (tsx/esbuild, ts-node) rewrite function bodies with
 * helpers such as `__name`, which are not defined inside the page and make the
 * whole script throw silently. A string survives any build pipeline.
 */
export function hardeningScript(
  profile: BrowserProfile,
  browserVersion = "",
  brand: "chrome" | "edge" = "chrome"
): string {
  const locale = localeFor(profile);
  const config = {
    platform: profile.fingerprint.platform,
    hardwareConcurrency: profile.fingerprint.hardwareConcurrency,
    deviceMemory: profile.fingerprint.deviceMemory ?? null,
    webgl: profile.fingerprint.webgl,
    languages: languagesFor(locale),
    uaData: browserVersion ? uaDataFor(profile, browserVersion, brand) : null,
  };

  return `(function () {
  var cfg = ${JSON.stringify(config)};
  var touched = 0;

  // Redefine only, and only when the value is actually wrong.
  //
  // Every patch is evidence of patching, and that is what fingerprinting
  // engines score - CreepJS rated this browser 60% stealth when a third of the
  // script was silently dead and 80% once it all ran. So: read first, write
  // only on a mismatch. Where a profile matches the host, nothing is touched
  // at all and there is nothing to find.
  //
  // Creating a property the host build lacks is worse still: it lands at the
  // end of getOwnPropertyNames in a position no real browser has, which is how
  // deviceMemory gave the game away on a build that does not expose it.
  function define(target, prop, value) {
    try {
      if (!(prop in target)) return false;
      if (sameValue(target === Navigator.prototype ? navigator[prop] : target[prop], value)) {
        return false;
      }
      var existing = Object.getOwnPropertyDescriptor(target, prop);
      Object.defineProperty(target, prop, {
        get: function () { return value; },
        enumerable: existing ? existing.enumerable : true,
        configurable: existing ? existing.configurable : true
      });
      touched++;
      return true;
    } catch (e) { return false; }
  }

  function sameValue(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every(function (x, i) { return x === b[i]; });
    }
    return a === b;
  }

  // A replacement function keeps its own name and arity, so a patched
  // getParameter answers to "patchedGet" - cheaper to check than any source.
  function impersonate(fn, name, length) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      Object.defineProperty(fn, 'length', { value: length, configurable: true });
    } catch (e) {}
  }

  // navigator.webdriver is already false when chromium launches with
  // --disable-blink-features=AutomationControlled, so this is usually a no-op.
  define(Navigator.prototype, 'webdriver', false);
  define(Navigator.prototype, 'platform', cfg.platform);
  define(Navigator.prototype, 'hardwareConcurrency', cfg.hardwareConcurrency);
  if (cfg.deviceMemory !== null) {
    define(Navigator.prototype, 'deviceMemory', cfg.deviceMemory);
  }
  define(Navigator.prototype, 'languages', Object.freeze(cfg.languages.slice()));

  var patched = new Map();

  // Client hints must agree with the UA string. Playwright already derives most
  // of them from an overridden userAgent, so this only fires when it has not.
  if (cfg.uaData && navigator.userAgentData &&
      navigator.userAgentData.platform !== cfg.uaData.platform) {
    var d = cfg.uaData;
    var lowEntropy = { brands: d.brands, mobile: d.mobile, platform: d.platform };
    var getHighEntropyValues = function (hints) {
      var out = { brands: d.brands, mobile: d.mobile, platform: d.platform };
      (hints || []).forEach(function (hint) { if (hint in d) out[hint] = d[hint]; });
      return Promise.resolve(out);
    };
    impersonate(getHighEntropyValues, 'getHighEntropyValues', 1);
    patched.set(getHighEntropyValues, navigator.userAgentData.getHighEntropyValues);

    // defineProperty, not Object.assign: assign goes through [[Set]], walks the
    // prototype chain, hits NavigatorUAData's getter-only accessors and throws -
    // which silently killed every patch below this point for a while.
    var uaData = Object.create(Object.getPrototypeOf(navigator.userAgentData));
    Object.defineProperty(uaData, 'brands', { get: function () { return d.brands; }, enumerable: true, configurable: true });
    Object.defineProperty(uaData, 'mobile', { get: function () { return d.mobile; }, enumerable: true, configurable: true });
    Object.defineProperty(uaData, 'platform', { get: function () { return d.platform; }, enumerable: true, configurable: true });
    Object.defineProperty(uaData, 'getHighEntropyValues', { value: getHighEntropyValues, writable: true, configurable: true });
    Object.defineProperty(uaData, 'toJSON', { value: function () { return lowEntropy; }, writable: true, configurable: true });
    define(Navigator.prototype, 'userAgentData', uaData);
  }

  // WebGL vendor/renderer, kept consistent with the claimed platform - but only
  // if the host does not already report them correctly.
  var UNMASKED_VENDOR = 0x9245, UNMASKED_RENDERER = 0x9246;
  var current = null;
  try {
    var probe = document.createElement('canvas').getContext('webgl');
    current = probe && probe.getParameter(UNMASKED_RENDERER);
  } catch (e) {}

  if (current !== cfg.webgl.renderer) {
    [self.WebGLRenderingContext, self.WebGL2RenderingContext].forEach(function (ctor) {
      if (!ctor) return;
      var getParameter = ctor.prototype.getParameter;
      var patchedGet = function (parameter) {
        if (parameter === UNMASKED_VENDOR) return cfg.webgl.vendor;
        if (parameter === UNMASKED_RENDERER) return cfg.webgl.renderer;
        return getParameter.apply(this, arguments);
      };
      impersonate(patchedGet, 'getParameter', 1);
      patched.set(patchedGet, getParameter);
      ctor.prototype.getParameter = patchedGet;
      touched++;
    });
  }

  // Only cloak toString if something was actually replaced. Patching it when
  // there is nothing to hide is pure signal for no benefit, and it is among the
  // most heavily probed functions there is.
  if (patched.size > 0) {
    var toString = Function.prototype.toString;
    var patchedToString = function () {
      if (this === patchedToString) return toString.call(toString);
      var original = patched.get(this);
      return toString.call(original || this);
    };
    impersonate(patchedToString, 'toString', 0);
    Function.prototype.toString = patchedToString;
  }
})();`;
}

/**
 * Patch the JS-visible automation tells inside a context.
 *
 * Runs before any page script, on every page and frame. This is what covers
 * firefox and webkit, where the stealth plugin's chromium evasions do not
 * apply, and it pins every value to what the profile claims.
 *
 * Pass `browserVersion` (from `browser.version()`) so the client hints match
 * the build that is actually running.
 */
export async function hardenContext(
  context: BrowserContext,
  profile: BrowserProfile,
  options: { browserVersion?: string; brand?: "chrome" | "edge" } = {}
): Promise<void> {
  await context.addInitScript({
    content: hardeningScript(
      profile,
      options.browserVersion ?? "",
      options.brand ?? "chrome"
    ),
  });
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/**
 * Chromium flags that remove the loudest automation tells:
 * `AutomationControlled` is what sets `navigator.webdriver`, and the default
 * `--enable-automation` flag shows up in the "Chrome is being controlled by
 * automated software" infobar and in several JS-visible surfaces.
 */
const CHROMIUM_STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
];

const CHROMIUM_IGNORED_DEFAULT_ARGS = ["--enable-automation"];

/**
 * Launch options a profile needs, merged with the caller's overrides.
 *
 * Headed by default: headless builds still leak (missing GPU/codec surfaces,
 * no window chrome, distinct rendering timings), and that is the one tell the
 * evasions here cannot patch away. Pass `{ headless: true }` to override.
 */
export function launchOptionsFor(
  profile: BrowserProfile,
  overrides: LaunchOptions = {}
): LaunchOptions {
  const base: LaunchOptions = { headless: false, ...overrides };

  if (profile.engine !== "chromium") return base;

  // Headed chromium resizes the real OS window to match the viewport, and that
  // resize fails outright when several browsers do it at once or when a
  // portrait tablet is taller than the screen. Creating the window at the
  // right size up front makes the resize a no-op.
  const viewport = contextOptionsFor(profile).viewport;
  const windowSize =
    base.headless === false && viewport
      ? [`--window-size=${viewport.width},${viewport.height}`, "--window-position=0,0"]
      : [];

  // Native language handling: the flag drives the Accept-Language header and
  // navigator.language, the env drives ICU, so Intl formatting agrees with
  // both. See contextOptionsFor for why this is not done with `locale`.
  const locale = localeFor(profile);
  const language = [
    `--accept-lang=${acceptLanguageFor(profile)}`,
    `--lang=${locale}`,
  ];
  const env = {
    ...(process.env as Record<string, string>),
    LANG: `${locale.replace("-", "_")}.UTF-8`,
    LC_ALL: `${locale.replace("-", "_")}.UTF-8`,
    ...base.env,
  };

  return {
    ...base,
    env,
    args: [...CHROMIUM_STEALTH_ARGS, ...language, ...windowSize, ...(base.args ?? [])],
    ignoreDefaultArgs:
      base.ignoreDefaultArgs === true
        ? true
        : [
            ...CHROMIUM_IGNORED_DEFAULT_ARGS,
            ...(Array.isArray(base.ignoreDefaultArgs)
              ? base.ignoreDefaultArgs
              : []),
          ],
  };
}

let xvfb: ChildProcess | undefined;

/**
 * The virtual screen headed browsers need.
 *
 * A headed window has to physically fit on screen: chromium resizes the real
 * OS window to the viewport, and that resize fails intermittently once the
 * window is taller or wider than the display - which the HiDPI desktop
 * profile (2560 wide) and the portrait tablets (1138 CSS px plus browser
 * chrome, scaled) both are on an ordinary 1920x1080 monitor.
 */
const REQUIRED_SCREEN = { width: 2560, height: 2560 };

/** Screen size of the given display, or null if it cannot be measured. */
function screenSize(display: string): { width: number; height: number } | null {
  const out = spawnSync("xdpyinfo", ["-display", display], { encoding: "utf8" });
  const match = out.stdout?.match(/dimensions:\s+(\d+)x(\d+)/);
  return match ? { width: +match[1], height: +match[2] } : null;
}

/**
 * Make sure there is an X display big enough to launch headed browsers into.
 *
 * Starts Xvfb when there is no display, and also when the current one is too
 * small for the largest profile window - a scraper usually runs without a
 * desktop session, and a 1080p monitor cannot hold every profile. Set
 * `BROWSERS_USE_CURRENT_DISPLAY=1` to stay on the existing display and watch
 * the browsers work (expect resize errors on the biggest profiles).
 */
export function ensureDisplay(): void {
  if (process.platform !== "linux" || xvfb) return;

  const current = process.env.DISPLAY;
  if (current && process.env.BROWSERS_USE_CURRENT_DISPLAY === "1") return;
  if (current) {
    const size = screenSize(current);
    // Unmeasurable (no xdpyinfo) means trust it rather than hijack it.
    if (!size) return;
    if (
      size.width >= REQUIRED_SCREEN.width &&
      size.height >= REQUIRED_SCREEN.height
    ) {
      return;
    }
  }

  if (spawnSync("which", ["Xvfb"], { encoding: "utf8" }).status !== 0) {
    if (current) return; // too small, but it is all we have
    throw new Error(
      "Headed browsers need a display: set DISPLAY, or install Xvfb " +
        "(`apt install xvfb`) so one can be started automatically."
    );
  }

  // :99 upwards; the lock file is what X itself uses to claim a display.
  let display = 99;
  while (
    spawnSync("test", ["-e", `/tmp/.X${display}-lock`]).status === 0 &&
    display < 200
  ) {
    display++;
  }

  xvfb = spawn(
    "Xvfb",
    [
      `:${display}`,
      "-screen",
      "0",
      `${REQUIRED_SCREEN.width}x${REQUIRED_SCREEN.height}x24`,
      "-nolisten",
      "tcp",
    ],
    { stdio: "ignore" }
  );
  xvfb.unref();
  process.env.DISPLAY = `:${display}`;

  const stop = () => {
    xvfb?.kill();
    xvfb = undefined;
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(130);
  });
}

export type Session = {
  browser: Browser;
  context: BrowserContext;
  profile: BrowserProfile;
  /** The channel that actually launched, or undefined for bundled Chromium. */
  channel?: string;
};

/**
 * Launch a stealth browser and open a context configured for the profile.
 *
 * Always headed, and always on a branded build when the profile names one and
 * it is installed. Close the browser when you are done: `await browser.close()`.
 */
export async function launchProfile(
  profile: BrowserProfile,
  launchOptions: LaunchOptions = {},
  contextOverrides: BrowserContextOptions = {}
): Promise<Session> {
  const options = launchOptionsFor(profile, launchOptions);
  if (options.headless === false) ensureDisplay();

  // An explicit channel from the caller wins; otherwise walk the profile's
  // list and fall back to bundled Chromium (`undefined`) if none are present.
  const candidates =
    "channel" in launchOptions
      ? [launchOptions.channel]
      : [...(profile.channels ?? []), undefined];

  let browser: Browser | undefined;
  let channel: string | undefined;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      browser = await launchers[profile.engine].launch({
        ...options,
        channel: candidate,
      });
      channel = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!browser) throw lastError;

  const version = browser.version();
  const brand = channel === "msedge" ? "edge" : "chrome";
  const base = contextOptionsFor(profile);
  let userAgent = base.userAgent
    ? syncUserAgent(base.userAgent, profile.engine, version)
    : undefined;
  // An Edge profile that fell back to Chrome must stop claiming to be Edge.
  if (brand === "chrome" && userAgent) {
    userAgent = userAgent.replace(/ Edg\/[\d.]+/, "");
  }

  const context = await browser.newContext({
    ...base,
    ...(userAgent ? { userAgent } : {}),
    ...contextOverrides,
  });
  await hardenContext(context, profile, { browserVersion: version, brand });

  return { browser, context, profile, channel };
}
