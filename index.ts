/**
 * Public library surface for the scraper toolkit.
 *
 * This barrel curates the *reusable engine* — the pieces you compose in your
 * own code: fingerprinted browsers, missions and crawls, storage, proxies,
 * accounts/actions, the Cloudflare interstitial helper, ffuf enumeration, proxy
 * route parsing, the graded probe targets, and the error taxonomy.
 *
 * It deliberately does NOT re-export the application layer — `server.ts`,
 * `jobs.ts`, the dashboard glue, or the CLI entrypoints. Those are how the app
 * runs, not an API to build against.
 *
 * Everything here re-exports from the source modules unchanged; nothing is
 * redefined. Types are re-exported separately (`export type`) so the build's
 * isolated-module transpile stays unambiguous.
 */

// --- browsers: fingerprints, profiles, launching -------------------------
export {
  PROFILES,
  getProfile,
  filterProfiles,
  randomProfile,
  profileRotator,
  ensureDisplay,
  launchProfile,
} from "./browsers";
export type {
  Engine,
  FormFactor,
  Fingerprint,
  BrowserProfile,
  Session,
} from "./browsers";

// --- missions: send a fingerprint at a page, get a result ----------------
export {
  defineMission,
  runMission,
  runOnce,
  runEach,
  partition,
  fetchViaPage,
} from "./missions";
export type {
  Mission,
  MissionContext,
  MissionResult,
  RunOptions,
  PageResponse,
  PageFetch,
} from "./missions";

// --- crawl: many browsers over one site, shared queue + throttle ---------
export { crawl, pageRange, WorkQueue, HostLimiter } from "./crawl";
export type { CrawlContext, CrawlOptions, CrawlResult } from "./crawl";

// --- stack: a batch of browsers to drive by hand -------------------------
export { openStack, planStack } from "./stack";
export type { StackKind, StackOptions, StackSession, Stack } from "./stack";

// --- storage: rows -> a database, as they arrive -------------------------
export {
  sqliteStore,
  jsonlStore,
  csvStore,
  memoryStore,
  multiStore,
  customStore,
  toRows,
} from "./storage";
export type { Store, Row, SaveMeta, SqliteOptions } from "./storage";

// --- proxies: single hop or a CONNECT chain ------------------------------
export {
  resolveProxy,
  startProxyChain,
  withProxy,
  proxyPool,
  describeProxy,
} from "./proxies";
export type { ProxyLike, ProxyHop, PlaywrightProxy, ActiveProxy } from "./proxies";

// --- routes: parse `label=url` proxy routes (pure, no network) -----------
export { parseRoutes, withDirect, selectRoutes, describeRoute } from "./routes";
export type { Route } from "./routes";

// --- accounts: one login per fingerprint ---------------------------------
export {
  accountBook,
  defineSite,
  createAccounts,
  ensureAccounts,
  signInAll,
  signInEach,
  signUp,
  signIn,
  newIdentity,
  newPassword,
  findField,
  formError,
  isSignedIn,
  FIELD_SELECTORS,
  SCRAPINGCOURSE,
  SCRAPINGCOURSE_DEMO,
} from "./accounts";
export type {
  Identity,
  AuthSpec,
  FieldKind,
  FoundField,
  AuthOptions,
  AuthOutcome,
  Credentials,
  Account,
  AccountBook,
  AccountStatus,
  AccountRunOptions,
  AccountRunResult,
} from "./accounts";

// --- actions: what a browser does once it is signed in -------------------
export {
  parseActions,
  runActions,
  describeAction,
  shotName,
  ACTION_KINDS,
} from "./actions";
export type {
  Action,
  ActionKind,
  StepResult,
  ActionsOutcome,
  ActionOptions,
} from "./actions";

// --- turnstile: pass a Cloudflare interstitial ---------------------------
export {
  passChallenge,
  gotoAndPass,
  isChallenged,
  challengeState,
  widgetBox,
  clearanceToken,
} from "./turnstile";
export type { ChallengeOptions, ChallengeState, ChallengeOutcome } from "./turnstile";

// --- ffuf: path/subdomain enumeration via the ffuf binary ----------------
export {
  fuzzPaths,
  enumerateSubdomains,
  runFfuf,
  buildFfufArgs,
  parseFfufJson,
  DEFAULT_MATCH_STATUS,
  DEFAULT_THREADS,
  DEFAULT_RATE,
  DEFAULT_INPUT_NUM,
} from "./ffuf";
export type { FfufResult, FfufOptions, FfufMode } from "./ffuf";

// --- targets: the graded list of live probe targets ----------------------
export { TARGETS, selectTargets } from "./targets";
export type { Target, Vendor, Category, TargetFilter } from "./targets";

// --- errors: the shared error taxonomy -----------------------------------
export {
  ScraperError,
  ConfigError,
  LaunchError,
  ProxyError,
  ChallengeError,
  FfufError,
  StorageError,
} from "./errors";
export type { ScraperErrorOptions } from "./errors";
