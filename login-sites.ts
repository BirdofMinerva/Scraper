/**
 * Login forms in the wild, with credentials their owners publish.
 *
 * `accounts.ts` is generic - it discovers fields, submits, and reads the
 * outcome - and generic code is only as good as the forms it has met. These
 * are nine real sites that exist to be automated against, chosen because they
 * disagree with each other: username logins and email logins, a form outside
 * any `<form>`, a React app that renders its fields a second late, a submit
 * button with no `type`, a sign-out link hidden inside a closed menu, and one
 * site with no account UI at all once you are in.
 *
 * Every failure in `login-test.ts` was a fix in `accounts.ts`, not an entry
 * here. The catalogue is the fixture; the module is what is under test.
 *
 *   npx tsx login-test.ts
 *   npx tsx login-test.ts --only=saucedemo,orangehrm
 *
 * These are practice sites, and the credentials below are published on the
 * pages themselves. Nothing here is a way into anything private.
 */
import { defineSite, type AuthSpec, type Credentials } from "./accounts";

export type LoginSite = {
  spec: AuthSpec;
  credentials: Credentials;
  /**
   * The site signs in anyone. A wrong password is then *not* expected to be
   * refused, and treating that as a failure would be reporting on the site's
   * design rather than on ours.
   */
  acceptsAnything?: boolean;
  /** What this one is here to exercise. */
  note: string;
};

export const LOGIN_SITES: LoginSite[] = [
  {
    spec: defineSite({ name: "the-internet", loginUrl: "https://the-internet.herokuapp.com/login" }),
    credentials: { username: "tomsmith", password: "SuperSecretPassword!" },
    note: "the plain case: username, password, submit, flash message",
  },
  {
    spec: defineSite({ name: "expandtesting", loginUrl: "https://practice.expandtesting.com/login" }),
    credentials: { username: "practice", password: "SuperSecretPassword!" },
    note: "success and failure arrive in the same .alert box, class apart",
  },
  {
    spec: defineSite({ name: "saucedemo", loginUrl: "https://www.saucedemo.com/" }),
    credentials: { username: "standard_user", password: "secret_sauce" },
    note: "sign-out lives in a closed burger menu; errors in [data-test=error]",
  },
  {
    spec: defineSite({
      name: "practicetestautomation",
      loginUrl: "https://practicetestautomation.com/practice-test-login/",
    }),
    credentials: { username: "student", password: "Password123" },
    note: "the submit button has no type and sits outside any <form>",
  },
  {
    spec: defineSite({ name: "quotes-toscrape", loginUrl: "https://quotes.toscrape.com/login" }),
    credentials: { username: "anyone", password: "anything" },
    acceptsAnything: true,
    note: "a fake login that accepts everything - the control for the negative test",
  },
  {
    spec: defineSite({ name: "parabank", loginUrl: "https://parabank.parasoft.com/parabank/index.htm" }),
    credentials: { username: "john", password: "demo" },
    note: "login form on the home page, session id in the URL",
  },
  {
    spec: defineSite({
      name: "rahulshetty",
      loginUrl: "https://rahulshettyacademy.com/loginpagePractise/",
      accept: ["#terms"],
      // The one site here with no account UI behind the login: it drops you
      // into a shop with no sign-out link and no greeting, so the generic
      // heuristic has nothing to read. This is exactly what `signedIn` is for.
      signedIn: async (page) => page.url().includes("/angularpractice"),
    }),
    credentials: { username: "rahulshettyacademy", password: "Learning@830$3mK2" },
    note: "no sign-out affordance anywhere; needs an explicit signedIn",
  },
  {
    spec: defineSite({
      name: "orangehrm",
      loginUrl: "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login",
    }),
    credentials: { username: "Admin", password: "admin123" },
    note: "React app - the fields do not exist at domcontentloaded",
  },
  {
    spec: defineSite({ name: "guru99-tours", loginUrl: "https://demo.guru99.com/test/newtours/" }),
    credentials: { username: "mercury", password: "mercury" },
    note: "the sign-out link says SIGN-OFF and points at index.php",
  },
];

/** Narrow to the sites named by `--only=a,b`. Throws on a name that matches nothing. */
export function selectSites(sites: LoginSite[], argv: string[]): LoginSite[] {
  const flag = argv.find((a) => a.startsWith("--only="));
  if (!flag) return sites;

  const wanted = flag.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = sites.filter((s) => wanted.includes(s.spec.name));
  if (chosen.length === 0) {
    throw new Error(
      `--only matched no sites. Available: ${sites.map((s) => s.spec.name).join(", ")}`
    );
  }
  return chosen;
}
