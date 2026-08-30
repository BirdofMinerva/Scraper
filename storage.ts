/**
 * Somewhere to put what the missions bring back.
 *
 * A store takes rows and writes them. SQLite is the default because it ships
 * with Node - no dependency, no server, one file you can query:
 *
 *   const store = sqliteStore({ path: "data.db", table: "products" });
 *   await runMission(mission, { runs: 50, store });
 *   await store.close();
 *
 * Rows are written as each run finishes, so a long crawl is never holding its
 * results in memory, and an interrupted one keeps what it already had.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Row = Record<string, unknown>;

/** What the runner knows about the run that produced a row. */
export type SaveMeta = {
  mission?: string;
  profile?: string;
  proxy?: string;
  target?: string;
  attempts?: number;
  durationMs?: number;
};

export type Store = {
  name: string;
  /** Returns how many rows were written. */
  save: (rows: Row[], meta?: SaveMeta) => Promise<number>;
  close: () => Promise<void>;
};

/**
 * Whatever a mission returned, as rows.
 *
 * An array becomes many rows, an object becomes one, and a bare string or
 * number becomes `{ value }` so a mission that just returns a title still
 * stores cleanly.
 */
export function toRows(value: unknown): Row[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(toRows);
  if (typeof value === "object") return [value as Row];
  return [{ value }];
}

const META_COLUMNS = [
  "_mission",
  "_profile",
  "_proxy",
  "_target",
  "_attempts",
  "_duration_ms",
  "_scraped_at",
] as const;

function withMeta(row: Row, meta: SaveMeta = {}): Row {
  return {
    ...row,
    _mission: meta.mission ?? null,
    _profile: meta.profile ?? null,
    _proxy: meta.proxy ?? null,
    _target: meta.target ?? null,
    _attempts: meta.attempts ?? null,
    _duration_ms: meta.durationMs ?? null,
    _scraped_at: new Date().toISOString(),
  };
}

/** Values a database column can hold; everything else becomes JSON. */
function toCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function ensureDir(file: string) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export type SqliteOptions = {
  /** File to write. `:memory:` works for tests. */
  path: string;
  /** Table name. Created on first write if missing. Default "scraped". */
  table?: string;
  /**
   * Makes a row's identity. Rows with a key already in the table replace the
   * older one, so re-running a crawl updates rather than duplicates.
   */
  key?: (row: Row) => string;
};

/**
 * SQLite via Node's built-in driver.
 *
 * The table is created from the first batch of rows and widened automatically
 * if later rows carry new fields - scraped shapes drift, and a crawl that dies
 * on an unexpected field three hours in is worse than a sparse column.
 */
