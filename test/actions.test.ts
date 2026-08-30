/**
 * Action lists, before any of them reach a browser.
 *
 * These arrive from a web form, so the interesting cases are all the shapes a
 * half-filled form produces: a click with no selector, a wait with neither a
 * time nor a target, a step whose `do` is a typo. Each should be a sentence in
 * the form rather than an exception inside a browser two minutes later.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseActions, describeAction, shotName, ACTION_KINDS, type Action } from "../actions";
import { ConfigError } from "../errors";

describe("parsing what the form sends", () => {
  test("a full list survives the round trip", () => {
    const actions = parseActions([
      { do: "visit", url: "https://site.example/app" },
      { do: "click", selector: "#buy" },
      { do: "type", selector: "#q", text: "hello" },
      { do: "scroll", steps: 4 },
      { do: "wait", ms: 500 },
      { do: "read", name: "price", selector: ".price" },
      { do: "shot", label: "cart" },
    ]);

    assert.equal(actions.length, 7);
    assert.deepEqual(actions.map((a) => a.do), ACTION_KINDS);
  });

  test("nothing at all is an empty list, not an error", () => {
    // Most bot runs have no action list; that is not a broken config.
    assert.deepEqual(parseActions(undefined), []);
    assert.deepEqual(parseActions(null), []);
    assert.deepEqual(parseActions([]), []);
  });

  test("a step that is not something a browser can do is refused", () => {
    assert.throws(() => parseActions([{ do: "hack" }]), /step 1: "hack" is not something/);
    assert.throws(() => parseActions([{}]), /step 1: "nothing" is not something/);
  });

  test("the step number is in the message", () => {
    // Three steps down a list, "needs a selector" on its own is not enough to
    // find which row of the table is wrong.
    assert.throws(
      () => parseActions([{ do: "scroll" }, { do: "shot" }, { do: "click", selector: "  " }]),
      /step 3: click needs a selector/
    );
  });

  test("a visit needs a real URL", () => {
    assert.throws(() => parseActions([{ do: "visit" }]), /needs a URL/);
    assert.throws(() => parseActions([{ do: "visit", url: "site.example" }]), /is not a URL/);
  });

  test("a wait needs either a selector or a duration", () => {
    assert.throws(() => parseActions([{ do: "wait" }]), /a selector or a number of milliseconds/);
    assert.equal(parseActions([{ do: "wait", ms: 250 }])[0].do, "wait");
    assert.equal((parseActions([{ do: "wait", selector: "#done" }])[0] as any).selector, "#done");
  });

  test("a read needs somewhere to put the value", () => {
    assert.throws(() => parseActions([{ do: "read", selector: ".price" }]), /needs a name/);
  });

  test("blank optional fields become undefined, not empty strings", () => {
    // An empty selector on a read means "the whole page", and "" would be a
    // selector that matches nothing.
    const [read] = parseActions([{ do: "read", name: "body", selector: "  ", attribute: "" }]) as any[];
    assert.equal(read.selector, undefined);
    assert.equal(read.attribute, undefined);
  });

  test("nonsense numbers are dropped rather than passed on", () => {
    const [scroll] = parseActions([{ do: "scroll", steps: -3 }]) as any[];
    const [wait] = parseActions([{ do: "wait", selector: "#x", ms: "soon" }]) as any[];
    assert.equal(scroll.steps, undefined);
    assert.equal(wait.ms, undefined);
  });

  test("optional is carried through, because it changes what a failure means", () => {
    const [step] = parseActions([{ do: "click", selector: "#maybe", optional: true }]);
    assert.equal(step.optional, true);
  });

  test("something that is not a list is refused", () => {
    assert.throws(() => parseActions({ do: "click" }), /must be a list/);
  });
});

describe("describing a step", () => {
  test("each kind reads as a sentence", () => {
    const lines = (ACTION_KINDS.map((kind) => {
      const sample: Record<string, Action> = {
        visit: { do: "visit", url: "https://x.example/a" },
        click: { do: "click", selector: "#buy" },
        type: { do: "type", selector: "#q", text: "hello" },
        scroll: { do: "scroll", steps: 2 },
        wait: { do: "wait", ms: 300 },
        read: { do: "read", name: "price", selector: ".p" },
        shot: { do: "shot", label: "cart" },
      };
      return describeAction(sample[kind]);
    }));

    assert.deepEqual(lines, [
      "visit https://x.example/a",
      "click #buy",
      "type 5 characters into #q",
      "scroll 2",
      "wait 300ms",
      "read price from .p",
      'screenshot "cart"',
    ]);
  });

  test("typed text is counted, never printed", () => {
    // These lists are echoed into the terminal panel and the run log. They
    // carry search terms, messages, and sometimes a password typed into the
    // wrong row of the form.
    const line = describeAction({ do: "type", selector: "#password", text: "hunter2-hunter2" });
    assert.doesNotMatch(line, /hunter2/);
    assert.match(line, /15 characters/);
  });
});

describe("screenshot filenames", () => {
  test("the profile and step number are in the name", () => {
    assert.equal(shotName("desktop-chrome", 3, "cart"), "desktop-chrome-03-cart.png");
  });

  test("a label cannot escape the directory or surprise the filesystem", () => {
    // The label comes from a text box, and the result is a path.
    const name = shotName("desktop-chrome", 1, "../../etc/passwd");
    assert.doesNotMatch(name, /[/\\]/);
    assert.doesNotMatch(name, /\.\./);
    assert.match(name, /\.png$/);
  });

  test("an empty prefix still produces a usable name", () => {
    assert.equal(shotName("", 7), "browser-07.png");
  });

  test("numbers sort as text, so they are padded", () => {
    // Ten screenshots listed alphabetically otherwise put 10 before 2.
    assert.match(shotName("p", 2), /-02\./);
    assert.match(shotName("p", 10), /-10\./);
  });
});

describe("typed errors", () => {
  test("a broken action list is a ConfigError, message unchanged", () => {
    assert.throws(() => parseActions([{ do: "dance" }]), ConfigError);
    assert.throws(() => parseActions([{ do: "dance" }]), /not something a browser can do/);
    assert.throws(() => parseActions("nope"), ConfigError);
  });
});
