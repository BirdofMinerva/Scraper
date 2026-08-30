import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TARGETS, selectTargets, filterFromArgs } from "../targets";

describe("catalog", () => {
  test("names are unique and usable as keys", () => {
    const names = TARGETS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.match(name, /^[a-z0-9-]+$/);
  });

  test("every url is absolute and https", () => {
    for (const t of TARGETS) assert.match(t.url, /^https:\/\//, t.name);
  });

  test("it covers every vendor worth debugging against", () => {
    const vendors = new Set(TARGETS.map((t) => t.vendor));
    for (const v of ["cloudflare", "datadome", "perimeterx", "kasada", "akamai", "imperva"]) {
      assert.ok(vendors.has(v as any), `no target runs ${v}`);
    }
  });

  test("controls exist and claim no protection", () => {
    const controls = TARGETS.filter((t) => t.category === "control");
    assert.ok(controls.length >= 3);
    assert.ok(controls.every((t) => t.vendor === "none" && t.difficulty === "easy"));
  });
});

describe("selectTargets", () => {
  test("filters by vendor", () => {
    const chosen = selectTargets({ vendor: "kasada", withControl: false });
    assert.ok(chosen.length >= 2);
    assert.ok(chosen.every((t) => t.vendor === "kasada"));
  });

  test("filters by category and difficulty together", () => {
    const chosen = selectTargets({ category: "retail", difficulty: "hard", withControl: false });
    assert.ok(chosen.every((t) => t.category === "retail" && t.difficulty === "hard"));
  });

  test("accepts lists", () => {
    const chosen = selectTargets({ vendor: ["kasada", "imperva"], withControl: false });
    assert.ok(chosen.every((t) => t.vendor === "kasada" || t.vendor === "imperva"));
  });

  test("names select exactly, ignoring other filters", () => {
    const chosen = selectTargets({ names: ["g2", "zillow"], withControl: false });
    assert.deepEqual(chosen.map((t) => t.name), ["g2", "zillow"]);
  });

  test("an unknown name throws and lists what exists", () => {
    assert.throws(() => selectTargets({ names: ["g2", "gtwo"] }), /Unknown target\(s\): gtwo/);
  });

  test("a control is prepended so a broken setup is obvious", () => {
    // Without one, "the site blocked us" and "the tunnel is down" look the same.
    const chosen = selectTargets({ vendor: "datadome" });
    assert.equal(chosen[0].category, "control");
  });

  test("an existing control is not duplicated", () => {
    const chosen = selectTargets({ category: "control" });
    assert.equal(chosen.filter((t) => t.name === "example").length, 1);
  });

  test("withControl false leaves it out", () => {
    assert.ok(!selectTargets({ vendor: "akamai", withControl: false }).some((t) => t.category === "control"));
  });

  test("limit applies before the control is added", () => {
    const chosen = selectTargets({ vendor: "datadome", limit: 2 });
    assert.equal(chosen.length, 3, "two targets plus the control");
  });

  test("a filter matching nothing throws rather than probing everything", () => {
    assert.throws(() => selectTargets({ vendor: "kasada", category: "control" }), /No targets match/);
  });

  test("no filter returns the whole catalog", () => {
    assert.equal(selectTargets().length, TARGETS.length);
  });
});

describe("filterFromArgs", () => {
  test("parses each flag", () => {
    const filter = filterFromArgs(["--vendor=datadome,akamai", "--category=retail", "--limit=3"]);
    assert.deepEqual(filter.vendor, ["datadome", "akamai"]);
    assert.deepEqual(filter.category, ["retail"]);
    assert.equal(filter.limit, 3);
  });

  test("--targets selects by name", () => {
    assert.deepEqual(filterFromArgs(["--targets=g2,zillow"]).names, ["g2", "zillow"]);
  });

  test("--no-control turns the control off", () => {
    assert.equal(filterFromArgs([]).withControl, true);
    assert.equal(filterFromArgs(["--no-control"]).withControl, false);
  });

  test("absent flags stay undefined rather than filtering to nothing", () => {
    const filter = filterFromArgs([]);
    assert.equal(filter.vendor, undefined);
    assert.equal(filter.names, undefined);
    assert.equal(selectTargets(filter).length, TARGETS.length);
  });
});