export function sqliteStore(options: SqliteOptions): Store {
  const { path: file, table = "scraped", key } = options;
  if (file !== ":memory:") ensureDir(file);

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  let columns: Set<string> | undefined;

  /**
   * Column affinity from the first non-null value seen.
   *
   * Worth the trouble: a count landing in a TEXT column comes back as `1.0`
   * and sorts lexically, so `ORDER BY price` on a scraped table would be
   * quietly wrong.
   */
  const inferType = (name: string, rows: Row[]) => {
    for (const row of rows) {
      const value = row[name];
      if (value === null || value === undefined) continue;
      if (typeof value === "boolean") return "INTEGER";
      if (typeof value === "number") {
        return Number.isInteger(value) ? "INTEGER" : "REAL";
      }
      return "TEXT";
    }
    return "TEXT";
  };

  const loadColumns = () => {
    const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as {
      name: string;
    }[];
    return new Set(rows.map((r) => r.name));
  };

  const create = (names: string[], rows: Row[]) => {
    const defs = [
      key ? `_key TEXT PRIMARY KEY` : `_id INTEGER PRIMARY KEY AUTOINCREMENT`,
      ...names.map((name) => `${quote(name)} ${inferType(name, rows)}`),
    ];
    db.exec(`CREATE TABLE IF NOT EXISTS ${quote(table)} (${defs.join(", ")})`);
    columns = loadColumns();
  };

  return {
    name: `sqlite:${file}#${table}`,

    async save(rows, meta) {
      if (rows.length === 0) return 0;
      const prepared = rows.map((row) => withMeta(row, meta));
      const names = [...new Set(prepared.flatMap((row) => Object.keys(row)))];

      if (!columns) {
        columns = loadColumns();
        if (columns.size === 0) create(names, prepared);
      }
      // Widen the table rather than dropping fields that appeared later.
      for (const name of names) {
        if (!columns.has(name)) {
          db.exec(
            `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(name)} ${inferType(name, prepared)}`
          );
          columns.add(name);
        }
      }

      const insertColumns = key ? ["_key", ...names] : names;
      const statement = db.prepare(
        `INSERT OR REPLACE INTO ${quote(table)} (${insertColumns
          .map(quote)
          .join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`
      );

      const write = db.prepare("BEGIN");
      write.run();
      try {
        for (const row of prepared) {
          const values = names.map((name) => toCell(row[name]));
          statement.run(...(key ? [key(row), ...values] : values));
        }
        db.prepare("COMMIT").run();
      } catch (error) {
        db.prepare("ROLLBACK").run();
        throw error;
      }
      return prepared.length;
    },

    async close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** One JSON object per line - append-only, and safe to tail while running. */
export function jsonlStore(file: string): Store {
  ensureDir(file);
  const handle = fs.createWriteStream(file, { flags: "a" });

  return {
    name: `jsonl:${file}`,
    async save(rows, meta) {
      if (rows.length === 0) return 0;
      const text = rows.map((row) => JSON.stringify(withMeta(row, meta))).join("\n");
      await new Promise<void>((resolve, reject) =>
        handle.write(text + "\n", (error) => (error ? reject(error) : resolve()))
      );
      return rows.length;
    },
    close: () =>
      new Promise<void>((resolve) => handle.end(() => resolve())),
  };
}

/**
 * CSV, with the header written from the first row.
 *
 * Later rows are fitted to that header, so pass `columns` if the first result
 * might not carry every field.
 */
export function csvStore(file: string, columns?: string[]): Store {
  ensureDir(file);
  const handle = fs.createWriteStream(file, { flags: "a" });
  let header: string[] | undefined =
    columns && [...columns, ...META_COLUMNS];
  let headerWritten = false;

  const escape = (value: unknown) => {
    const cell = toCell(value);
    if (cell === null) return "";
    const text = String(cell);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const write = (line: string) =>
    new Promise<void>((resolve, reject) =>
      handle.write(line + "\n", (error) => (error ? reject(error) : resolve()))
    );

  return {
    name: `csv:${file}`,
    async save(rows, meta) {
      if (rows.length === 0) return 0;
      const prepared = rows.map((row) => withMeta(row, meta));

      if (!header) {
        header = [...new Set(prepared.flatMap((row) => Object.keys(row)))];
      }
      // A missing file stats as undefined, not 0 - treat both as "new", or the
      // header is silently dropped and the CSV has no column names at all.
      if (!headerWritten) {
        headerWritten = true;
        const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (size === 0) await write(header.join(","));
      }
      for (const row of prepared) {
        await write(header.map((name) => escape(row[name])).join(","));
      }
      return prepared.length;
    },
    close: () => new Promise<void>((resolve) => handle.end(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Composition and custom targets
// ---------------------------------------------------------------------------

/** Keeps rows in an array. Useful in tests, and for small runs. */
export function memoryStore(): Store & { rows: Row[] } {
  const rows: Row[] = [];
  return {
    name: "memory",
    rows,
    async save(batch, meta) {
      rows.push(...batch.map((row) => withMeta(row, meta)));
      return batch.length;
    },
    async close() {},
  };
}

/** Write to several stores at once, e.g. SQLite plus a JSONL backup. */
export function multiStore(...stores: Store[]): Store {
  return {
    name: `multi(${stores.map((s) => s.name).join(", ")})`,
    async save(rows, meta) {
      const counts = await Promise.all(stores.map((s) => s.save(rows, meta)));
      return Math.max(0, ...counts);
    },
    async close() {
      await Promise.all(stores.map((s) => s.close()));
    },
  };
}

/**
 * Any other destination - Postgres, an HTTP endpoint, S3.
 *
 *   const pg = new Client(); await pg.connect();
 *   const store = customStore("postgres", async (rows) => {
 *     for (const row of rows) await pg.query("INSERT INTO t (data) VALUES ($1)", [row]);
 *     return rows.length;
 *   }, () => pg.end());
 */
export function customStore(
  name: string,
  save: (rows: Row[], meta?: SaveMeta) => Promise<number>,
  close: () => Promise<void> = async () => {}
): Store {
  return { name, save: (rows, meta) => save(rows.map((r) => withMeta(r, meta))), close };
}
