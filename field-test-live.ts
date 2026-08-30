/**
 * Live field test — run this yourself:  npx tsx field-test-live.ts
 *
 * Loads a handful of public homepages that sit behind real anti-bot services
 * and reports what came back. One read-only page load per site, sequential,
 * staggered. Nothing is submitted, no login, no CAPTCHA handling — it reads
 * the landing response and classifies it.
 *
 * Results are printed and written to field-test-live.db, keyed on
 * url+profile+route so routes can be diffed against each other.
 *
 *   --routes        parse the proxy config and exit
 *   --only=home     run just these routes (default: all, including direct)
 *   --fresh         re-measure pairs already in the db instead of skipping them
 */
import { defineMission, runOnce } from "./missions";
import { getProfile } from "./browsers";
import { sqliteStore } from "./storage";
import type { ProxyLike } from "./proxies";
import {
  classify, detectProtection, advise, diagnosticHeaders, compareBaseline,
  type Baseline,
} from "./detect";
import { execFile } from "node:child_process";
import { parseRoutes, withDirect, selectRoutes, describeRoute } from "./routes";
import { selectTargets, filterFromArgs, type Target } from "./targets";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Configure here
// ---------------------------------------------------------------------------

const TARGETS: Target[] = selectTargets(filterFromArgs(process.argv));

/** --baseline also asks curl, to separate browser blocks from network ones. */
const wantBaseline = process.argv.includes("--baseline");

/**
 * What a plain HTTP client gets for the same URL over the same route.
 *
 * curl, not the browser: no JS, no browser TLS, no client hints. If it is
 * served the page while the browser is refused, the block is browser-specific.
 * If it is refused too, the browser was never consulted and no amount of
 * fingerprint work will change the answer.
 */
async function baselineFor(url: string, proxy?: string): Promise<Baseline | undefined> {
  // -L matters: without it, `curl https://g2.com` reports the 301 to www and
  // stops. A 3xx is neither served nor refused, and reading it as "served"
  // would conclude "browser-specific block" from a request that never arrived.
  const args = [
    "-s", "-o", "/dev/null", "-L", "--max-redirs", "5", "--max-time", "25",
    "-w", "%{http_code} %{size_download}",
    ...(proxy ? ["--proxy", proxy] : []),
    url,
  ];

  return new Promise((resolve) => {
    execFile("curl", args, (error, stdout) => {
      if (error && !stdout) return resolve(undefined);
      const [status, bytes] = stdout.trim().split(/\s+/).map(Number);
      resolve(Number.isFinite(status) ? { status, bytes: bytes || 0 } : undefined);
    });
  });
}

