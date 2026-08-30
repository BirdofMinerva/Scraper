/**
 * A local dashboard for the toolkit.
 *
 *   npm run dash            # http://127.0.0.1:8420
 *   npx tsx server.ts --port=9000 --host=0.0.0.0
 *
 * One process, no dependencies, no build step: `node:http` serves a single
 * HTML file, runs jobs in-process, and streams their output over
 * server-sent events. Jobs run *in* this process rather than as spawned CLIs
 * so the browsers are ours to stop, and so a crash is visible in the terminal
 * panel rather than swallowed by a child's stdio.
 *
 * It binds to 127.0.0.1 by default and has no authentication, because it can
 * start browsers, write files and use whatever proxies it is given. Putting it
 * on a public interface hands all of that to whoever finds it - so `--host`
 * makes you say so, and says as much when you do.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { runJob, type JobConfig, type JobResult, type LogLevel } from "./jobs";
import { LOGIN_SITES } from "./login-sites";
import { PROFILES } from "./browsers";
import { accountBook } from "./accounts";
import { DEFAULT_MATCH_STATUS, DEFAULT_THREADS, DEFAULT_RATE, DEFAULT_INPUT_NUM } from "./ffuf";

const DASHBOARD = path.join(__dirname, "dashboard.html");
/** Screenshots a bot run takes, one directory per run. */
const RUN_DIR = path.resolve("runs");

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type LogLine = { at: number; level: LogLevel; message: string };

export type Run = {
  id: string;
  mode: JobConfig["mode"];
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  config: JobConfig;
  log: LogLine[];
  stats: Record<string, number | string>;
  progress: { done: number; total?: number };
  result?: JobResult;
  error?: string;
  stopRequested: boolean;
};

/** How much of a run is kept: enough to read back, not enough to eat the heap. */
const MAX_LOG_LINES = 4000;
const MAX_RUNS = 40;

type Listener = (event: string, data: unknown) => void;

export function createRuns() {
  const runs = new Map<string, Run>();
  const listeners = new Map<string, Set<Listener>>();

  const emit = (id: string, event: string, data: unknown) => {
    for (const listener of listeners.get(id) ?? []) listener(event, data);
  };

  const append = (run: Run, level: LogLevel, message: string) => {
    const line = { at: Date.now(), level, message };
    run.log.push(line);
    // A ring rather than unbounded growth: a long crawl is tens of thousands
    // of lines and nobody scrolls back that far.
    if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES);
    emit(run.id, "log", line);
  };

  return {
    runs,

    list: () =>
      [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(({ log, config, result, ...rest }) => ({
          ...rest,
          lines: log.length,
          summary: result?.summary,
        })),

    get: (id: string) => runs.get(id),

    subscribe(id: string, listener: Listener) {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },

    stop(id: string) {
      const run = runs.get(id);
      if (!run || run.status !== "running") return false;
      run.stopRequested = true;
      append(run, "warn", "stop requested - finishing the page in flight");
      return true;
    },

    start(config: JobConfig): Run {
      const run: Run = {
        id: randomUUID().slice(0, 8),
        mode: config.mode,
        status: "running",
        startedAt: Date.now(),
        config,
        log: [],
        stats: {},
        progress: { done: 0 },
        stopRequested: false,
      };
      // A directory per run, so a screenshot can be traced back to the run
      // that took it without a filename convention doing the remembering.
      if (config.mode === "bot" && !config.shotDir) {
        config.shotDir = path.join(RUN_DIR, run.id);
      }
      runs.set(run.id, run);
      for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - MAX_RUNS))) {
        if (runs.get(old)?.status !== "running") runs.delete(old);
      }

      const ctx = {
        log: (level: LogLevel, message: string) => append(run, level, message),
        progress: (done: number, total?: number) => {
          run.progress = { done, total };
          emit(run.id, "progress", run.progress);
        },
        stat: (name: string, value: number | string) => {
          run.stats[name] = value;
          emit(run.id, "stats", run.stats);
        },
        stopped: () => run.stopRequested,
      };

      append(run, "step", `${config.mode} run started`);

      // Console from inside the toolkit belongs to whichever run made it -
      // `crawl` and friends print progress of their own, and it is worth more
      // in the panel than in the terminal nobody is looking at.
      inRun(run.id, ctx.log, async () => {
        try {
          run.result = await runJob(config, ctx);
          run.status = run.stopRequested ? "stopped" : "done";
          append(run, "good", run.result.summary);
        } catch (error) {
          run.status = "failed";
          run.error = (error as Error).message;
          append(run, "error", run.error);
        } finally {
          run.endedAt = Date.now();
          emit(run.id, "done", {
            status: run.status,
            summary: run.result?.summary,
            error: run.error,
            rows: run.result?.rows?.slice(0, 50) ?? [],
            shots: (run.result?.shots ?? []).map((file) => path.basename(file)),
            seedUrls: run.result?.seedUrls ?? [],
            stats: run.stats,
          });
        }
      });

      return run;
    },
  };
}

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

const active = new AsyncLocalStorage<{ id: string; log: (l: LogLevel, m: string) => void }>();
let patched = false;

/**
 * Run a job with `console` routed into its log.
 *
 * `AsyncLocalStorage` rather than a global swap: two runs going at once would
 * otherwise interleave into whichever started last, and attributing one
 * browser's errors to another run is worse than not capturing them at all.
 * Anything printed outside a run still goes to the real terminal.
 */
