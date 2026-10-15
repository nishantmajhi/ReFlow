"use strict";

// Two kinds of test that run against both copies of the parser in one run.
//
// regression(name, check): `check` must pass against the working tree and
// FAIL against the baseline commit. A regression test that also passes
// against the original was never testing the fix, and this makes that a
// failure rather than something to remember to check by hand.
//
// preserved(name, check): `check` must pass against both. These pin the
// output the tool already got right -- its own sample and the single-line
// exports it was built for -- so a fix elsewhere cannot quietly change it.
//
// And an oracle nobody here wrote: SQLite, through node:sqlite. A formatter
// may change whitespace and keyword case and nothing else, so running the
// input and the output through a real SQL engine and comparing everything
// observable afterwards catches any change of meaning, however it arises.

const test = require("node:test");
const assert = require("node:assert");
const { DatabaseSync } = require("node:sqlite");
const { loadParser, loadOriginal } = require("./harness.js");

function regression(name, check) {
  test(`regression: ${name}`, () => {
    check(loadParser());
    let failed = false;
    try {
      check(loadOriginal());
    } catch (err) {
      if (!(err instanceof assert.AssertionError)) throw err;
      failed = true;
    }
    assert.ok(failed, "this check passes against the original code too, so it is not testing the fix");
  });
}

function preserved(name, check) {
  test(`preserved: ${name}`, () => {
    check(loadParser());
    check(loadOriginal());
  });
}

// Everything a script can change in a fresh database: every table's columns
// and rows, in order, plus the rows of `query` if one is given. The SQL text
// SQLite stores for each table is deliberately not compared -- a formatter is
// supposed to change that.
function observe(sql, { setup = "", query = null } = {}) {
  const db = new DatabaseSync(":memory:");
  try {
    if (setup) db.exec(setup);
    let error = null;
    try {
      db.exec(sql);
    } catch (err) {
      error = err.message;
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => {
        const q = `"${name.replace(/"/g, '""')}"`;
        // SQLite keeps a column's declared type and default as the text they
        // were written in, which a formatter re-cases and re-spaces. Compare
        // the type without either, and the default by its value.
        const columns = db
          .prepare(`PRAGMA table_info(${q})`)
          .all()
          .map((c) => ({ ...c, type: c.type.replace(/\s+/g, "").toUpperCase(), dflt_value: valueOf(db, c.dflt_value) }));
        const rows = db.prepare(`SELECT * FROM ${q} ORDER BY rowid`).all().map((r) => ({ ...r }));
        return { name, columns, rows };
      });
    const result = query ? db.prepare(query).all().map((r) => ({ ...r })) : null;
    return { error, tables, result };
  } finally {
    db.close();
  }
}

function valueOf(db, expression) {
  if (expression === null) return null;
  try {
    return { value: db.prepare(`SELECT (${expression}) AS v`).get().v };
  } catch {
    return { text: expression };
  }
}

// One SELECT, compared on its column names as well as its values: `1e5`
// becoming `1 e5` still returns a row, but under the name `e5`.
function select(sql, setup = "") {
  const db = new DatabaseSync(":memory:");
  try {
    if (setup) db.exec(setup);
    const stmt = db.prepare(sql);
    return { columns: stmt.columns().map((c) => c.name), rows: stmt.all().map((r) => ({ ...r })) };
  } catch (err) {
    return { error: err.message };
  } finally {
    db.close();
  }
}

// The assertion the whole suite leans on: the formatted script does exactly
// what the input did. The input is checked first, so a test cannot pass
// because both sides fail the same way.
function assertSameEffect(api, sql, env = {}, options = {}) {
  const before = observe(sql, env);
  assert.strictEqual(before.error, null, `the test input itself is not valid SQLite: ${before.error}`);
  const formatted = api.formatSQL(sql, options);
  const after = observe(formatted, env);
  assert.deepStrictEqual(after, before, `formatting changed what this SQL does. Formatted:\n${formatted}`);
  return formatted;
}

function assertSameSelect(api, sql, setup = "", options = {}) {
  const before = select(sql, setup);
  assert.ok(!before.error, `the test input itself is not valid SQLite: ${before.error}`);
  const formatted = api.formatSQL(sql, options);
  const after = select(formatted, setup);
  assert.deepStrictEqual(after, before, `formatting changed what this query returns. Formatted:\n${formatted}`);
  return formatted;
}

module.exports = { regression, preserved, observe, select, assertSameEffect, assertSameSelect };
