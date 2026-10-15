"use strict";

// Tokens the tokenizer used to cut in two.
//
// The formatter puts a space between tokens, so a token read as two becomes
// two things in the output. Sometimes that is a syntax error. Sometimes it is
// worse and still runs: `1e5` became `1 e5`, which SQLite reads as the number
// 1 under the column name `e5`, and `0x1F` became `0 x1F`, which is 0.
//
// Every SQLite case here runs the input and the formatted output through a
// real engine and compares the column names as well as the values.

const assert = require("node:assert");
const { regression, preserved, assertSameSelect } = require("./helpers.js");

// ---- numbers ---------------------------------------------------------------

regression("a number with an exponent stays one number", (api) => {
  assertSameSelect(api, "SELECT 1e5, 2E+2, 1.5e-3;");
});

regression("a hexadecimal number stays one number", (api) => {
  assertSameSelect(api, "SELECT 0x1F, 0xff;");
});

regression("a number written without its leading zero stays one number", (api) => {
  assertSameSelect(api, "SELECT .5 AS half, 2 * .25 AS quarter;");
});

regression("a MySQL binary literal and an identifier that starts with a digit stay whole", (api) => {
  const out = api.formatSQL("SELECT 0b1010, 1st_place FROM results;");
  assert.match(out, /\b0b1010\b/);
  assert.match(out, /\b1st_place\b/);
});

preserved("a plain decimal is left alone", (api) => {
  assertSameSelect(api, "SELECT 40.00 AS fee, 3 AS n;");
});

// ---- identifiers outside ASCII ---------------------------------------------

regression("an identifier in another script is one word, so an alias stays an alias", (api) => {
  // The original read each Devanagari letter as punctuation and emitted it
  // with no space in front, gluing the alias onto the column before it.
  assertSameSelect(api, "SELECT a नाम FROM t;", "CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (7);");
});

regression("an accented column name is one word", (api) => {
  assertSameSelect(api, "SELECT prénom, é FROM t;", "CREATE TABLE t (prénom TEXT, é INTEGER); INSERT INTO t VALUES ('Zoë', 1);");
});

// ---- operators -------------------------------------------------------------

regression("the JSON arrows -> and ->> stay whole", (api) => {
  assertSameSelect(api, `SELECT '{"a":{"b":2}}' -> '$.a' AS j, '{"a":{"b":2}}' ->> '$.a.b' AS v;`);
});

regression("shifts and == stay whole", (api) => {
  assertSameSelect(api, "SELECT 1<<3 AS l, 16>>2 AS r, 1==1 AS e;");
});

regression("operators from other dialects stay whole", (api) => {
  const cases = {
    "SELECT a <=> b FROM t;": "a <=> b", // MySQL null-safe equals
    "SET @n := 1;": "@n := 1", // MySQL assignment
    "SELECT a FROM t WHERE tags @> '{x}';": "tags @> '{x}'", // PostgreSQL contains
    "SELECT doc #>> '{a,b}' FROM t;": "doc #>> '{a,b}'", // PostgreSQL JSON path
    "SELECT a FROM t WHERE name ~* 'x' OR name !~ 'y';": "name ~* 'x' OR name !~ 'y'",
    "SELECT a FROM t WHERE a !< 3;": "a !< 3", // SQL Server
  };
  for (const [input, expected] of Object.entries(cases)) {
    const out = api.formatSQL(input);
    assert.ok(out.includes(expected), `expected ${JSON.stringify(expected)} in:\n${out}`);
  }
});

preserved("the operators it already knew are unchanged", (api) => {
  assertSameSelect(api, "SELECT 1 >= 1 AS a, 1 <= 2 AS b, 1 <> 2 AS c, 1 != 2 AS d, 'a' || 'b' AS e;");
});

// ---- parameters ------------------------------------------------------------

regression("a named parameter stays attached to its colon", (api) => {
  // `:name` became `: name`, which no engine accepts.
  assertSameSelect(api, "SELECT :first AS a, :second_one AS b;");
  assert.ok(api.formatSQL("SELECT * FROM t WHERE id = :id;").includes("id = :id;"));
});

regression("a ? placeholder is spaced like any other value", (api) => {
  const out = api.formatSQL("SELECT * FROM t WHERE a = ? AND b IN (?, ?);");
  assert.ok(out.includes("WHERE a = ? AND b IN (?, ?);"), out);
});

preserved("a PostgreSQL cast is unchanged", (api) => {
  assert.ok(api.formatSQL("SELECT a::int FROM t;").includes("a :: INT"));
});
