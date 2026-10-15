"use strict";

// Strings the tokenizer did not recognise as strings.
//
// Inside a string every character is data, so a formatter must copy it
// exactly. When the tokenizer misread where a string started or ended, the
// formatter re-spaced part of a string as if it were code -- changing the data
// -- and re-spaced part of the code as if it were a string.

const assert = require("node:assert");
const { regression, preserved, assertSameSelect } = require("./helpers.js");

// ---- prefixed literals -----------------------------------------------------

regression("a hex blob literal keeps its prefix", (api) => {
  // X '41' is a syntax error; X'41' is the blob 0x41.
  assertSameSelect(api, "SELECT X'41' AS b, x'4243' AS c;");
});

regression("prefixed strings from other dialects keep their prefix", (api) => {
  const cases = {
    "SELECT N'Zoë' FROM t;": "N'Zoë'", // SQL Server national string
    "SELECT E'tab\\there' FROM t;": "E'tab\\there'", // PostgreSQL escape string
    "SELECT B'1010' FROM t;": "B'1010'", // bit string
    "SELECT U&'d\\0061t' FROM t;": "U&'d\\0061t'", // PostgreSQL unicode string
    "SELECT _utf8mb4'abc' FROM t;": "_utf8mb4'abc'", // MySQL character set introducer
  };
  for (const [input, expected] of Object.entries(cases)) {
    const out = api.formatSQL(input);
    assert.ok(out.includes(expected), `expected ${JSON.stringify(expected)} in:\n${out}`);
  }
});

regression("an E'' string's escaped quote does not end it", (api) => {
  const out = api.formatSQL("SELECT E'it\\'s  here', 2 FROM t;");
  assert.ok(out.includes("E'it\\'s  here',\n    2"), out);
});

// ---- MySQL backslash escapes -----------------------------------------------

// What mysqldump writes: every quote in the data escaped with a backslash.
const DUMP = "INSERT INTO `people` VALUES (1,'O\\'Connor','Sam\\'s  dog'),(2,'plain','two  spaces');";

regression("a mysqldump row with an escaped quote keeps its strings exactly", (api) => {
  assert.strictEqual(
    api.formatSQL(DUMP),
    "INSERT INTO `people`\nVALUES\n    (1, 'O\\'Connor', 'Sam\\'s  dog'),\n    (2, 'plain', 'two  spaces');\n",
  );
});

regression("an even number of escaped quotes, which misreads without an error, is still read right", (api) => {
  // Read the standard way this parses -- 'O\' Connor ',' Sam\ 's' -- so
  // nothing looks wrong, and every value changes.
  const out = api.formatSQL("INSERT INTO t VALUES ('O\\'Connor','Sam\\'s');");
  assert.ok(out.includes("('O\\'Connor', 'Sam\\'s')"), out);
});

regression("a backslash-escaped double quote in a MySQL string is kept", (api) => {
  const out = api.formatSQL('SELECT "say \\"hi\\"  now", 1 FROM t;');
  assert.ok(out.includes('"say \\"hi\\"  now",\n    1'), out);
});

preserved("a string that ends in a backslash is still complete in standard SQL", (api) => {
  // Treating backslash as an escape here would leave the string open, so the
  // input is read the standard way.
  assertSameSelect(api, "SELECT 'C:\\' AS a, 'D:\\' AS b;");
  assertSameSelect(api, "SELECT 'C:\\temp\\' AS dir;");
});

preserved("an escaped backslash reads the same either way", (api) => {
  const out = api.formatSQL("SELECT 'C:\\\\temp\\\\' AS dir FROM t;");
  assert.ok(out.includes("'C:\\\\temp\\\\' AS dir"), out);
});

preserved("a doubled quote is an escape in every dialect", (api) => {
  assertSameSelect(api, "SELECT 'Sam O''Connor' AS name, 'a;b' AS semi;");
});

preserved("a string left open while typing is copied through", (api) => {
  const out = api.formatSQL("SELECT 'abc");
  assert.ok(out.includes("'abc"), out);
});

// ---- PostgreSQL dollar quoting ---------------------------------------------

regression("a dollar-quoted string is copied exactly", (api) => {
  const out = api.formatSQL("SELECT $$two  spaces$$, $tag$semi ; colon$tag$ FROM t;");
  assert.ok(out.includes("$$two  spaces$$,"), out);
  assert.ok(out.includes("$tag$semi ; colon$tag$"), out);
  assert.ok(!out.includes("\n\n"), `a ; inside the quotes ended the statement:\n${out}`);
});

regression("a function body in dollar quotes is one statement, left as written", (api) => {
  const body = "$$\nBEGIN\n  RETURN a + 1;\nEND;\n$$";
  const out = api.formatSQL(`create function inc(a int) returns int as ${body} language plpgsql;`);
  assert.ok(out.includes(body), out);
  assert.strictEqual(out.trim().split("\n\n").length, 1, out);
});

preserved("a positional parameter is not a dollar quote", (api) => {
  assert.ok(api.formatSQL("SELECT * FROM t WHERE id = $1 AND b = $2;").includes("id = $1 AND b = $2;"));
});

preserved("a lone $$ with no closing tag is copied through", (api) => {
  assert.ok(api.formatSQL("SELECT $$abc").includes("$$abc"));
});
