/**
 * What a browser does once it is signed in.
 *
 *   const outcome = await runActions(page, [
 *     { do: "visit", url: "https://site/inventory" },
 *     { do: "click", selector: "#add-to-cart" },
 *     { do: "read", name: "total", selector: ".cart-total" },
 *     { do: "shot", label: "cart" },
 *   ], { human, log });
 *
 * A session that logs in and stops is a login, not a session - the interesting
 * part is what it does next, and a site watching for automation is watching
 * that part too. So every step here goes through `human`: clicks arrive with
 * pointer travel behind them, typing has per-key timing, scrolling is wheel
 * notches with reading pauses.
 *
 * Steps are declarative because they come from a form. The dashboard builds
 * this list from dropdowns, the runner executes it, and the same list can be
 * written by hand in a script - one description of "what the bot does", not
 * two.
 */
import type { Page } from "playwright";
import { ConfigError, ChallengeError } from "./errors";
import path from "node:path";
import fs from "node:fs";
import { humanize, type Human } from "./human";
import { passChallenge, type ChallengeOptions } from "./turnstile";

export type Action =
  /** Navigate, passing any challenge that appears. */
  | { do: "visit"; url: string; optional?: boolean }
  /** Move the pointer there and press. */
  | { do: "click"; selector: string; optional?: boolean }
  /** Click into a field and type, with the usual jitter. */
  | { do: "type"; selector: string; text: string; optional?: boolean }
  /** Wheel gestures with reading pauses. */
  | { do: "scroll"; steps?: number; optional?: boolean }
  /** Wait for a selector, or just for a while. */
  | { do: "wait"; selector?: string; ms?: number; optional?: boolean }
  /** Pull a value off the page into the run's results. */
  | { do: "read"; name: string; selector?: string; attribute?: string; all?: boolean; optional?: boolean }
  /** A picture of what this browser is looking at. */
  | { do: "shot"; label?: string; fullPage?: boolean; optional?: boolean };

export type ActionKind = Action["do"];

export const ACTION_KINDS: ActionKind[] = ["visit", "click", "type", "scroll", "wait", "read", "shot"];

export type StepResult = {
  step: number;
  do: ActionKind;
  ok: boolean;
  ms: number;
  detail: string;
  /** Set by `shot`: where the picture landed. */
  shot?: string;
};

export type ActionsOutcome = {
  ok: boolean;
  steps: StepResult[];
  /** Everything `read` collected, by name. */
  data: Record<string, string | string[] | null>;
  shots: string[];
  detail: string;
};

export type ActionOptions = {
  human?: Human;
  log?: (message: string) => void;
  /** Where `shot` writes. Created if missing. */
  shotDir?: string;
  /** Prefix for screenshot filenames - the profile, usually. */
  shotPrefix?: string;
  /** Challenge handling after navigations. `false` to leave them alone. */
  challenge?: false | ChallengeOptions;
  /** Per-step budget, ms. Default 30s. */
  timeout?: number;
};

/**
 * Describe an action in one line, for a log or a form summary.
 *
 * Shared with the dashboard so a step reads the same in the terminal panel as
 * it does in the list that produced it.
 */
export function describeAction(action: Action): string {
  switch (action.do) {
    case "visit":
      return `visit ${action.url}`;
    case "click":
      return `click ${action.selector}`;
    case "type":
      // Never the text itself: these lists carry search terms, messages and
      // occasionally a password someone typed into the wrong field.
      return `type ${action.text.length} characters into ${action.selector}`;
    case "scroll":
      return `scroll ${action.steps ?? 3}`;
    case "wait":
      return action.selector ? `wait for ${action.selector}` : `wait ${action.ms ?? 1000}ms`;
    case "read":
      return `read ${action.name}${action.selector ? ` from ${action.selector}` : ""}`;
    case "shot":
      return `screenshot${action.label ? ` "${action.label}"` : ""}`;
  }
}

