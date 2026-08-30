/**
 * A typed wrapper around the installed `ffuf` binary (v2.1.0) for the two
 * enumeration shapes this toolkit needs: path/wordlist discovery against a
 * base URL (`https://site/FUZZ`) and DNS subdomain enumeration against a domain
 * (`https://FUZZ.domain/`).
 *
 * ffuf's own output is a spinner and a wall of coloured lines — useful in a
 * terminal, useless to a program. This module runs it non-interactively, asks
 * for `-of json` written to a temp file, and parses that file into a flat,
 * typed `FfufResult[]` the rest of the toolkit can store and diff. The parsing
 * (`parseFfufJson`) and the argument building (`buildFfufArgs`) are pure and
 * network-free so they can be unit-tested without spawning anything — the same
 * split as `routes.ts` keeps beside `proxies.ts`.
 *
 * Safe defaults matter here: rate is capped at 100 req/s and threads at 40 so a
 * run does not hammer a target into blocking (or into an outage). ffuf is a
 * request cannon — point it ONLY at hosts you are authorised to test. There is
 * no authorisation check in this file; that responsibility is the caller's.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Path to the ffuf binary. Overridable for tests / non-standard installs. */
export const FFUF_BIN = process.env.FFUF_BIN || "ffuf";

/** ffuf's default `-mc`, spelled out so callers can see (and override) it. */
export const DEFAULT_MATCH_STATUS = "200,204,301,302,307,401,403,405,500";

/** Safe default concurrency (`-t`). One source of truth, served to the UI. */
export const DEFAULT_THREADS = 40;

/** Safe default request rate (`-rate`, req/s) — capped, not unlimited. */
export const DEFAULT_RATE = 100;

/** Default number of inputs pulled from `-input-cmd` when none is given. */
export const DEFAULT_INPUT_NUM = 100;

/** One matched hit, flattened from ffuf's JSON result object. */
export type FfufResult = {
  input: string; // the FUZZ value that matched
  url: string; // full resolved URL of the hit
  host?: string; // resolved hostname (subdomain mode)
  status: number;
  length: number;
  words: number;
  lines: number;
  contentType?: string;
  redirectLocation?: string;
  durationMs?: number;
};

export type FfufOptions = {
  wordlist?: string; // path to wordlist file (-w); required UNLESS inputCmd is set
  threads?: number; // -t, default DEFAULT_THREADS
  rate?: number; // -rate req/s; defaults to a safe DEFAULT_RATE, not unlimited
  timeoutMs?: number; // overall process timeout, default 120000
  matchStatus?: string; // -mc, default DEFAULT_MATCH_STATUS
  filterStatus?: string; // -fc
  filterSize?: string | number; // -fs
  filterWords?: string | number; // -fw
  extensions?: string; // -e comma list, e.g. ".php,.html,.bak" (added only when non-empty)
  recursion?: boolean; // -recursion (path mode only — the URL must end in FUZZ)
  recursionDepth?: number; // -recursion-depth <n>; implies -recursion
  inputCmd?: string; // -input-cmd <cmd>; OVERRIDES -w (no wordlist is passed)
  inputNum?: number; // -input-num <n> for input-cmd, default DEFAULT_INPUT_NUM
  headers?: Record<string, string>; // -H "Key: Value"
  signal?: AbortSignal; // cooperative cancellation
  extraArgs?: string[]; // escape hatch, appended verbatim
  /**
   * Called once per hit as ffuf discovers it, before the full array resolves.
   * Enables live progress and incremental writes downstream. Omitting it leaves
   * behaviour identical to today. Every hit in the returned array fires exactly
   * once on a normal run.
   *
   * The streamed hit is parsed from ffuf's live stdout, so it carries the same
   * identity fields (`input`, `url`, `host`, `status`, `length`, `words`,
   * `lines`) as its twin in the returned array. Two fields differ by source:
   * `contentType`/`redirectLocation` are only in the authoritative JSON (absent
   * on the streamed hit), and `durationMs` is coarser live (integer ms from
   * stdout vs sub-ms from the JSON file). Reconcile on the identity fields.
   */
  onResult?: (hit: FfufResult) => void;
};

