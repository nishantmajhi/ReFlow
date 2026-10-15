"use strict";

// Names that are also keywords.
//
// The formatter re-cases every word on its keyword list. Most of the time a
// keyword-shaped word used as a name is only being referred to, and SQL
// looks names up without regard to case. But where a name is declared -- an
// alias after AS, a column in CREATE TABLE -- its case is what the database
// hands back to applications: `SELECT 1 AS date` returns a column called
// `date`, and PHP's $row['date'] does not find one called `DATE`. Found by
// the SQLite corpus, which failed on `X'4142' AS blob`.

const test = require("node:test");
const assert = require("node:assert");
const { loadParser } = require("./harness.js");
const { regression, preserved, assertSameEffect, assertSameSelect } = require("./helpers.js");

regression("an alias after AS keeps the case it was written in", (api) => {
  assertSameSelect(api, "SELECT 1 AS date, 'x' AS text, X'41' AS blob, 2 AS Key, 3 AS time;");
});

regression("an alias after AS in a subquery keeps its case too", (api) => {
  assertSameSelect(api, "SELECT date FROM (SELECT 1 AS date, 2 AS text) WHERE text = 2;");
});

preserved("the type in a CAST is still a keyword", (api) => {
  assert.ok(api.formatSQL("select cast(x as date), cast(y as integer) from t;").includes("cast(x AS DATE),\n    cast(y AS INTEGER)"));
});

preserved("CREATE VIEW ... AS SELECT and WITH ... AS ( are unaffected", (api) => {
  assert.ok(api.formatSQL("create view v as select 1;").startsWith("CREATE VIEW v AS\nSELECT"));
  assert.ok(api.formatSQL("with x as (select 1) select * from x;").startsWith("WITH x AS ("));
});

regression("a column named like a keyword keeps its case in CREATE TABLE", (api) => {
  const out = assertSameEffect(api, "create table log (date date not null, text text, time integer, key text primary key);");
  assert.ok(out.includes("    date DATE NOT NULL,\n    text TEXT,\n    time INTEGER,\n    key TEXT PRIMARY KEY\n"), out);
});

preserved("table constraints in CREATE TABLE are still keywords", (api) => {
  const out = api.formatSQL(
    "create table t (a int, b int, constraint pk primary key (a), foreign key (b) references u (b), unique (b), check (a > 0));",
  );
  assert.ok(out.includes("    CONSTRAINT pk PRIMARY KEY (a),\n    FOREIGN KEY (b) REFERENCES u(b),\n    UNIQUE(b),\n    CHECK(a > 0)\n"), out);
});

regression("MySQL's KEY and INDEX definitions are keywords, a column called key is not", (api) => {
  const out = api.formatSQL("create table t (id int, key varchar(10), key idx_id (id), index (id));");
  assert.ok(out.includes("    id INT,\n    key VARCHAR(10),\n    KEY idx_id(id),\n    INDEX(id)\n"), out);
});

regression("a column added by ALTER TABLE keeps its case", (api) => {
  const out = assertSameEffect(api, "alter table t add column date date; alter table t add text text;", {
    setup: "CREATE TABLE t (id INTEGER);",
  });
  assert.ok(out.includes("ALTER TABLE t ADD COLUMN date DATE;"), out);
  assert.ok(out.includes("ALTER TABLE t ADD text TEXT;"), out);
});

// Not `preserved`: the original spread `(a)` over three lines, a bug of its own.
test("ALTER TABLE ... ADD CONSTRAINT and ADD PRIMARY KEY are still keywords", () => {
  const api = loadParser();
  assert.ok(api.formatSQL("alter table t add constraint pk primary key (a);").includes("ADD CONSTRAINT pk PRIMARY KEY (a);"));
});
