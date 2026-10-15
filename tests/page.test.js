"use strict";

// The page: js/parser.js and js/script.js, run the way index.html runs them.
//
// Both are classic scripts sharing one global scope, so they are loaded into
// a single node:vm context in the order the page lists them. A top-level
// name declared in both would be a SyntaxError that stops the page loading;
// separate require()s could never show that.
//
// The DOM is the handful of elements script.js looks up by id. What matters
// is what reaches the user: the highlighted HTML in the output pane, and the
// text a browser would read back out of it, which is what Copy copies.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, loadParser } = require("./harness.js");

function element(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fire: (type, event = {}) => listeners[type](event),
  };
}

function loadPage() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ["js/parser.js", "js/script.js"], "index.html loads different scripts now");

  const elements = {};
  const clipboard = [];
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => (elements[id] ||= element(id)),
      querySelectorAll: () => [],
    },
    navigator: { clipboard: { writeText: async (text) => clipboard.push(text) } },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  for (const file of scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx, { filename: file });
  }
  return { ctx, el: (id) => elements[id], clipboard, get: (name) => vm.runInContext(name, ctx) };
}

// What a browser's textContent gives back for the output pane's innerHTML.
const textOf = (html) =>
  html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function type(page, sql) {
  page.el("input").value = sql;
  page.get("runFormat")();
}

test("the page loads both scripts into one scope and formats its sample on start", () => {
  const page = loadPage();
  const sample = page.get("SAMPLE_DDL");
  assert.strictEqual(textOf(page.el("output").innerHTML), loadParser().formatSQL(sample));
  assert.match(page.el("afterMeta").innerHTML, /^<b>\d+<\/b> lines$/);
});

test("the highlighted output reads back as exactly the formatted SQL", () => {
  const page = loadPage();
  const inputs = [
    "select a, b from t where c < 1 and d > 2 and e = '<script>alert(1)</script> & more';",
    "-- a comment <b>not bold</b>\nselect 1;",
    "insert into t values (1,'O\\'Connor'),(2,'x');",
    "select $$a  <b>  c$$, 1e5, x'41', t.* from t;",
  ];
  for (const sql of inputs) {
    type(page, sql);
    const html = page.el("output").innerHTML;
    assert.strictEqual(textOf(html), loadParser().formatSQL(sql));
    assert.ok(!/<(?!\/?span[ >])/.test(html), `markup from the input reached the page: ${html}`);
  }
});

test("strings, comments, numbers and keywords are each highlighted", () => {
  const page = loadPage();
  type(page, "-- note\nselect 'x', 42 from t;");
  const html = page.el("output").innerHTML;
  assert.ok(html.includes('<span class="com">-- note</span>'), html);
  assert.ok(html.includes('<span class="kw">SELECT</span>'), html);
  assert.ok(html.includes("<span class=\"str\">'x'</span>"), html);
  assert.ok(html.includes('<span class="num">42</span>'), html);
});

test("Copy copies the text of the output pane", async () => {
  const page = loadPage();
  type(page, "select 1;");
  // A browser keeps textContent in step with innerHTML; the stub does not.
  page.el("output").textContent = textOf(page.el("output").innerHTML);
  page.el("copyBtn").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(page.clipboard, ["SELECT\n    1;\n"]);
});

test("the explanation panel never quotes the input", () => {
  // The review asked whether showAnatomy could put the user's SQL into
  // innerHTML. It cannot: it chooses between three fixed messages. This
  // pins that, with input that would run if it were ever interpolated.
  const page = loadPage();
  const hostile = "<img src=x onerror=alert(1)>";
  const inputs = [
    `insert into t values ('${hostile}'), ${"(1), ".repeat(60)}(2);`,
    `create table t (a int); -- ${hostile} ${"x ".repeat(200)}`,
    `select '${hostile}' ${", a".repeat(150)} from t;`,
  ];
  const messages = new Set();
  for (const sql of inputs) {
    type(page, sql);
    assert.ok(page.el("anatomy").classList.contains("show"), "the panel should appear for long single-line input");
    const body = page.el("anatomyBody").innerHTML;
    assert.ok(!body.includes("onerror"), body);
    messages.add(body);
  }
  assert.strictEqual(messages.size, 3, "each branch of showAnatomy was reached");
});

test("empty input clears the output", () => {
  const page = loadPage();
  type(page, "   \n  ");
  assert.strictEqual(page.el("output").innerHTML, "");
  assert.strictEqual(page.el("afterMeta").textContent, "0 lines");
});
