/**
 * Parity tests: a hardened context must be distinguishable from a vanilla one
 * only by the values it claims — never by the shape of the objects carrying
 * them.
 *
 * These exist because the hardening script once threw a third of the way in
 * (Object.assign onto NavigatorUAData's getter-only accessors) and silently
 * lost the WebGL, permissions and toString patches. Every value test still
 * passed, because the values it checked were set before the throw.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  getProfile, hardeningScript, contextOptionsFor, ensureDisplay,
  launchProfile, acceptLanguageFor, localeFor,
} from "../browsers";

const PROFILE = getProfile("desktop-chrome");
const MINUTE = 60_000;

/** Metadata a detector can read without ever looking at a value. */
const SHAPE = `(() => {
  const d = (o, p) => {
    const x = o ? Object.getOwnPropertyDescriptor(o, p) : null;
    return x ? "get=" + !!x.get + " enum=" + x.enumerable + " conf=" + x.configurable : "absent";
  };
  const f = (fn) => fn ? "name=" + fn.name + " len=" + fn.length : "absent";
  return {
    webdriverDescriptor: d(Navigator.prototype, "webdriver"),
    platformDescriptor: d(Navigator.prototype, "platform"),
    coresDescriptor: d(Navigator.prototype, "hardwareConcurrency"),
    languagesDescriptor: d(Navigator.prototype, "languages"),
    uaDataOwnOnInstance: d(navigator, "userAgentData"),
    uaDataOnPrototype: d(Navigator.prototype, "userAgentData"),
    queryOwnOnInstance: d(navigator.permissions, "query"),
    queryOnPrototype: d(self.Permissions ? Permissions.prototype : null, "query"),
    queryIdentity: f(navigator.permissions && navigator.permissions.query),
    getParameterIdentity: f(WebGLRenderingContext.prototype.getParameter),
    toStringIdentity: f(Function.prototype.toString),
    querySource: Function.prototype.toString.call(navigator.permissions.query),
    getParameterSource: Function.prototype.toString.call(WebGLRenderingContext.prototype.getParameter),
    navigatorKeys: Object.getOwnPropertyNames(Navigator.prototype).join(","),
  };
})()`;

/** The values the profile is supposed to be claiming. */
const VALUES = `(() => {
  const gl = document.createElement("canvas").getContext("webgl");
  return {
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    renderer: gl ? gl.getParameter(0x9246) : null,
    vendor: gl ? gl.getParameter(0x9245) : null,
    uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
  };
})()`;

let browser: Browser;
let vanilla: Page;
let patched: Page;

before(async () => {
  ensureDisplay();
  browser = await chromium.launch({ headless: false, channel: "chrome" });

  const plain = await browser.newContext(contextOptionsFor(PROFILE));
  const hardened = await browser.newContext(contextOptionsFor(PROFILE));
  await hardened.addInitScript({ content: hardeningScript(PROFILE, browser.version()) });

  [vanilla, patched] = await Promise.all([plain.newPage(), hardened.newPage()]);
  // A secure context: navigator.userAgentData is undefined on about:blank,
  // which would make the client-hint patches look absent rather than working.
  await Promise.all([
    vanilla.goto("https://example.com"),
    patched.goto("https://example.com"),
  ]);
});

after(async () => browser?.close());

describe("the script runs to completion", { timeout: 2 * MINUTE }, () => {
  test("executing it raises nothing", async () => {
    const error = await patched.evaluate((source) => {
      try { (0, eval)(source); return null; } catch (e: any) { return `${e.name}: ${e.message}`; }
    }, hardeningScript(PROFILE, "152.0.0.0"));
    assert.equal(error, null);
  });

  test("every patch took effect, not just the early ones", async () => {
    const v = (await patched.evaluate(VALUES)) as any;
    assert.equal(v.webdriver, false);
    assert.equal(v.platform, PROFILE.fingerprint.platform);
    assert.equal(v.cores, PROFILE.fingerprint.hardwareConcurrency);
    // Set in the last third of the script - dead for weeks behind a silent throw.
    assert.equal(v.renderer, PROFILE.fingerprint.webgl.renderer);
    assert.equal(v.vendor, PROFILE.fingerprint.webgl.vendor);
    assert.equal(v.uaPlatform, "Windows");
  });
});

describe("shape parity with an unpatched context", { timeout: 2 * MINUTE }, () => {
  test("no property descriptor differs", async () => {
    const [a, b] = (await Promise.all([
      vanilla.evaluate(SHAPE),
      patched.evaluate(SHAPE),
    ])) as any[];

    for (const key of Object.keys(a)) {
      assert.equal(b[key], a[key], `${key} differs: vanilla "${a[key]}" vs patched "${b[key]}"`);
    }
  });

  test("patched functions keep native identity", async () => {
    const shape = (await patched.evaluate(SHAPE)) as any;
    assert.equal(shape.queryIdentity, "name=query len=1");
    assert.equal(shape.getParameterIdentity, "name=getParameter len=1");
    assert.equal(shape.toStringIdentity, "name=toString len=0");
    assert.match(shape.querySource, /^function query\(\) \{\s*\[native code\]\s*\}$/);
    assert.match(shape.getParameterSource, /^function getParameter\(\) \{\s*\[native code\]\s*\}$/);
  });

  test("nothing is patched onto an instance", async () => {
    // An own property where the engine keeps a prototype one is trivially
    // detectable, regardless of how convincing the value is.
    const shape = (await patched.evaluate(SHAPE)) as any;
    assert.equal(shape.uaDataOwnOnInstance, "absent");
    assert.equal(shape.queryOwnOnInstance, "absent");
  });

  test("Navigator.prototype key order is untouched", async () => {
    const [a, b] = (await Promise.all([vanilla.evaluate(SHAPE), patched.evaluate(SHAPE)])) as any[];
    assert.equal(b.navigatorKeys, a.navigatorKeys);
  });
});

describe("headers on the wire", { timeout: 2 * MINUTE }, () => {
  test("the first request carries a weighted Accept-Language", async () => {
    // The regression: Playwright's `locale` overrides extraHTTPHeaders on the
    // main navigation - the one request an anti-bot service actually reads -
    // and sends a bare "de-DE" that no real Chrome ever sends. Later requests
    // looked correct, which is why it survived every earlier check.
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(String(req.headers["accept-language"]));
      res.writeHead(200, { "content-type": "text/html" }).end("<h1>ok</h1>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    try {
      for (const id of ["desktop-edge", "desktop-chrome", "desktop-firefox"]) {
        seen.length = 0;
        const profile = getProfile(id);
        const session = await launchProfile(profile);
        const page = await session.context.newPage();
        await page.goto(url);
        const languages = await page.evaluate(() => navigator.languages.join(","));
        await session.browser.close();

        assert.equal(seen[0], acceptLanguageFor(profile), `${id} first request`);
        assert.equal(languages, languagesOf(profile), `${id} navigator.languages`);
      }
    } finally {
      server.close();
    }
  });
});

function languagesOf(profile: { id: string }) {
  const locale = localeFor(profile as any);
  const base = locale.split("-")[0];
  return base === "en" ? `${locale},${base}` : `${locale},${base},en-US,en`;
}
