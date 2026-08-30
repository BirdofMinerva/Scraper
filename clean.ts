/**
 * Clearing out what a run left behind - one database, several, or all of them.
 *
 *   npx tsx clean.ts --list                 # what is here, and what is in it
 *   npx tsx clean.ts challenges.db          # one
 *   npx tsx clean.ts field-test.db hard-test.db
 *   npx tsx clean.ts --all
 *   npx tsx clean.ts --all --empty          # keep the files and their schema
 *   npx tsx clean.ts --handoff              # everything before giving this away
 *   npx tsx clean.ts --all --dry-run
 *
 * The case this exists for is handing the project to someone else. A scrape
 * database is other people's data, and `accounts.db` holds **passwords in
 * plain text** - it has to, because a browser has to type them. Neither is
 * something to pass on by forgetting it is there, and `.gitignore` only stops
 * them reaching a repository, not a zip file or a shared folder.
 *
 * Deletion lives here and not in the dashboard on purpose: that server has no
 * authentication, and "delete every database" is not a button an
 * unauthenticated local service should own.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

/** SQLite writes these beside the database; deleting the file alone leaves them. */
const SIDECARS = ["-wal", "-shm", "-journal"];

/**
 * Files a handoff should not carry, beyond the databases.
 *
 * `proxies.txt` is here because a route line is `label=http://user:pass@host`
 * - credentials for someone else's proxy, in a file whose name does not
 * suggest it holds any.
 */
const EXTRA_PATTERNS = [/\.jsonl$/i, /^proxies\.txt$/i, /^scraped.*\.csv$/i];

export type TableInfo = { name: string; rows: number };

export type DbInfo = {
  file: string;
  bytes: number;
  tables: TableInfo[];
  rows: number;
  sidecars: string[];
  /** A password column: the one file that must not be handed on. */
  credentials: boolean;
  /** Cookie or token columns - session traces rather than logins. */
  session: boolean;
  /** Set when the file could not be read as a database. */
  error?: string;
};

const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);

/** Every `.db` in a directory, sidecars excluded - they are not databases. */
export function discover(dir = process.cwd()): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".db"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** The non-database files a handoff should also clear. */
export function discoverExtras(dir = process.cwd()): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => EXTRA_PATTERNS.some((pattern) => pattern.test(name)))
    .sort()
    .map((name) => path.join(dir, name));
}

export const sidecarsFor = (file: string) =>
  SIDECARS.map((suffix) => file + suffix).filter((f) => fs.existsSync(f));

/**
 * Open a database for inspection without leaving anything behind.
 *
 * Plain `readOnly` still creates `-wal` and `-shm` beside a WAL database, so
 * merely listing what is here would add two files per database and then report
 * them as "+2 sidecar" - a listing that changes what it is listing. The
 * `immutable=1` URI reads without them.
 *
 * The exception is a database that already has a `-wal`: immutable would not
 * see anything still sitting in that log, and undercounting rows in a report
 * someone is about to delete things from is worse than touching a file that
 * already exists.
 */
function openForReading(file: string): DatabaseSync {
  if (fs.existsSync(file + "-wal")) return new DatabaseSync(file, { readOnly: true });
  try {
    return new DatabaseSync(`file:${path.resolve(file)}?immutable=1`, { readOnly: true });
  } catch {
    return new DatabaseSync(file, { readOnly: true });
  }
}

/**
 * What is in a database, without changing it.
 *
 * Read before delete, always: the whole point of `--list` is that nobody
 * deletes three hours of crawling because a filename looked like scratch.
 */
export function describe(file: string): DbInfo {
  const base: DbInfo = {
    file,
    bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    tables: [],
    rows: 0,
    sidecars: sidecarsFor(file),
    credentials: false,
    session: false,
  };

  let db: DatabaseSync | undefined;
  try {
    db = openForReading(file);
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    const tables = names.map((name) => ({
      name,
      rows: Number(
        (db!.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number | bigint }).n
      ),
    }));

    // Two different worries, kept apart on purpose. A password column is a
    // login someone could use; a cookies column is usually a trace of a
    // session, and `field-test-live.db` has one holding cookie *names*.
    // Labelling that "holds credentials" would spend the warning that the
    // account book actually needs.
    const columnsOf = (name: string) =>
      (db!.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name);
    const columns = names.flatMap(columnsOf);
    const credentials = columns.some((c) => /password|passwd|secret/i.test(c));
    const session = columns.some((c) => /token|cookie|clearance|session/i.test(c));

    return { ...base, tables, rows: sum(tables.map((t) => t.rows)), credentials, session };
  } catch (error) {
    return { ...base, error: (error as Error).message.split("\n")[0] };
  } finally {
    db?.close();
  }
}