export type FfufMode = "path" | "subdomain";

/**
 * Shape the target URL for ffuf. A URL that already carries the `FUZZ` keyword
 * is trusted as-is (the escape hatch for Host-header fuzzing, POST bodies, or
 * a keyword mid-path). Otherwise:
 *   - path mode:      `<baseUrl>/FUZZ`         (one trailing slash, never two)
 *   - subdomain mode: `https://FUZZ.<domain>/` (scheme/paths stripped first)
 */
export function shapeFfufUrl(url: string, mode: FfufMode): string {
  if (url.includes("FUZZ")) return url;
  if (mode === "subdomain") {
    const domain = bareDomain(url);
    if (!domain) throw new Error(`ffuf subdomain mode needs a domain, got "${url}"`);
    return `https://FUZZ.${domain}/`;
  }
  // path mode: collapse any trailing slashes so we never emit `host//FUZZ`.
  return `${url.replace(/\/+$/, "")}/FUZZ`;
}

/** `https://Example.com/path/` -> `example.com`. */
function bareDomain(input: string): string {
  return input
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

/**
 * Build the ffuf argument vector for a run. Pure: no spawning, no temp files.
 *
 * The output flags are half here on purpose — `-of json` is included so the
 * format is fixed, but `-o <file>` is NOT, because the destination is an
 * ephemeral temp path chosen at spawn time by `runFfuf`. Everything else a run
 * needs is here and therefore unit-testable.
 */
export function buildFfufArgs(url: string, mode: FfufMode, opts: FfufOptions): string[] {
  const hasWordlist = !!opts?.wordlist && opts.wordlist.trim() !== "";
  const hasInputCmd = !!opts?.inputCmd && opts.inputCmd.trim() !== "";
  if (!hasWordlist && !hasInputCmd) {
    throw new Error("ffuf needs an input source: a wordlist (opts.wordlist) or opts.inputCmd");
  }

  // recursion needs the URL to end in FUZZ. Path mode's shaped URL does
  // (`<base>/FUZZ`); subdomain mode's does not (`https://FUZZ.<domain>/`), so
  // ffuf would exit with an error. Refuse loudly rather than emit a command we
  // know is broken.
  const wantsRecursion = opts.recursion === true || opts.recursionDepth != null;
  if (wantsRecursion && mode === "subdomain") {
    throw new Error(
      "ffuf recursion requires the URL to end in FUZZ, which subdomain mode does not — recursion is path-mode only",
    );
  }

  const args: string[] = [];
  /** Push `flag value` only when value is present and non-empty (0 counts). */
  const pushFlag = (flag: string, value: unknown) => {
    if (value != null && String(value) !== "") args.push(flag, String(value));
  };

  // Input source: `-input-cmd` overrides `-w`, so they are mutually exclusive.
  // When both are given, input-cmd wins and no wordlist is passed.
  if (hasInputCmd) {
    args.push("-input-cmd", opts.inputCmd!.trim());
    args.push("-input-num", String(opts.inputNum ?? DEFAULT_INPUT_NUM));
  } else {
    args.push("-w", opts.wordlist!);
  }

  args.push("-u", shapeFfufUrl(url, mode), "-of", "json");

  // Silent (bare match values only, no banner/progress) UNLESS streaming:
  // onResult is driven by the full result lines ffuf prints live, which `-s`
  // suppresses. With no callback we keep `-s`, so that path is byte-for-byte
  // what it was before streaming existed. The JSON `-o` file is the source of
  // truth for the returned array either way.
  if (!opts.onResult) args.push("-s");

  args.push("-t", String(opts.threads ?? DEFAULT_THREADS));
  args.push("-rate", String(opts.rate ?? DEFAULT_RATE));
  args.push("-mc", opts.matchStatus ?? DEFAULT_MATCH_STATUS);

  pushFlag("-fc", opts.filterStatus);
  pushFlag("-fs", opts.filterSize);
  pushFlag("-fw", opts.filterWords);
  pushFlag("-e", opts.extensions);

  if (wantsRecursion) {
    args.push("-recursion");
    if (opts.recursionDepth != null) args.push("-recursion-depth", String(opts.recursionDepth));
  }

  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);

  return args;
}