/** The route as curl wants it: SOCKS needs socks5h so DNS stays remote. */
function curlProxy(proxy: unknown): string | undefined {
  const first = Array.isArray(proxy) ? proxy[0] : proxy;
  const server = typeof first === "string" ? first : (first as { server?: string })?.server;
  return server?.replace(/^socks5:\/\//, "socks5h://");
}

/** Fingerprints to try. Every profile is run against every route below. */
const PROFILES = ["desktop-chrome"];

/**
 * Routes to compare, loaded without editing this file.
 *
 *   PROXIES="trial=http://user:pass@gate.example:7000" npx tsx field-test-live.ts
 *
 * or a proxies.txt next to this script, one `label=url` per line (blank lines
 * and #comments ignored). Chains separate hops with `>`, and `--only=home`
 * narrows to named routes. "direct" is always present as the control.
 */
const ROUTES = selectRoutes(
  withDirect(
    parseRoutes(
      process.env.PROXIES ??
        (fs.existsSync("proxies.txt") ? fs.readFileSync("proxies.txt", "utf8") : "")
    )
  ),
  process.argv
);

/**
 * Pairs already stored, so an interrupted run picks up where it stopped
 * instead of repeating minutes of work. `--fresh` re-measures everything.
 */
function alreadyStored(): Set<string> {
  if (process.argv.includes("--fresh") || !fs.existsSync("field-test-live.db")) {
    return new Set();
  }
  try {
    const db = new DatabaseSync("field-test-live.db");
    const rows = db.prepare("SELECT _key FROM results").all() as { _key: string }[];
    db.close();
    return new Set(rows.map((r) => r._key));
  } catch {
    return new Set(); // no table yet
  }
}

const DONE = alreadyStored();

/** Seconds to sit on the page before reading it, letting challenges resolve. */
const DWELL_MS = 12_000;

// ---------------------------------------------------------------------------

(async () => {
  // `--routes` parses the config and exits: check credentials landed correctly
  // before committing to a run that takes minutes.
  if (process.argv.includes("--list")) {
    console.log(`${TARGETS.length} targets:`);
    for (const t of TARGETS) {
      console.log(`  ${t.name.padEnd(16)} ${t.vendor.padEnd(12)} ${t.category.padEnd(12)} ${t.difficulty.padEnd(7)} ${t.url}`);
    }
    return;
  }

  if (process.argv.includes("--routes")) {
    for (const route of ROUTES) {
      console.log(`${route.label.padEnd(16)} ${describeRoute(route)}`);
    }
    return;
  }

  const store = sqliteStore({
    path: "field-test-live.db",
    table: "results",
    key: (row) => `${row.url}|${row.profile}|${row.route}`,
  });

  console.log("\nverdict".padEnd(14) + "site".padEnd(20) + "route".padEnd(14) + "profile".padEnd(17) + "status");
  console.log("-".repeat(100));

  for (const route of ROUTES) {
    // Confirm the route is actually carrying traffic before drawing any
    // conclusions from what the targets say - a silently-ignored proxy would
    // otherwise look like "the proxy did not help".
    const exit = await runOnce(
      defineMission({
        name: "exit-ip",
        url: "https://ipinfo.io/json",
        retries: 0,
        timeout: 60_000,
        proxy: route.proxy,
        run: async ({ page }) => {
          const text = await page.locator("pre, body").first().innerText();
          const info = JSON.parse(text);
          return { ip: info.ip, org: info.org ?? "?", country: info.country ?? "?" };
        },
      }),
      () => getProfile(PROFILES[0]),
      false
    );

    if (exit.ok) {
      const e = exit.value as any;
      console.log(`\nroute "${route.label}" exits from ${e.ip} · ${e.org} · ${e.country}`);
    } else {
      console.log(`\nroute "${route.label}" FAILED its exit-IP check: ${exit.error.message.split("\n")[0].slice(0, 60)}`);
      console.log("  skipping this route — results from it would be meaningless");
      continue;
    }

    for (const id of PROFILES) {
      for (const target of TARGETS) {
        const url = target.url;
        if (DONE.has(`${url}|${id}|${route.label}`)) {
          console.log(`SKIP          ${url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "").padEnd(20)}${route.label.padEnd(14)}${id.padEnd(17)}already stored`);
          continue;
        }
        const result = await runOnce(
          defineMission({
            name: "live-probe",
            retries: 0,
            timeout: 120_000,
            // A probe measures what the site served; solving a challenge would
            // turn a `challenged` verdict into a `clean` one and quietly delete
            // the finding.
            challenge: false as const,
            proxy: route.proxy,
            run: async ({ page, profile }) => {
              // Navigate here rather than through mission.url: the Response
              // object carries the headers naming which layer refused us,
              // which the performance entry does not.
              const response = await page.goto(url, { waitUntil: "domcontentloaded" });
              await page.waitForTimeout(DWELL_MS);

              const status = response?.status() ?? 0;
              const headers = diagnosticHeaders(response?.headers() ?? {});
              const baseline = wantBaseline
                ? await baselineFor(url, curlProxy(route.proxy))
                : undefined;

              const title = await page.title();
              const text = await page.locator("body").innerText().catch(() => "");
              const html = await page.content().catch(() => "");
              const cookies = (await page.context().cookies()).map((c) => c.name);

              const protection = detectProtection(cookies, html);
              const verdict = classify(status, title, text, text.length, protection);

              return {
                url,
                profile: profile.id,
                route: route.label,
                status,
                title: title.slice(0, 70),
                verdict,
                bodyChars: text.length,
                vendors: protection.vendors.join(", ") || "none",
                passedChallenge: protection.passedChallenge,
                advice: compareBaseline(verdict, baseline, protection),
                headers: JSON.stringify(headers),
                baselineStatus: baseline?.status ?? null,
                baselineBytes: baseline?.bytes ?? null,
                // Kept so a verdict can be audited later without re-running.
                snippet: text.replace(/\s+/g, " ").slice(0, 300),
                cookies: cookies.slice(0, 15).join(","),
              };
            },
          }),
          () => getProfile(id),
          false,
          undefined,
          store,
          url
        );

        const site = target.name;
        if (result.ok) {
          const v = result.value as any;
          console.log(
            v.verdict.toUpperCase().padEnd(14) + site.padEnd(20) + route.label.padEnd(14) +
            id.padEnd(17) + String(v.status || "?")
          );
          const surprise =
            target.vendor !== "none" &&
            !v.vendors.toLowerCase().includes(target.vendor.slice(0, 6))
              ? `  [expected ${target.vendor}]`
              : "";
          console.log(`${" ".repeat(14)}${v.bodyChars} chars · ${v.vendors}${surprise}${v.baselineStatus ? ` · curl ${v.baselineStatus}` : ""}`);
          if (v.headers !== "{}") console.log(`${" ".repeat(14)}${v.headers}`);
          console.log(`${" ".repeat(14)}${v.advice}`);
        } else {
          console.log("ERROR".padEnd(14) + site.padEnd(20) + route.label.padEnd(14) + id.padEnd(17) + "-");
          console.log(`${" ".repeat(14)}${result.error.message.split("\n")[0].slice(0, 70)}`);
        }

        await new Promise((r) => setTimeout(r, 4000 + Math.random() * 6000));
      }
    }
  }

  console.log("-".repeat(100));
  console.log("written to field-test-live.db");
  console.log("compare routes:  sqlite3 field-test-live.db \"select url, route, verdict, status from results order by url, route\"\n");
  await store.close();
})();
