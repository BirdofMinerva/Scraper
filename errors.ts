/**
 * Typed errors, so a library consumer can branch on *why* something failed
 * without string-matching the message.
 *
 * Every failure a caller of the public API can realistically hit is one of the
 * subclasses below. They all extend `ScraperError`, which extends `Error`, so
 * `instanceof Error` still holds and existing `.message` text is untouched -
 * the only thing that changes at a throw site is the concrete class. Each
 * carries a stable `code` (`"CONFIG"`, `"FFUF"`, …) for consumers that would
 * rather switch on a string than an `instanceof` chain.
 *
 * What is deliberately *not* here: cancellation. A run stopped through an
 * `AbortSignal` still rejects with the web-standard `AbortError` (name
 * `"AbortError"`), because that is the contract every consumer of an
 * `AbortController` already expects - turning it into a `ScraperError` would
 * make "I stopped it" look like "it broke".
 */

/** Options accepted by every error here - just the standard `cause`. */
export type ScraperErrorOptions = { cause?: unknown };

/**
 * The base class for every failure this toolkit raises on purpose.
 *
 * `name` is set from `new.target` so a subclass reports its own class name in
 * stack traces without each one repeating the assignment, and `code` is the
 * machine-readable discriminant.
 */
export class ScraperError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ScraperErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Bad options or failed validation - a config that cannot work as written. */
export class ConfigError extends ScraperError {
  constructor(message: string, options?: ScraperErrorOptions) {
    super(message, "CONFIG", options);
  }
}

/** A browser, virtual display, or profile that would not launch. */
export class LaunchError extends ScraperError {
  constructor(message: string, options?: ScraperErrorOptions) {
    super(message, "LAUNCH", options);
  }
}

/** A proxy that could not be set up, or refused the connection. */
export class ProxyError extends ScraperError {
  constructor(message: string, options?: ScraperErrorOptions) {
    super(message, "PROXY", options);
  }
}

/** A Cloudflare / Turnstile interstitial that would not pass. */
export class ChallengeError extends ScraperError {
  constructor(message: string, options?: ScraperErrorOptions) {
    super(message, "CHALLENGE", options);
  }
}

/** ffuf failed to spawn, timed out, exited badly, or produced output we could not parse. */
export class FfufError extends ScraperError {
  constructor(message: string, options?: ScraperErrorOptions) {
    super(message, "FFUF", options);
  }
}

/** A store or SQLite operation that failed. */
export class StorageError extends ScraperError {
  constructor(message: string, options?: ScraperErrorOptions) {
    super(message, "STORAGE", options);
  }
}
