/**
 * Field test: point the profiles at bot-detection pages and report honestly
 * what they say.
 *
 * Deliberately low volume - one page load per target per profile, read-only,
 * staggered. Targets are purpose-built detection test pages that publish their
 * own verdict; the point is to measure this toolkit, not to put load on anyone.
 */
import { defineMission, runOnce } from "./missions";
import { getProfile } from "./browsers";
import { sqliteStore } from "./storage";

type Verdict = "clean" | "challenged" | "blocked";

const CHALLENGE = /just a moment|checking your browser|verify (you are|yourself)|are you a robot|captcha|enable javascript and cookies/i;
const BLOCKED = /access denied|forbidden|you have been blocked|unusual traffic|request blocked|pardon our interruption/i;

function classify(title: string, text: string): Verdict {
  const head = text.slice(0, 4000);
  if (BLOCKED.test(title) || BLOCKED.test(head)) return "blocked";
  if (CHALLENGE.test(title) || CHALLENGE.test(head)) return "challenged";
  return "clean";
}

/** These pages grade the browser themselves; read their own verdict. */
async function selfReport(url: string, page: any): Promise<string> {
  if (url.includes("sannysoft")) {
    const rows: string[][] = await page.$$eval("table tr", (trs: any[]) =>
      trs.map((tr) =>
        Array.from(tr.querySelectorAll("td, th")).map((cell: any) => cell.textContent.trim())
      )
    );
    const named = rows.filter((r) => r.length >= 2 && r[0]);
    const failed = named.filter((r) => /failed|present \(failed\)/i.test(r[1]));
    return failed.length
      ? `${failed.length}/${named.length} checks FAILED: ${failed.map((r) => r[0]).slice(0, 6).join(", ")}`
      : `all ${named.length} checks passed`;
  }
  if (url.includes("creepjs")) {
    const text = await page.locator("body").innerText().catch(() => "");
    const grab = (re: RegExp) => text.match(re)?.[1];
    const parts = [
      `headless ${grab(/(\d+)% headless/) ?? "?"}%`,
      `like-headless ${grab(/(\d+)% like headless/) ?? "?"}%`,
      `stealth ${grab(/(\d+)% stealth/) ?? "?"}%`,
      `trust ${grab(/trust score:?\s*([\d.]+)/i) ?? "?"}`,
      `lies ${grab(/(\d+)\s*lies/i) ?? "0"}`,
    ];
    return parts.join(", ");
  }
  return "no self-report";
}

const TARGETS = [
  "https://bot.sannysoft.com/",
  "https://abrahamjuliot.github.io/creepjs/",
];

const PROFILES = ["desktop-chrome", "mobile-pixel-7", "desktop-firefox"];

(async () => {
  const store = sqliteStore({
    path: "field-test.db",
    table: "results",
    key: (row) => `${row.url}|${row.profile}`,
  });

  // Sequential and staggered on purpose: each pairing is one page load, and
  // runOnce pins the exact profile rather than taking one from the rotation.
  for (const url of TARGETS) {
    for (const id of PROFILES) {
      const profile = getProfile(id);
      const result = await runOnce(
        defineMission({
          name: "probe",
          url,
          retries: 0,
          timeout: 120_000,
          // A probe measures what the site served; solving a challenge would
          // turn a `challenged` verdict into a `clean` one and quietly delete
          // the finding.
          challenge: false as const,
          run: async ({ page, profile: ran }) => {
            await page.waitForTimeout(12_000); // let the page finish grading
            const title = await page.title();
            const text = await page.locator("body").innerText().catch(() => "");
            return {
              url,
              profile: ran.id,
              title: title.slice(0, 50),
              verdict: classify(title, text),
              report: await selfReport(url, page),
            };
          },
        }),
        () => profile,
        false,
        undefined,
        store,
        url
      );

      if (result.ok) {
        const v = result.value as any;
        console.log(`${v.verdict.toUpperCase().padEnd(11)} ${v.profile.padEnd(16)} ${url.replace("https://", "").padEnd(38)} ${v.title}`);
        console.log(`${" ".repeat(12)}${v.report}`);
      } else {
        console.log(`ERROR       ${profile.id.padEnd(16)} ${url}`);
        console.log(`${" ".repeat(12)}${result.error.message.split("\n")[0].slice(0, 70)}`);
      }
    }
  }

  await store.close();
})();
