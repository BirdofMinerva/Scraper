/**
 * Behaving like a person: timing, pointer travel, typing, scrolling.
 *
 * Its own file rather than part of `missions.ts` because `turnstile.ts` needs
 * the pointer, and `missions.ts` needs the challenge handling - importing each
 * other is a cycle nobody should have to reason about. `missions.ts`
 * re-exports everything here, so the documented import path still works.
 */
import type { Page } from "playwright";

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randInt = (min: number, max: number) => Math.round(rand(min, max));
const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

/**
 * A delay drawn from a log-normal-ish distribution.
 *
 * Uniform delays are their own tell: real human gaps cluster near a typical
 * value with a long tail of occasional slow ones, and never form the flat
 * histogram that `rand(min, max)` produces.
 */
export function humanDelay(typical: number, spread = 0.45): number {
  const gaussian =
    Math.sqrt(-2 * Math.log(1 - Math.random())) *
    Math.cos(2 * Math.PI * Math.random());
  return Math.max(12, Math.round(typical * Math.exp(gaussian * spread)));
}

/**
 * Per-session traits.
 *
 * Sampled once per mission run, so a session is internally consistent: a fast
 * typist stays a fast typist for the whole visit. Re-rolling per action would
 * average every session into the same profile.
 */
export type Persona = {
  /** <1 is quicker than typical, >1 slower. */
  speed: number;
  /** Mean gap between keystrokes, ms. */
  keyDelay: number;
  /** Chance per word of a typo that gets backspaced and fixed. */
  typoRate: number;
  /** Chance per scroll step of scrolling back up to re-read. */
  scrollBackRate: number;
};

export function randomPersona(): Persona {
  const speed = rand(0.65, 1.6);
  return {
    speed,
    keyDelay: rand(70, 170) * speed,
    typoRate: rand(0, 0.06),
    scrollBackRate: rand(0.05, 0.2),
  };
}

export type Point = { x: number; y: number };

export type Human = {
  persona: Persona;
  /** Sleep for a human-shaped duration around `typical` ms. */
  pause: (typical?: number) => Promise<void>;
  /** Idle as if reading the page - scales with how much text is on it. */
  read: () => Promise<void>;
  /** Move the mouse to the element along a curved, variable-speed path. */
  move: (selector: string) => Promise<void>;
  /**
   * The same travel, aimed at a viewport coordinate.
   *
   * For targets no selector can reach - anything inside a cross-origin iframe,
   * where the only handle is the frame's box in the parent page.
   */
  moveTo: (point: Point) => Promise<void>;
  /** Move, dwell, then click with a realistic press duration. */
  click: (selector: string) => Promise<void>;
  /** `moveTo` then the same press, for coordinate targets. */
  clickAt: (point: Point) => Promise<void>;
  /** Click into the field and type with per-key jitter, and typos. */
  type: (selector: string, text: string) => Promise<void>;
  /** Scroll in uneven steps, sometimes back up, pausing to read. */
  scroll: (steps?: number) => Promise<void>;
};

/** A quadratic bezier, so the pointer arcs instead of travelling in a line. */
function bezierPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number
) {
  const drift = Math.hypot(to.x - from.x, to.y - from.y) * rand(0.08, 0.28);
  const control = {
    x: (from.x + to.x) / 2 + rand(-drift, drift),
    y: (from.y + to.y) / 2 + rand(-drift, drift),
  };

  return Array.from({ length: steps }, (_, i) => {
    // Ease in and out: people accelerate away and decelerate onto a target.
    const linear = (i + 1) / steps;
    const t =
      linear < 0.5
        ? 2 * linear * linear
        : 1 - Math.pow(-2 * linear + 2, 2) / 2;
    const inverse = 1 - t;
    return {
      x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
    };
  });
}

const NEIGHBOURS: Record<string, string> = {
  a: "s", b: "v", c: "x", d: "f", e: "r", f: "g", g: "h", h: "j", i: "o",
  j: "k", k: "l", l: "k", m: "n", n: "m", o: "p", p: "o", q: "w", r: "t",
  s: "d", t: "y", u: "i", v: "b", w: "e", x: "z", y: "u", z: "x",
};

/**
 * The behaviour helpers for a page, outside a mission.
 *
 * `runMission` builds one of these per attempt; `openStack` and `crawl` hand
 * you a bare page, and driving that by hand should not mean giving up the
 * pointer curves and log-normal timing.
 */
export function humanize(page: Page, persona: Persona = randomPersona()): Human {
  return humanFor(page, persona);
}