function inRun(id: string, log: (level: LogLevel, message: string) => void, fn: () => void) {
  if (!patched) {
    patched = true;
    for (const [method, level] of [
      ["log", "info"],
      ["info", "info"],
      ["warn", "warn"],
      ["error", "error"],
    ] as const) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        const store = active.getStore();
        if (!store) return original(...args);
        store.log(level, args.map(String).join(" ").replace(/\s+$/, ""));
      };
    }
  }
  active.run({ id, log }, fn);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // A config is a few kilobytes; anything larger is a mistake or an attack.
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("body is not JSON"));
      }
    });
    req.on("error", reject);
  });

export function createServer(store = createRuns()) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /" || route === "GET /index.html") {
        const html = fs.readFileSync(DASHBOARD);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      // What the form needs to build its dropdowns, so the UI never carries a
      // second copy of the catalogue.
      if (route === "GET /api/options") {
        return json(res, 200, {
          profiles: PROFILES.map((p) => ({ id: p.id, formFactor: p.formFactor, engine: p.engine })),
          kinds: ["mixed", "desktop", "mobile", "tablet", "handheld"],
          engines: ["chromium", "firefox", "webkit"],
          presets: LOGIN_SITES.map((s) => ({
            name: s.spec.name,
            loginUrl: s.spec.loginUrl,
            signupUrl: s.spec.signupUrl ?? null,
            note: s.note,
            hasCredentials: true,
          })),
          // The ffuf engine's own defaults, so the enumerate form shows the real
          // values as placeholders and they cannot drift from ffuf.ts - the same
          // "the UI never carries a second copy" reason as the catalogue above.
          ffufDefaults: {
            matchStatus: DEFAULT_MATCH_STATUS,
            threads: DEFAULT_THREADS,
            rate: DEFAULT_RATE,
            inputNum: DEFAULT_INPUT_NUM,
          },
        });
      }

      // The accounts already on file, so "sign each browser in" can be run
      // without pasting anything.
      if (route === "GET /api/accounts") {
        const file = url.searchParams.get("path") || "accounts.db";
        if (!fs.existsSync(file)) return json(res, 200, { path: file, accounts: [] });
        const book = accountBook({ path: file });
        try {
          const accounts = book.all().map(({ password, ...rest }) => ({
            ...rest,
            password: password ? "•".repeat(8) : "",
          }));
          return json(res, 200, { path: file, accounts });
        } finally {
          book.close();
        }
      }

      if (route === "GET /api/runs") return json(res, 200, store.list());

      if (route === "POST /api/runs") {
        const config = (await readBody(req)) as JobConfig;
        if (config?.mode !== "scrape" && config?.mode !== "bot" && config?.mode !== "enumerate") {
          return json(res, 400, { error: "mode must be scrape, bot or enumerate" });
        }
        try {
          // Validated here so a bad config is a red line in the form rather
          // than a failed run in the history.
          const { validate } = await import("./jobs");
          validate(config);
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
        const run = store.start(config);
        return json(res, 201, { id: run.id });
      }

      const stopMatch = /^POST \/api\/runs\/([\w-]+)\/stop$/.exec(route);
      if (stopMatch) {
        return json(res, 200, { stopped: store.stop(stopMatch[1]) });
      }

      const eventsMatch = /^GET \/api\/runs\/([\w-]+)\/events$/.exec(route);
      if (eventsMatch) {
        const run = store.get(eventsMatch[1]);
        if (!run) return json(res, 404, { error: "no such run" });

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        const send = (event: string, data: unknown) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        // Replay first: a browser that reloads mid-run, or opens a finished
        // one, sees the whole thing rather than an empty panel.
        send("replay", { log: run.log, stats: run.stats, progress: run.progress, status: run.status });
        if (run.status !== "running") {
          send("done", {
            status: run.status,
            summary: run.result?.summary,
            error: run.error,
            rows: run.result?.rows?.slice(0, 50) ?? [],
            shots: (run.result?.shots ?? []).map((file) => path.basename(file)),
            seedUrls: run.result?.seedUrls ?? [],
            stats: run.stats,
          });
        }

        const unsubscribe = store.subscribe(run.id, send);
        // Proxies and browsers drop an idle stream; a comment every 15s is
        // enough to keep it open and costs nothing.
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          unsubscribe();
        });
        return;
      }

      // A run's screenshots. The name is taken apart and rebuilt rather than
      // joined: `..%2f..%2fetc/passwd` is the oldest trick there is, and this
      // server is one `--host` away from being reachable.
      const shotMatch = /^GET \/api\/runs\/([\w-]+)\/shots\/([\w.-]+)$/.exec(route);
      if (shotMatch) {
        const [, id, name] = shotMatch;
        const file = path.join(RUN_DIR, id, path.basename(name));
        if (!file.startsWith(RUN_DIR + path.sep) || !file.endsWith(".png") || !fs.existsSync(file)) {
          return json(res, 404, { error: "no such screenshot" });
        }
        const png = fs.readFileSync(file);
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": png.length,
          // The file never changes once written; a run's gallery re-renders
          // often while the page is open.
          "cache-control": "public, max-age=31536000, immutable",
        });
        return res.end(png);
      }

      const runMatch = /^GET \/api\/runs\/([\w-]+)$/.exec(route);
      if (runMatch) {
        const run = store.get(runMatch[1]);
        return run ? json(res, 200, run) : json(res, 404, { error: "no such run" });
      }

      json(res, 404, { error: `no route for ${route}` });
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

  const port = Number(flag("port", "8420"));
  const host = flag("host", "127.0.0.1");

  createServer().listen(port, host, () => {
    console.log(`dashboard on http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.log(
        `WARNING: bound to ${host}. This server launches browsers, writes files and\n` +
          "         uses the proxies it is given, and has no authentication."
      );
    }
  });
}
