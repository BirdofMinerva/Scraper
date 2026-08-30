/**
 * Enumerate: point ffuf at a domain or URL and print what answered.
 *
 *   node --import tsx enumerate.ts example.com --mode=subdomain --wordlist=subs.txt
 *   node --import tsx enumerate.ts https://example.com/ --wordlist=common.txt --match=200,301
 *   npm run enum -- https://site/ --wordlist=paths.txt --threads=40
 *
 * A thin shell around `ffuf.ts`, the same way `field-test.ts` is a thin shell
 * around a mission: parse the flags, call the one function, print the hits.
 * The dashboard runs the very same API through `jobs.ts`; this is the version
 * for a terminal and a scriptable exit code. Discovered hits go to stdout so
 * the list can be piped straight into a scrape; the one-line "enumerating…"
 * note goes to stderr so it does not land in that pipe.
 *
 * The two shapes are ffuf's own: `subdomain` fuzzes `FUZZ.<domain>` and takes
 * a bare domain, `path` fuzzes `<url>/FUZZ` and takes a URL. When `--mode` is
 * omitted it is inferred from the target - a scheme means a path fuzz.
 */
import fs from "node:fs";
import {
  enumerateSubdomains,
  fuzzPaths,
  type FfufOptions,
  type FfufResult,
  type FfufMode,
} from "./ffuf";

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const number = (name: string) => {
    const raw = get(name);
    return raw === undefined || raw === "" ? undefined : Number(raw);
  };

  const target = argv.find((a) => !a.startsWith("--"));
  const looksLikeUrl = target ? /^https?:\/\//i.test(target) : false;
  const mode = (get("mode") ?? (looksLikeUrl ? "path" : "subdomain")) as FfufMode;

  return {
    target,
    mode,
    wordlist: get("wordlist"),
    threads: number("threads"),
    rate: number("rate"),
    timeoutMs: number("timeout"),
    // The short forms mirror ffuf's own flag names, the long ones read in a
    // script; either is accepted.
    matchStatus: get("match") ?? get("mc"),
    filterStatus: get("filter") ?? get("fc"),
    filterSize: get("fs"),
    filterWords: get("fw"),
    json: argv.includes("--json"),
  };
}

const USAGE = `enumerate - ffuf subdomain and path discovery

  node --import tsx enumerate.ts <domain-or-url> --wordlist=<file> [options]

  --mode=subdomain|path   subdomain fuzzes FUZZ.<domain>, path fuzzes <url>/FUZZ
                          (inferred from the target when omitted)
  --wordlist=<file>       required
  --threads=<n>           concurrent requests (ffuf default 40)
  --rate=<n>              requests per second (ffuf default 100)
  --match=<codes>         only keep these statuses, e.g. 200,301
  --filter=<codes>        drop these statuses, e.g. 404
  --fs=<size>             drop responses of this byte size
  --fw=<words>            drop responses with this many words
  --timeout=<ms>          overall process timeout (ffuf default 120000)
  --json                  print raw JSON instead of a table

  node --import tsx enumerate.ts example.com --mode=subdomain --wordlist=subs.txt
  node --import tsx enumerate.ts https://example.com/ --wordlist=common.txt --match=200,301`;

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const args = parseArgs(argv);

    if (argv.includes("--help") || argv.includes("-h") || !args.target) {
      console.log(USAGE);
      process.exit(args.target ? 0 : 1);
    }
    if (args.mode !== "subdomain" && args.mode !== "path") {
      console.error(`Unknown --mode=${args.mode}. Use subdomain or path.`);
      process.exit(1);
    }
    if (!args.wordlist) {
      console.error("A --wordlist=<file> is required.");
      process.exit(1);
    }
    if (!fs.existsSync(args.wordlist)) {
      console.error(`Wordlist not found: ${args.wordlist}`);
      process.exit(1);
    }
    if (args.mode === "path" && !/^https?:\/\//i.test(args.target)) {
      console.error("Path fuzzing needs a base URL, e.g. https://site/ or https://site/FUZZ");
      process.exit(1);
    }
    if (args.mode === "subdomain" && /^https?:\/\//i.test(args.target)) {
      console.error("Subdomain fuzzing takes a bare domain, e.g. example.com - drop the scheme");
      process.exit(1);
    }

    // Only what the user actually set: ffuf.ts fills the rest with safe
    // defaults (rate 100/s, threads 40, a sensible match list), so passing
    // `undefined` here is passing "use your default".
    const options: FfufOptions = {
      wordlist: args.wordlist,
      threads: args.threads,
      rate: args.rate,
      timeoutMs: args.timeoutMs,
      matchStatus: args.matchStatus,
      filterStatus: args.filterStatus,
      filterSize: args.filterSize,
      filterWords: args.filterWords,
    };

    const label = args.mode === "subdomain" ? "subdomains" : "paths";
    console.error(`${args.mode} enumeration of ${args.target} with ${args.wordlist}…`);

    const hits: FfufResult[] =
      args.mode === "subdomain"
        ? await enumerateSubdomains(args.target, options)
        : await fuzzPaths(args.target, options);

    // ffuf returns hits in completion order; sort so a re-run of the same
    // target prints the same list.
    hits.sort(
      (a, b) => (a.host ?? a.url).localeCompare(b.host ?? b.url) || a.url.localeCompare(b.url)
    );

    if (args.json) {
      console.log(JSON.stringify(hits, null, 2));
    } else {
      for (const h of hits) {
        console.log(
          `${String(h.status).padEnd(4)} ${String(h.length).padStart(8)}b  ` +
            `${(h.host ?? "").padEnd(28)} ${h.url}`
        );
      }
      console.error(`\n${hits.length} ${label} found`);
    }
    process.exit(0);
  })().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
