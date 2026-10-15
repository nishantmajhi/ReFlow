"use strict";

// Where a `--` comment ends.
//
// In SQL a `--` comment runs to the end of its line. Reflow's reason to exist
// is SQL that has lost its line breaks, where a comment runs straight into the
// statement after it -- so on such input it has to guess where each comment
// was meant to stop, and it does: at a `;`, or before a word that looks like
// the start of a statement. That guess is only needed when there is no line
// break to go on. Applied to ordinary SQL it cut real comments short and
// turned the rest of each one into code.

const assert = require("node:assert");
const { regression, preserved, assertSameEffect, assertSameSelect } = require("./helpers.js");

const PEOPLE = "CREATE TABLE t (id INTEGER, created TEXT); INSERT INTO t VALUES (1, '2019'), (2, '2019'), (3, '2024');";

regression("a semicolon inside a comment does not end the statement: DELETE keeps its WHERE", (api) => {
  // The original ended the comment at `;`, so the DELETE ended there too, with
  // no WHERE -- and the rest of the comment became a statement that errors
  // only after every row is gone.
  assertSameEffect(api, "DELETE FROM t -- careful; only old rows\nWHERE created < '2020';", { setup: PEOPLE });
});

regression("a statement keyword inside a comment stays in the comment", (api) => {
  const out = assertSameEffect(api, "-- Create the users table\nCREATE TABLE users (id INTEGER);");
  assert.ok(out.startsWith("-- Create the users table\n"), out);
});

regression("a comment at the end of a clause does not split the query", (api) => {
  assertSameSelect(api, "SELECT id, created\nFROM t -- pick rows; not all\nWHERE id = 1;", PEOPLE);
});

regression("a statement written inside a comment on the last line is not run", (api) => {
  // Two lines, so this is ordinary SQL: everything after `--` is a comment.
  assertSameEffect(api, "SELECT 1;\nSELECT 2; -- when finished: DROP TABLE t;", { setup: PEOPLE });
});

regression("a comment that mentions SELECT keeps its text on one line", (api) => {
  const lines = api.formatSQL("-- select the newest rows first\nSELECT id FROM t ORDER BY id DESC;").split("\n");
  assert.strictEqual(lines[0], "-- select the newest rows first");
  assert.deepStrictEqual(lines.filter((l) => /select/i.test(l)), ["-- select the newest rows first", "SELECT"]);
});

regression("line endings from Windows are line endings too", (api) => {
  assertSameEffect(api, "DELETE FROM t -- careful; only old rows\r\nWHERE created < '2020';\r\n", { setup: PEOPLE });
});

// On a single line the guess is the feature, and it stays exactly as it was.

preserved("on one line, a comment still stops before the statement that follows it", (api) => {
  assert.strictEqual(
    api.formatSQL("-- header create table t (a int); -- seed it insert into t values (1);"),
    "-- header\nCREATE TABLE t (\n    a INT\n);\n\n-- seed it\nINSERT INTO t\nVALUES\n    (1);\n",
  );
});

preserved("on one line, a comment still stops at a semicolon", (api) => {
  assert.strictEqual(api.formatSQL("select 1 -- one ; select 2;"), "SELECT\n    1\n    -- one\n    ;\n\nSELECT\n    2;\n");
});

preserved("a single line with a trailing newline is still a single line", (api) => {
  assert.strictEqual(
    api.formatSQL("-- header create table t (a int);\n"),
    "-- header\nCREATE TABLE t (\n    a INT\n);\n",
  );
});

preserved("a comment on its own line before a statement is kept", (api) => {
  assertSameEffect(api, "-- the table\nCREATE TABLE t (id INTEGER);\n-- one row\nINSERT INTO t VALUES (1);");
});

// ---- MySQL's # comments ----------------------------------------------------
//
// `#` was a word character, for SQL Server's temporary tables, so a MySQL
// `# comment` was read as code: its words were re-cased and re-spaced, and a
// keyword in it started a clause.

regression("a MySQL # comment stays a comment, keywords and all", (api) => {
  const lines = api.formatSQL("# select everything\nSELECT id FROM t;").split("\n");
  assert.strictEqual(lines[0], "# select everything");
  assert.deepStrictEqual(lines.filter((l) => /select/i.test(l)), ["# select everything", "SELECT"]);
});

regression("a semicolon inside a # comment does not end the statement", (api) => {
  const lines = api.formatSQL("DELETE FROM t # careful; old rows only\nWHERE created < '2020';").split("\n");
  assert.ok(lines.includes("# careful; old rows only"), lines.join("\n"));
  assert.deepStrictEqual(lines.filter((l) => l.endsWith(";")), ["WHERE created < '2020';"]);
});

regression("a banner of # is a comment too", (api) => {
  assert.strictEqual(api.formatSQL("#### setup; run first ####\nSELECT 1;").split("\n")[0], "#### setup; run first ####");
});

preserved("SQL Server temporary tables keep their # and ##", (api) => {
  const out = api.formatSQL("SELECT a FROM #scratch JOIN ##shared s ON s.a = #scratch.a;");
  assert.ok(out.includes("FROM #scratch\nJOIN ##shared s ON s.a = #scratch.a;"), out);
});

regression("on one line, a # comment stops before the next statement like a -- comment", (api) => {
  assert.strictEqual(
    api.formatSQL("# header create table t (a int);"),
    "# header\nCREATE TABLE t (\n    a INT\n);\n",
  );
});

// ---- tokenizeRaw keeps every character -------------------------------------
//
// The page highlights the formatted SQL by re-tokenising it with
// tokenizeRaw and joining the tokens back up, and Copy copies that text. So
// tokenizeRaw has to give back exactly what it was given. It dropped the
// whitespace after a comment.

regression("tokenizeRaw gives back exactly what it was given", (api) => {
  for (const sql of [
    "-- a comment   \nSELECT 1;",
    "SELECT 1; -- trailing\r\nSELECT 2;",
    "-- header   select 1;",
  ]) {
    assert.strictEqual(api.tokenizeRaw(sql).map((t) => t.value).join(""), sql);
  }
});