/**
 * Turn whatever the form sent into actions, or say what is wrong with it.
 *
 * The dashboard posts JSON it built from a table of dropdowns, so the fields
 * that matter can still be blank. A step with no selector is refused here
 * rather than throwing inside a browser two minutes later.
 */
export function parseActions(input: unknown): Action[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new ConfigError("Actions must be a list");

  return input.map((raw, index) => {
    const at = `step ${index + 1}`;
    const action = raw as Partial<Action> & { do?: string };
    const kind = action.do as ActionKind;
    if (!ACTION_KINDS.includes(kind)) {
      throw new ConfigError(`${at}: "${action.do ?? "nothing"}" is not something a browser can do`);
    }

    const need = (value: unknown, what: string) => {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) throw new ConfigError(`${at}: ${kind} needs ${what}`);
      return text;
    };

    switch (kind) {
      case "visit": {
        const url = need((action as { url?: string }).url, "a URL");
        if (!/^https?:\/\//i.test(url)) throw new ConfigError(`${at}: "${url.slice(0, 40)}" is not a URL`);
        return { do: "visit", url, optional: !!action.optional };
      }
      case "click":
        return {
          do: "click",
          selector: need((action as { selector?: string }).selector, "a selector"),
          optional: !!action.optional,
        };
      case "type":
        return {
          do: "type",
          selector: need((action as { selector?: string }).selector, "a selector"),
          text: String((action as { text?: string }).text ?? ""),
          optional: !!action.optional,
        };
      case "scroll":
        return { do: "scroll", steps: positive((action as { steps?: number }).steps), optional: !!action.optional };
      case "wait": {
        const selector = (action as { selector?: string }).selector?.trim();
        const ms = positive((action as { ms?: number }).ms);
        if (!selector && !ms) throw new ConfigError(`${at}: wait needs a selector or a number of milliseconds`);
        return { do: "wait", selector: selector || undefined, ms, optional: !!action.optional };
      }
      case "read":
        return {
          do: "read",
          name: need((action as { name?: string }).name, "a name to store the value under"),
          selector: (action as { selector?: string }).selector?.trim() || undefined,
          attribute: (action as { attribute?: string }).attribute?.trim() || undefined,
          all: !!(action as { all?: boolean }).all,
          optional: !!action.optional,
        };
      case "shot":
        return {
          do: "shot",
          label: (action as { label?: string }).label?.trim() || undefined,
          fullPage: !!(action as { fullPage?: boolean }).fullPage,
          optional: !!action.optional,
        };
    }
  });
}

const positive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A filename that cannot escape the shot directory or surprise a filesystem. */
export function shotName(prefix: string, index: number, label?: string): string {
  const clean = (text: string) => text.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const parts = [clean(prefix) || "browser", String(index).padStart(2, "0")];
  if (label) parts.push(clean(label));
  return parts.filter(Boolean).join("-") + ".png";
}

/**
 * Run the list, in order.
 *
 * Nothing throws: a failed step comes back on the result with the step number
 * and what went wrong, because these lists are written in a web form and "step
 * 3 could not find .add-to-cart" is the sentence that fixes it. A step marked
 * optional logs and carries on - "close the cookie banner if there is one" is
 * a real step and its absence is not a failure.
 */