/** One entry in ffuf's `results` array, as it appears on disk. */
type RawFfufResult = {
  input?: Record<string, string> | null;
  url?: string;
  host?: string;
  status?: number;
  length?: number;
  words?: number;
  lines?: number;
  "content-type"?: string;
  redirectlocation?: string;
  duration?: number; // nanoseconds (Go time.Duration)
};

/**
 * Parse the contents of ffuf's `-of json` output file into `FfufResult[]`.
 *
 * Takes the file *contents* (a string) rather than a path so it is testable
 * against a fixture with no filesystem. Tolerant of an empty/absent `results`
 * array (returns `[]`); throws with a clear message on non-JSON input.
 */
export function parseFfufJson(raw: string): FfufResult[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ffuf JSON output was not valid JSON: ${(err as Error).message}`);
  }

  const results = (doc as { results?: unknown } | null)?.results;
  if (results == null) return []; // no matches, or `"results": null`
  if (!Array.isArray(results)) {
    throw new Error("ffuf JSON output had a non-array `results` field");
  }

  return results.map((entry) => flattenResult(entry as RawFfufResult));
}

function flattenResult(r: RawFfufResult): FfufResult {
  const out: FfufResult = {
    input: fuzzValue(r.input),
    url: String(r.url ?? ""),
    status: num(r.status),
    length: num(r.length),
    words: num(r.words),
    lines: num(r.lines),
  };

  if (r.host) out.host = r.host;
  if (r["content-type"]) out.contentType = r["content-type"];
  if (r.redirectlocation) out.redirectLocation = r.redirectlocation;
  if (typeof r.duration === "number" && Number.isFinite(r.duration)) {
    // ffuf reports request duration in nanoseconds; expose milliseconds.
    out.durationMs = Math.round(r.duration / 1e3) / 1e3;
  }

  return out;
}

/**
 * The matched wordlist value. ffuf's `input` map holds the real keyword (`FUZZ`
 * by default) alongside a bookkeeping `FFUFHASH`; prefer `FUZZ`, then any other
 * non-hash key, so a custom keyword still resolves.
 */
function fuzzValue(input: RawFfufResult["input"]): string {
  if (!input || typeof input !== "object") return "";
  if (typeof input.FUZZ === "string") return input.FUZZ;
  for (const [key, value] of Object.entries(input)) {
    if (key !== "FFUFHASH" && typeof value === "string") return value;
  }
  return "";
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Strip ANSI escapes and the carriage-return ffuf prefixes each line with. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/**
 * ffuf's live result line, non-silent + piped (stdout, not a TTY):
 *   `admin                   [Status: 200, Size: 22, Words: 2, Lines: 1, Duration: 0ms]`
 * The match value is left-padded, then the bracketed metrics. Banner and
 * progress render only to a TTY, so a piped stdout is just these lines.
 */
const RESULT_RE =
  /^(.*?)\s*\[Status:\s*(\d+),\s*Size:\s*(\d+),\s*Words:\s*(\d+),\s*Lines:\s*(\d+),\s*Duration:\s*(\d+)ms\]/;

/**
 * Parse one line of ffuf's live stdout into a hit, or `null` for any line that
 * is not a result (progress, blanks, stray output). Pure and network-free, so
 * the stream→hit mapping is unit-testable without spawning ffuf.
 *
 * `url` and `host` are reconstructed from the matched value and the run's
 * target/mode so a streamed hit lines up with its JSON twin: for path mode the
 * host is the URL authority (what ffuf records), for subdomain mode it is
 * `<match>.<domain>` (what `enumerateSubdomains` fills). `durationMs` here is
 * the integer ms ffuf prints live — coarser than the JSON file's sub-ms value.
 */
export function parseFfufLine(line: string, mode: FfufMode, target: string): FfufResult | null {
  const m = stripAnsi(line).match(RESULT_RE);
  if (!m) return null;
  const input = m[1].trim();
  if (!input) return null;

  const url = shapeFfufUrl(target, mode).replace("FUZZ", input);
  const hit: FfufResult = {
    input,
    url,
    status: Number(m[2]),
    length: Number(m[3]),
    words: Number(m[4]),
    lines: Number(m[5]),
    durationMs: Number(m[6]),
  };

  if (mode === "subdomain") {
    hit.host = `${input}.${bareDomain(target)}`;
  } else {
    try {
      hit.host = new URL(url).host;
    } catch {
      /* a target with no parseable authority leaves host unset */
    }
  }

  return hit;
}

/**
 * Spawn ffuf against a URL and return the parsed hits. Wires `opts.signal` and
 * `opts.timeoutMs` to kill the process; rejects on a non-zero exit that
 * produced no output, on timeout, or on abort. A non-zero exit that still wrote
 * results (ffuf can exit non-zero after a partial run) is parsed rather than
 * thrown away.
 */
export async function runFfuf(url: string, mode: FfufMode, opts: FfufOptions): Promise<FfufResult[]> {
  if (opts.signal?.aborted) throw abortError();

  const args = buildFfufArgs(url, mode, opts);
  const outFile = path.join(os.tmpdir(), `ffuf-${randomUUID()}.json`);
  const argv = [...args, "-o", outFile];
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const streaming = typeof opts.onResult === "function";

  return await new Promise<FfufResult[]>((resolve, reject) => {
    const child = spawn(FFUF_BIN, argv, {
      stdio: ["ignore", streaming ? "pipe" : "ignore", "pipe"],
    });

    let settled = false;
    let timedOut = false;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    // Live streaming: parse ffuf's stdout line by line as matches are found and
    // fire onResult per hit. The returned array still comes from the JSON file
    // below (authoritative); this only drives live progress. A throwing
    // consumer must not break the run, so callbacks are guarded.
    let stdoutBuf = "";
    const emitLine = (line: string) => {
      const hit = parseFfufLine(line, mode, url);
      if (!hit) return;
      try {
        opts.onResult!(hit);
      } catch {
        /* a consumer's error is theirs; the run carries on */
      }
    };
    if (streaming && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          emitLine(line);
        }
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fs.rm(outFile, { force: true }, () => {});
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`ffuf failed to start ("${FFUF_BIN}"): ${err.message}`));
    });

    child.on("close", async (code, sig) => {
      if (settled) return;
      settled = true;

      if (timedOut) {
        cleanup();
        return reject(new Error(`ffuf timed out after ${timeoutMs}ms`));
      }
      if (opts.signal?.aborted) {
        cleanup();
        return reject(abortError());
      }

      // Flush a final line with no trailing newline so its hit is not lost.
      if (streaming && stdoutBuf) {
        emitLine(stdoutBuf);
        stdoutBuf = "";
      }

      // Read the output off the event loop, before cleanup unlinks it. A
      // missing/empty file (a run that matched nothing, or wrote none) is
      // tolerated as raw = "" — same as the old sync read.
      let raw = "";
      try {
        raw = await fs.promises.readFile(outFile, "utf8");
      } catch {
        raw = "";
      }
      cleanup();

      if (code !== 0 && !raw) {
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        return reject(new Error(`ffuf exited ${code}${sig ? ` (${sig})` : ""}: ${tail || "no output"}`));
      }

      try {
        resolve(raw ? parseFfufJson(raw) : []);
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

function abortError(): Error {
  const err = new Error("ffuf run aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Fuzz paths under a base URL. `FUZZ` lands at `${baseUrl}/FUZZ` unless the URL
 * already contains the keyword, in which case it is used verbatim.
 */
export async function fuzzPaths(baseUrl: string, opts: FfufOptions): Promise<FfufResult[]> {
  return runFfuf(baseUrl, "path", opts);
}

/**
 * Enumerate subdomains of a domain: `FUZZ` lands at `https://FUZZ.<domain>/`,
 * and each hit's `.host` is set to the resolved `<match>.<domain>` so the
 * result names the subdomain it found rather than the base domain ffuf echoes.
 */
export async function enumerateSubdomains(domain: string, opts: FfufOptions): Promise<FfufResult[]> {
  const results = await runFfuf(domain, "subdomain", opts);
  const base = bareDomain(domain);
  return results.map((r) => ({
    ...r,
    host: r.input ? `${r.input}.${base}` : r.host,
  }));
}
