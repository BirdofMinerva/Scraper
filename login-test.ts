/**
 * Sign in to every site in `login-sites.ts`, twice.
 *
 *   npx tsx login-test.ts
 *   npx tsx login-test.ts --only=saucedemo,orangehrm
 *   npx tsx login-test.ts --list
 *   PROXIES="home=socks5://127.0.0.1:1080" npx tsx login-test.ts
 *
 * Twice, because "signed in" on its own proves nothing: a detector that
 * answers yes to everything passes the first half of this and fails the
 * second. Each site is asked with its published credentials and then with a
 * wrong password, and only a site that accepts one and refuses the other
 * counts as passed.
 *
 * Each attempt gets a **fresh context**. A session left over from the previous
 * attempt makes the login form vanish, and "no login form on the page" then
 * looks like a bug in the discovery rather than a cookie from a moment ago.
 */
import { openStack } from "./stack";
import { signIn } from "./accounts";
import { parseRoutes, describeRoute } from "./routes";
import { LOGIN_SITES, selectSites, type LoginSite } from "./login-sites";

const ROUTE = parseRoutes(process.env.PROXIES ?? "")[0];
const PROXIES = ROUTE?.proxy ? [ROUTE.proxy] : undefined;
const rule = "-".repeat(92);

type Row = { name: string; passed: boolean; signedIn: string; refused: string };

async function probe(site: LoginSite, browser: import("playwright").Browser): Promise<Row> {
  const attempt = async (password: string) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      return await signIn(page, { ...site.credentials, password }, site.spec, { timeout: 90_000 });
    } finally {
      await context.close();
    }
  };

  const good = await attempt(site.credentials.password);
  const bad = await attempt("definitely-not-the-password");

  // A site that signs anyone in cannot refuse anyone, so only the first half
  // is a claim about us.
  const passed = good.ok && (site.acceptsAnything ? bad.ok : !bad.ok);
  return {
    name: site.spec.name,
    passed,
    signedIn: good.ok ? "yes" : `no - ${good.detail}`,
    refused: bad.ok ? (site.acceptsAnything ? "accepts anything, as expected" : "SIGNED IN ANYWAY") : bad.detail,
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const sites = selectSites(LOGIN_SITES, argv);

  if (argv.includes("--list")) {
    for (const site of sites) {
      console.log(`${site.spec.name.padEnd(24)}${site.spec.loginUrl}\n${" ".repeat(24)}${site.note}`);
    }
    return;
  }

  console.log(`route: ${ROUTE ? describeRoute(ROUTE) : "direct"}\n`);
  console.log(`${"site".padEnd(24)}${"signed in".padEnd(10)}wrong password`);
  console.log(rule);

  const stack = await openStack({ kind: "desktop", count: 1, engine: "chromium", proxies: PROXIES });
  const rows: Row[] = [];
  try {
    for (const site of sites) {
      try {
        rows.push(await probe(site, stack.sessions[0].browser));
      } catch (error) {
        rows.push({
          name: site.spec.name,
          passed: false,
          signedIn: `errored - ${(error as Error).message.split("\n")[0].slice(0, 50)}`,
          refused: "-",
        });
      }
      const last = rows[rows.length - 1];
      console.log(
        `${last.passed ? "PASS " : "FAIL "}${last.name.slice(0, 18).padEnd(19)}` +
          `${last.signedIn.slice(0, 9).padEnd(10)}${last.refused.slice(0, 55)}`
      );
    }
  } finally {
    await stack.close();
  }

  const passed = rows.filter((r) => r.passed).length;
  console.log(`\n${rule}\n${passed}/${rows.length} sites signed in and refused a wrong password`);
})();