export function humanFor(page: Page, persona: Persona): Human {
  // Where the pointer currently is, so movement is continuous across actions.
  let cursor = { x: rand(0, 400), y: rand(0, 300) };

  const pause = async (typical = 320) => {
    await page.waitForTimeout(humanDelay(typical * persona.speed));
  };

  const centreOf = async (selector: string) => {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`"${selector}" has no box to aim at`);
    // Aim somewhere inside the element, not dead centre every time.
    return {
      target,
      point: {
        x: box.x + box.width * rand(0.25, 0.75),
        y: box.y + box.height * rand(0.25, 0.75),
      },
    };
  };

  const moveTo = async (point: Point) => {
    const distance = Math.hypot(point.x - cursor.x, point.y - cursor.y);
    const steps = Math.max(8, Math.min(40, Math.round(distance / rand(12, 30))));

    for (const step of bezierPath(cursor, point, steps)) {
      await page.mouse.move(step.x, step.y);
      await page.waitForTimeout(humanDelay(9 * persona.speed, 0.3));
    }

    // Overshoot and settle, the way a hand does on a longer throw.
    if (distance > 250 && Math.random() < 0.4) {
      await page.mouse.move(point.x + rand(-9, 9), point.y + rand(-9, 9));
      await page.waitForTimeout(humanDelay(70));
      await page.mouse.move(point.x, point.y);
    }
    cursor = point;
  };

  const move = async (selector: string) => {
    const { point } = await centreOf(selector);
    await moveTo(point);
  };

  const press = async () => {
    await page.mouse.down();
    await page.waitForTimeout(humanDelay(75, 0.35));
    await page.mouse.up();
  };

  return {
    persona,
    pause,

    async read() {
      const words = await page
        .evaluate(() => document.body?.innerText?.split(/\s+/).length ?? 0)
        .catch(() => 200);
      // ~4 words/second of skimming, floored and capped at something sane.
      const typical = Math.min(9000, Math.max(700, (words / 4) * 250));
      await page.waitForTimeout(humanDelay(typical * persona.speed, 0.5));
    },

    move,
    moveTo,

    async click(selector) {
      await move(selector);
      await pause(140);
      await press();
    },

    async clickAt(point) {
      await moveTo(point);
      await pause(140);
      await press();
    },

    async type(selector, text) {
      const { target } = await centreOf(selector);
      await move(selector);
      await pause(160);
      await target.click();
      await pause(260);

      for (let i = 0; i < text.length; i++) {
        const char = text[i];

        // Occasional typo, noticed a beat later and backspaced.
        const neighbour = NEIGHBOURS[char.toLowerCase()];
        if (neighbour && Math.random() < persona.typoRate) {
          await page.keyboard.type(neighbour, { delay: humanDelay(persona.keyDelay) });
          await page.waitForTimeout(humanDelay(persona.keyDelay * 3.5));
          await page.keyboard.press("Backspace");
          await page.waitForTimeout(humanDelay(persona.keyDelay * 1.5));
        }

        await page.keyboard.type(char, { delay: humanDelay(persona.keyDelay) });

        // Longer gaps after word and sentence boundaries.
        if (char === " ") await page.waitForTimeout(humanDelay(persona.keyDelay * 1.4));
        if (".,!?".includes(char)) await page.waitForTimeout(humanDelay(persona.keyDelay * 2.5));
        // And the occasional mid-thought stall.
        if (Math.random() < 0.03) await page.waitForTimeout(humanDelay(700, 0.5));
      }
    },

    async scroll(steps = randInt(3, 7)) {
      for (let i = 0; i < steps; i++) {
        // A wheel gesture is several notches, not one big jump.
        const notches = randInt(2, 6);
        for (let n = 0; n < notches; n++) {
          await page.mouse.wheel(0, rand(90, 220));
          await page.waitForTimeout(humanDelay(45 * persona.speed, 0.3));
        }
        await page.waitForTimeout(humanDelay(rand(500, 1400) * persona.speed, 0.55));

        if (Math.random() < persona.scrollBackRate) {
          await page.mouse.wheel(0, -rand(120, 380));
          await page.waitForTimeout(humanDelay(900, 0.5));
        }
        // Idle drift of the pointer while reading.
        if (Math.random() < 0.35) {
          cursor = { x: cursor.x + rand(-60, 60), y: cursor.y + rand(-40, 40) };
          await page.mouse.move(cursor.x, cursor.y);
        }
      }
    },
  };
}