export async function runActions(
  page: Page,
  actions: Action[],
  options: ActionOptions = {}
): Promise<ActionsOutcome> {
  const { log = () => {}, timeout = 30_000 } = options;
  const human = options.human ?? humanize(page);
  const steps: StepResult[] = [];
  const data: ActionsOutcome["data"] = {};
  const shots: string[] = [];

  const settle = async () => {
    if (options.challenge === false) return;
    const outcome = await passChallenge(page, {
      human,
      log,
      ...(options.challenge ?? {}),
    });
    if (outcome.challenged) {
      log(outcome.detail);
      if (!outcome.passed) throw new ChallengeError(`challenge not passed: ${outcome.detail}`);
    }
  };

  for (const [index, action] of actions.entries()) {
    const started = Date.now();
    const described = describeAction(action);
    let detail = described;

    try {
      switch (action.do) {
        case "visit":
          await page.goto(action.url, { waitUntil: "domcontentloaded", timeout });
          await settle();
          break;

        case "click": {
          // Wait for it first: a click on a page still rendering is the most
          // common way one of these lists fails, and "not found" would be the
          // wrong diagnosis.
          await page.locator(action.selector).first().waitFor({ state: "visible", timeout });
          // A click often navigates, so watch for it rather than assuming
          // either way - and then let a challenge on the far side be handled.
          const navigated = page
            .waitForEvent("framenavigated", {
              predicate: (frame) => frame === page.mainFrame(),
              timeout: 5000,
            })
            .catch(() => null);
          await human.click(action.selector);
          if (await navigated) {
            await page.waitForLoadState("domcontentloaded").catch(() => {});
            await settle();
            detail += ` → ${page.url().slice(0, 60)}`;
          }
          break;
        }

        case "type":
          await page.locator(action.selector).first().waitFor({ state: "visible", timeout });
          await human.type(action.selector, action.text);
          break;

        case "scroll":
          await human.scroll(action.steps ?? 3);
          break;

        case "wait":
          if (action.selector) {
            await page.locator(action.selector).first().waitFor({ state: "visible", timeout });
          } else {
            await page.waitForTimeout(action.ms ?? 1000);
          }
          break;

        case "read": {
          const value = await readValue(page, action, timeout);
          data[action.name] = value;
          detail += ` = ${preview(value)}`;
          break;
        }

        case "shot": {
          const dir = options.shotDir ?? ".";
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, shotName(options.shotPrefix ?? "browser", index + 1, action.label));
          await page.screenshot({ path: file, fullPage: !!action.fullPage });
          shots.push(file);
          steps.push({
            step: index + 1,
            do: action.do,
            ok: true,
            ms: Date.now() - started,
            detail,
            shot: file,
          });
          log(`${index + 1}. ${detail}`);
          continue;
        }
      }

      steps.push({ step: index + 1, do: action.do, ok: true, ms: Date.now() - started, detail });
      log(`${index + 1}. ${detail}`);
    } catch (error) {
      const message = (error as Error).message.split("\n")[0].slice(0, 120);
      steps.push({
        step: index + 1,
        do: action.do,
        ok: false,
        ms: Date.now() - started,
        detail: `${described} - ${message}`,
      });
      log(`${index + 1}. FAILED ${described} - ${message}`);

      if (!action.optional) {
        return {
          ok: false,
          steps,
          data,
          shots,
          detail: `step ${index + 1} (${action.do}) failed: ${message}`,
        };
      }
    }
  }

  const failed = steps.filter((s) => !s.ok).length;
  return {
    ok: true,
    steps,
    data,
    shots,
    detail: `${steps.length - failed}/${steps.length} steps` + (failed ? `, ${failed} optional skipped` : ""),
  };
}

/** The text or attribute a `read` step asked for. */
async function readValue(
  page: Page,
  action: Extract<Action, { do: "read" }>,
  timeout: number
): Promise<string | string[] | null> {
  const selector = action.selector ?? "body";
  const locator = page.locator(selector);

  if (action.all) {
    // No waitFor: "how many of these are there" is a legitimate question with
    // zero as an answer, and waiting would turn it into a failure.
    const many = locator;
    const count = await many.count();
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      values.push(await one(many.nth(i)));
    }
    return values;
  }

  await locator.first().waitFor({ state: "attached", timeout });
  return one(locator.first());

  async function one(target: ReturnType<Page["locator"]>) {
    const value = action.attribute
      ? await target.getAttribute(action.attribute)
      : await target.innerText();
    return (value ?? "").replace(/\s+/g, " ").trim();
  }
}

const preview = (value: string | string[] | null) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `${value.length} value${value.length === 1 ? "" : "s"}`;
  return `"${value.slice(0, 48)}${value.length > 48 ? "…" : ""}"`;
};
