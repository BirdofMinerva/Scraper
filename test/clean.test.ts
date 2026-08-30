/**
 * The database cleaner.
 *
 * Everything destructive here runs against databases built in a temporary
 * directory, because a test that reaches for the project's own files is one
 * bad path away from being the thing it is meant to prevent.
 */
import { test, describe as suite, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  clean,
  cleanFile,
  describe,
  discover,
  discoverExtras,
  report,
  sidecarsFor,
} from "../clean";

let dir: string;

/** A database with `rows` rows, in WAL mode as `storage.ts` writes them. */
function makeDb(name: string, rows = 3, columns = "name TEXT, price TEXT"): string {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE items (_id INTEGER PRIMARY KEY AUTOINCREMENT, ${columns})`);
  const insert = db.prepare(`INSERT INTO items (${columns.split(",")[0].trim().split(" ")[0]}) VALUES (?)`);
  for (let i = 0; i < rows; i++) insert.run(`row ${i}`);
  db.close();
  return file;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-test-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { force: true });
});

suite("finding things", () => {
  test("only databases, and never their sidecars", () => {
    makeDb("a.db");
    fs.writeFileSync(path.join(dir, "a.db-wal"), "");
    fs.writeFileSync(path.join(dir, "notes.txt"), "");

    // A -wal listed as a database would be "cleaned" by deleting half a
    // database and leaving the rest.
    assert.deepEqual(discover(dir).map((f) => path.basename(f)), ["a.db"]);
  });

  test("sidecars are found for the database they belong to", () => {
    const file = makeDb("a.db");
    fs.writeFileSync(file + "-shm", "");
    assert.deepEqual(sidecarsFor(file).map((f) => path.basename(f)), ["a.db-shm"]);
  });

  test("a handoff also sweeps exports and the proxy list", () => {
    fs.writeFileSync(path.join(dir, "out.jsonl"), "");
    fs.writeFileSync(path.join(dir, "proxies.txt"), "home=http://user:pass@host:8080");
    fs.writeFileSync(path.join(dir, "README.md"), "");

    // proxies.txt is in the sweep because a route line carries a proxy's
    // username and password in a file whose name suggests nothing of the sort.
    assert.deepEqual(discoverExtras(dir).map((f) => path.basename(f)), ["out.jsonl", "proxies.txt"]);
  });
});

suite("reading a database", () => {
  test("tables and row counts come back", () => {
    const info = describe(makeDb("a.db", 5));
    assert.deepEqual(info.tables, [{ name: "items", rows: 5 }]);
    assert.equal(info.rows, 5);
    assert.ok(info.bytes > 0);
  });

  test("listing creates nothing beside the file", () => {
    // Opening a WAL database read-only writes -wal and -shm, so a plain
    // listing would add two files per database and then report them as
    // "+2 sidecar" - a listing that changes what it is listing.
    const file = makeDb("a.db");
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });

    describe(file);
    assert.equal(fs.existsSync(file + "-wal"), false);
    assert.equal(fs.existsSync(file + "-shm"), false);
  });

  test("a password column is called out; a cookies column is not", () => {
    const withPasswords = describe(makeDb("book.db", 1, "email TEXT, password TEXT"));
    const withCookies = describe(makeDb("probe.db", 1, "url TEXT, cookies TEXT"));

    assert.equal(withPasswords.credentials, true);
    assert.equal(withCookies.credentials, false, "cookie names are not credentials");
    // Kept apart so the warning that matters is not spent on the file that
    // records which cookie names a site set.
    assert.equal(withCookies.session, true);
  });

  test("something that is not a database is reported, not thrown", () => {
    const file = path.join(dir, "junk.db");
    fs.writeFileSync(file, "definitely not sqlite");
    const info = describe(file);
    assert.ok(info.error);
    assert.deepEqual(info.tables, []);
  });

  test("the report says which file holds passwords", () => {
    const text = report([describe(makeDb("book.db", 1, "email TEXT, password TEXT"))]);
    assert.match(text, /PASSWORDS/);
    assert.match(text, /plain text/);
  });
});

suite("deleting", () => {
  test("the database and its sidecars go together", () => {
    const file = makeDb("a.db", 4);
    fs.writeFileSync(file + "-wal", "x");
    fs.writeFileSync(file + "-shm", "x");

    const result = clean(file);
    assert.equal(result.mode, "delete");
    assert.equal(result.rowsRemoved, 4);
    assert.equal(result.removed.length, 3, "a sidecar was left behind");
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(file + "-wal"), false);
  });

  test("a missing file is a result, not an exception", () => {
    const result = clean(path.join(dir, "never-existed.db"));
    assert.equal(result.error, "no such file");
    assert.equal(result.removed.length, 0);
  });

  test("a plain file can be cleared too", () => {
    const file = path.join(dir, "out.jsonl");
    fs.writeFileSync(file, "{}\n");
    assert.equal(cleanFile(file).bytesFreed, 3);
    assert.equal(fs.existsSync(file), false);
  });
});

suite("emptying", () => {
  test("the file stays, the schema stays, the rows go", () => {
    // For a database something else is pointed at: deleting the file leaves a
    // store writing to an inode nobody can read.
    const file = makeDb("a.db", 50);
    const result = clean(file, "empty");

    assert.equal(result.mode, "empty");
    assert.equal(result.rowsRemoved, 50);
    assert.equal(fs.existsSync(file), true);

    const after = describe(file);
    assert.deepEqual(after.tables, [{ name: "items", rows: 0 }]);
  });

  test("the autoincrement counter is reset", () => {
    const file = makeDb("a.db", 20);
    clean(file, "empty");

    const db = new DatabaseSync(file);
    db.exec("INSERT INTO items (name) VALUES ('first after cleaning')");
    const row = db.prepare("SELECT _id FROM items").get() as { _id: number };
    db.close();

    // Without resetting sqlite_sequence the next row is _id 21, and the
    // numbering still tells whoever gets this project how much was here.
    assert.equal(row._id, 1);
  });

  test("the file actually shrinks", () => {
    const file = makeDb("a.db", 2000);
    const before = fs.statSync(file).size;
    const result = clean(file, "empty");

    // Without the VACUUM the pages stay allocated and the file looks
    // untouched, which is the same as not having cleaned it as far as anyone
    // looking at the directory can tell.
    assert.ok(fs.statSync(file).size < before, "the file did not shrink");
    assert.ok(result.bytesFreed > 0);
  });

  test("emptying something that is not a database fails cleanly", () => {
    const file = path.join(dir, "junk.db");
    fs.writeFileSync(file, "not sqlite");
    const result = clean(file, "empty");

    assert.ok(result.error);
    assert.equal(fs.existsSync(file), true, "a file it could not read was deleted anyway");
  });
});