export type CleanMode = "delete" | "empty";

export type CleanResult = {
  file: string;
  mode: CleanMode;
  /** Rows removed, or the bytes freed when the file was deleted. */
  rowsRemoved: number;
  bytesFreed: number;
  removed: string[];
  error?: string;
};

/**
 * Empty a database, keeping the file and its schema.
 *
 * For a database something else is pointed at: dropping the file and letting
 * it be recreated works, but a store holding an open handle keeps writing to
 * the deleted inode, and the rows go nowhere anyone can find them.
 *
 * `sqlite_sequence` is reset too, or the next run's `_id` column carries on
 * from the deleted rows and the numbering says the table is not empty history.
 */
function empty(file: string, info: DbInfo): CleanResult {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN");
    for (const table of info.tables) db.exec(`DELETE FROM "${table.name}"`);
    const hasSequence = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
      .get();
    if (hasSequence) db.exec("DELETE FROM sqlite_sequence");
    db.exec("COMMIT");
    // Outside the transaction: VACUUM cannot run inside one, and without it
    // the file keeps the pages the rows used and looks untouched.
    db.exec("VACUUM");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    return {
      file,
      mode: "empty",
      rowsRemoved: 0,
      bytesFreed: 0,
      removed: [],
      error: (error as Error).message.split("\n")[0],
    };
  } finally {
    db.close();
  }

  const after = fs.statSync(file).size;
  return {
    file,
    mode: "empty",
    rowsRemoved: info.rows,
    bytesFreed: Math.max(0, info.bytes - after),
    removed: [],
  };
}

/** Delete a database and the sidecars SQLite keeps beside it. */
function remove(file: string, info: DbInfo): CleanResult {
  const removed: string[] = [];
  let bytesFreed = 0;

  for (const target of [file, ...info.sidecars]) {
    if (!fs.existsSync(target)) continue;
    bytesFreed += fs.statSync(target).size;
    fs.rmSync(target);
    removed.push(target);
  }

  return { file, mode: "delete", rowsRemoved: info.rows, bytesFreed, removed };
}

/** Clear one file. Nothing throws; a failure comes back on the result. */
export function clean(file: string, mode: CleanMode = "delete"): CleanResult {
  if (!fs.existsSync(file)) {
    return { file, mode, rowsRemoved: 0, bytesFreed: 0, removed: [], error: "no such file" };
  }

  const info = describe(file);
  if (mode === "empty" && info.error) {
    return { file, mode, rowsRemoved: 0, bytesFreed: 0, removed: [], error: info.error };
  }
  return mode === "empty" ? empty(file, info) : remove(file, info);
}

/** Delete a plain file - a JSONL export, a proxy list. */
export function cleanFile(file: string): CleanResult {
  if (!fs.existsSync(file)) {
    return { file, mode: "delete", rowsRemoved: 0, bytesFreed: 0, removed: [], error: "no such file" };
  }
  const bytes = fs.statSync(file).size;
  fs.rmSync(file);
  return { file, mode: "delete", rowsRemoved: 0, bytesFreed: bytes, removed: [file] };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

const rel = (file: string) => path.relative(process.cwd(), file) || file;

export function report(infos: DbInfo[]): string {
  if (infos.length === 0) return "No databases here.";

  const lines = infos.map((info) => {
    const head = `${rel(info.file).padEnd(26)}${size(info.bytes).padStart(8)}  `;
    if (info.error) return head + `unreadable: ${info.error}`;

    const tables = info.tables.length
      ? info.tables.map((t) => `${t.name} ${t.rows}`).join(", ")
      : "empty";
    const extras = [
      info.sidecars.length ? `+${info.sidecars.length} sidecar` : "",
      info.credentials ? "PASSWORDS" : "",
      info.session ? "session data" : "",
    ]
      .filter(Boolean)
      .join("  ");
    return head + tables + (extras ? `  [${extras}]` : "");
  });

  const risky = infos.filter((i) => i.credentials);
  const total = sum(infos.map((i) => i.rows));
  const bytes = sum(infos.map((i) => i.bytes + sum(i.sidecars.map((s) => fs.statSync(s).size))));
  lines.push("-".repeat(76));
  lines.push(
    `${infos.length} database${infos.length === 1 ? "" : "s"}, ` +
      `${total} row${total === 1 ? "" : "s"}, ${size(bytes)}`
  );
  if (risky.length) {
    // Stored in plain text because a browser has to type them. Worth saying
    // once, plainly, at the moment someone is looking at the list.
    lines.push(
      `${risky.map((i) => rel(i.file)).join(", ")} hold${risky.length === 1 ? "s" : ""} ` +
        `passwords in plain text - clear before sharing this directory.`
    );
  }
  return lines.join("\n");
}

const ask = (question: string) =>
  new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });

const USAGE = `Clear the databases a run leaves behind.

  npx tsx clean.ts --list                  what is here, and what is in it
  npx tsx clean.ts challenges.db           clear one
  npx tsx clean.ts a.db b.db               clear several
  npx tsx clean.ts --all                   every .db in this directory
  npx tsx clean.ts --handoff               every .db, plus exports and proxies.txt

  --empty      keep the files and their schema, remove the rows
  --dry-run    print what would happen and change nothing
  --yes        skip the confirmation (required when not on a terminal)
`;

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const named = argv.filter((a) => !a.startsWith("--"));

  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return 0;
  }

  const mode: CleanMode = flags.has("--empty") ? "empty" : "delete";
  const dryRun = flags.has("--dry-run");
  const handoff = flags.has("--handoff");
  const all = flags.has("--all") || handoff;

  if (flags.has("--list")) {
    console.log(report(discover().map(describe)));
    const extras = discoverExtras();
    if (extras.length) {
      console.log(`\nAlso here, and cleared by --handoff:\n  ${extras.map(rel).join("\n  ")}`);
    }
    return 0;
  }

  const databases = all ? discover() : named.map((f) => path.resolve(f));
  const extras = handoff ? discoverExtras() : [];

  if (databases.length === 0 && extras.length === 0) {
    console.log(named.length ? "None of those files exist." : USAGE);
    return named.length ? 1 : 0;
  }

  const missing = databases.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.log(`Not found: ${missing.map(rel).join(", ")}`);
    return 1;
  }

  const infos = databases.map(describe);
  console.log(report(infos));
  if (extras.length) console.log(`\nAlso: ${extras.map(rel).join(", ")}`);

  const verb = mode === "empty" ? "Emptying" : "Deleting";
  const rows = sum(infos.map((i) => i.rows));
  // The directory, spelled out, every time. `--all` and `--handoff` work on
  // the working directory, and the whole class of accident this guards against
  // is running one of them from a directory other than the intended one.
  console.log(`\nIn ${process.cwd()}`);
  console.log(
    `${verb} ${databases.length} database${databases.length === 1 ? "" : "s"}` +
      `${extras.length ? ` and ${extras.length} other file${extras.length === 1 ? "" : "s"}` : ""}` +
      ` — ${rows} row${rows === 1 ? "" : "s"}.`
  );

  if (dryRun) {
    console.log("--dry-run: nothing was changed.");
    return 0;
  }

  // A confirmation that has to be typed, not a y/n: this is not undoable, and
  // it is reached by a flag that is one character from --list.
  if (!flags.has("--yes")) {
    if (!process.stdin.isTTY) {
      console.log("Not a terminal, so nothing was done. Re-run with --yes if you meant it.");
      return 1;
    }
    const answer = await ask(`Type "clean" to confirm, in ${path.basename(process.cwd())}: `);
    if (answer !== "clean") {
      console.log("Nothing was changed.");
      return 1;
    }
  }

  const results = [
    ...databases.map((file) => clean(file, mode)),
    ...extras.map((file) => cleanFile(file)),
  ];

  for (const result of results) {
    if (result.error) {
      console.log(`FAILED  ${rel(result.file)}: ${result.error}`);
    } else if (result.mode === "empty") {
      console.log(`emptied ${rel(result.file).padEnd(26)}${result.rowsRemoved} rows, ${size(result.bytesFreed)} freed`);
    } else {
      console.log(
        `deleted ${rel(result.file).padEnd(26)}${size(result.bytesFreed)}` +
          `${result.removed.length > 1 ? ` (+${result.removed.length - 1} sidecar)` : ""}`
      );
    }
  }

  const failed = results.filter((r) => r.error).length;
  console.log(
    `\n${results.length - failed} of ${results.length} cleared, ` +
      `${size(sum(results.map((r) => r.bytesFreed)))} freed.`
  );
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
}
