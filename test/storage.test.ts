import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  toRows, sqliteStore, jsonlStore, csvStore, memoryStore, multiStore, customStore,
} from "../storage";

let dir: string;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-")); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name: string) => path.join(dir, name);

describe("toRows", () => {
  test("an object is one row", () => assert.deepEqual(toRows({ a: 1 }), [{ a: 1 }]));
  test("an array is one row each", () => assert.equal(toRows([{ a: 1 }, { a: 2 }]).length, 2));
  test("a scalar is wrapped", () => assert.deepEqual(toRows("hi"), [{ value: "hi" }]));
  test("nothing stores nothing", () => {
    assert.deepEqual(toRows(null), []);
    assert.deepEqual(toRows(undefined), []);
    assert.deepEqual(toRows([]), []);
  });
  test("nested arrays flatten", () => assert.equal(toRows([[{ a: 1 }], [{ a: 2 }]]).length, 2));
});

describe("sqliteStore", () => {
  test("creates the table and attaches metadata", async () => {
    const store = sqliteStore({ path: file("a.db"), table: "rows" });
    assert.equal(await store.save([{ title: "x" }], { mission: "m", profile: "desktop-chrome" }), 1);
    await store.close();

    const row = new DatabaseSync(file("a.db")).prepare("SELECT * FROM rows").get() as any;
    assert.equal(row.title, "x");
    assert.equal(row._mission, "m");
    assert.equal(row._profile, "desktop-chrome");
    assert.match(row._scraped_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("infers column types so numbers stay numbers", async () => {
    const store = sqliteStore({ path: file("b.db"), table: "t" });
    await store.save([{ count: 3, price: 1.5, name: "x" }]);
    await store.close();

    const db = new DatabaseSync(file("b.db"));
    const types = Object.fromEntries(
      (db.prepare("PRAGMA table_info(t)").all() as any[]).map((c) => [c.name, c.type])
    );
    assert.equal(types.count, "INTEGER");
    assert.equal(types.price, "REAL");
    assert.equal(types.name, "TEXT");
    // The regression this guards: an INTEGER read back as 1.0 sorts lexically.
    assert.equal((db.prepare("SELECT count FROM t").get() as any).count, 3);
  });

  test("objects and arrays are JSON encoded", async () => {
    const store = sqliteStore({ path: file("c.db"), table: "t" });
    await store.save([{ meta: { lang: "en" }, tags: ["a", "b"] }]);
    await store.close();
    const row = new DatabaseSync(file("c.db")).prepare("SELECT * FROM t").get() as any;
    assert.deepEqual(JSON.parse(row.meta), { lang: "en" });
    assert.deepEqual(JSON.parse(row.tags), ["a", "b"]);
  });

  test("widens the table when a later row brings a new field", async () => {
    const store = sqliteStore({ path: file("d.db"), table: "t" });
    await store.save([{ a: 1 }]);
    await store.save([{ a: 2, b: "late" }]);
    await store.close();
    const rows = new DatabaseSync(file("d.db")).prepare("SELECT * FROM t ORDER BY a").all() as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[1].b, "late");
    assert.equal(rows[0].b, null);
  });

  test("key makes re-runs update instead of duplicate", async () => {
    const store = sqliteStore({ path: file("e.db"), table: "t", key: (r) => String(r.url) });
    await store.save([{ url: "u1", title: "first" }, { url: "u2", title: "other" }]);
    await store.save([{ url: "u1", title: "second" }]);
    await store.close();
    const db = new DatabaseSync(file("e.db"));
    assert.equal((db.prepare("SELECT COUNT(*) c FROM t").get() as any).c, 2);
    assert.equal((db.prepare("SELECT title FROM t WHERE url='u1'").get() as any).title, "second");
  });

  test("without a key every run appends", async () => {
    const store = sqliteStore({ path: file("f.db"), table: "t" });
    await store.save([{ url: "u1" }]);
    await store.save([{ url: "u1" }]);
    await store.close();
    assert.equal((new DatabaseSync(file("f.db")).prepare("SELECT COUNT(*) c FROM t").get() as any).c, 2);
  });

  test("reopening an existing table keeps writing to it", async () => {
    const open = () => sqliteStore({ path: file("g.db"), table: "t" });
    const first = open(); await first.save([{ a: 1 }]); await first.close();
    const second = open(); await second.save([{ a: 2 }]); await second.close();
    assert.equal((new DatabaseSync(file("g.db")).prepare("SELECT COUNT(*) c FROM t").get() as any).c, 2);
  });

  test("saving nothing is a no-op", async () => {
    const store = sqliteStore({ path: ":memory:" });
    assert.equal(await store.save([]), 0);
    await store.close();
  });

  test("creates missing directories", async () => {
    const store = sqliteStore({ path: file("nested/deep/h.db"), table: "t" });
    await store.save([{ a: 1 }]);
    await store.close();
    assert.ok(fs.existsSync(file("nested/deep/h.db")));
  });
});

describe("jsonlStore", () => {
  test("writes one object per line and appends", async () => {
    const store = jsonlStore(file("a.jsonl"));
    await store.save([{ a: 1 }, { a: 2 }]);
    await store.save([{ a: 3 }]);
    await store.close();
    const lines = fs.readFileSync(file("a.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).a, 3);
    assert.ok(JSON.parse(lines[0])._scraped_at);
  });
});

describe("csvStore", () => {
  test("writes a header once and quotes embedded commas and quotes", async () => {
    const store = csvStore(file("a.csv"));
    await store.save([{ name: 'He said "hi", loudly', n: 1 }]);
    await store.save([{ name: "plain", n: 2 }]);
    await store.close();
    const lines = fs.readFileSync(file("a.csv"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("name,n,"));
    assert.match(lines[1], /"He said ""hi"", loudly"/);
  });

  test("explicit columns fix the shape for later rows", async () => {
    const store = csvStore(file("b.csv"), ["a", "b"]);
    await store.save([{ a: 1 }]);
    await store.save([{ a: 2, b: 3 }]);
    await store.close();
    const lines = fs.readFileSync(file("b.csv"), "utf8").trim().split("\n");
    assert.ok(lines[0].startsWith("a,b,"));
    assert.ok(lines[1].startsWith("1,,"));
    assert.ok(lines[2].startsWith("2,3,"));
  });
});

describe("composition", () => {
  test("memoryStore keeps rows with metadata", async () => {
    const store = memoryStore();
    await store.save([{ a: 1 }], { mission: "m" });
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]._mission, "m");
  });

  test("multiStore fans out to every store", async () => {
    const a = memoryStore(), b = memoryStore();
    const store = multiStore(a, b);
    assert.equal(await store.save([{ x: 1 }, { x: 2 }]), 2);
    await store.close();
    assert.equal(a.rows.length, 2);
    assert.equal(b.rows.length, 2);
  });

  test("customStore receives rows with metadata attached", async () => {
    const seen: any[] = [];
    let closed = false;
    const store = customStore("test", async (rows) => { seen.push(...rows); return rows.length; }, async () => { closed = true; });
    await store.save([{ a: 1 }], { profile: "desktop-chrome" });
    await store.close();
    assert.equal(seen[0]._profile, "desktop-chrome");
    assert.ok(closed);
  });
});
