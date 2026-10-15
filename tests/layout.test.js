"use strict";

// Layout: where the formatter breaks lines and puts spaces.
//
// None of these changed what the SQL means. They are cases where the output
// was visibly wrong -- a column list pulled back to the margin after a CASE,
// `t. *`, a one-number type length spread over three lines -- in statements
// common enough that anyone using the tool would meet them.

const assert = require("node:assert");
const { regression, preserved, assertSameEffect, assertSameSelect } = require("./helpers.js");

const fmt = (api, sql) => api.formatSQL(sql);

// ---- comments --------------------------------------------------------------

regression("no blank line between a comment and the SELECT under it", (api) => {
  assert.strictEqual(fmt(api, "-- newest first\nSELECT id FROM t;"), "-- newest first\nSELECT\n    id\nFROM t;\n");
});

regression("no blank line around a comment inside a select list", (api) => {
  assert.strictEqual(
    fmt(api, "SELECT a,\n-- the second one\nb FROM t;"),
    "SELECT\n    a,\n    -- the second one\n    b\nFROM t;\n",
  );
});

regression("comments after the last statement stay on their own lines", (api) => {
  assert.strictEqual(fmt(api, "SELECT 1;\n-- end of file\n-- really"), "SELECT\n    1;\n\n-- end of file\n-- really\n");
});

// ---- CASE ------------------------------------------------------------------

regression("a CASE in a select list is indented under its item, and the items after it keep their indent", (api) => {
  assert.strictEqual(
    fmt(api, "select id, case when a > 1 then 'big' else 'small' end as size, b from t;"),
    [
      "SELECT",
      "    id,",
      "    CASE",
      "        WHEN a > 1",
      "        THEN 'big'",
      "        ELSE 'small'",
      "    END AS size,",
      "    b",
      "FROM t;",
      "",
    ].join("\n"),
  );
});

regression("a CASE in a WHERE clause closes at the clause's indent, with no space before the semicolon", (api) => {
  assert.strictEqual(
    fmt(api, "select a from t where b = case when c then 1 else 2 end;"),
    ["SELECT", "    a", "FROM t", "WHERE b = CASE", "    WHEN c", "    THEN 1", "    ELSE 2", "END;", ""].join("\n"),
  );
});

regression("a CASE inside a CASE nests", (api) => {
  assert.strictEqual(
    fmt(api, "select case when a then case when b then 1 end else 2 end as x, y from t;"),
    [
      "SELECT",
      "    CASE",
      "        WHEN a",
      "        THEN CASE",
      "            WHEN b",
      "            THEN 1",
      "        END",
      "        ELSE 2",
      "    END AS x,",
      "    y",
      "FROM t;",
      "",
    ].join("\n"),
  );
});

regression("a CASE with no alias is followed straight by its comma", (api) => {
  assert.ok(api.formatSQL("select case when a then 1 end, b from t;").includes("    END,\n    b\n"));
});

preserved("a CASE inside parentheses stays on one line", (api) => {
  assert.ok(fmt(api, "select sum(case when a then 1 else 0 end) as s from t;").includes("sum(CASE WHEN a THEN 1 ELSE 0 END) AS s"));
});

preserved("the formatted CASE still means the same thing", (api) => {
  assertSameSelect(
    api,
    "select id, case when id > 1 then 'big' else 'small' end as size from t order by id;",
    "CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1), (2);",
  );
});

// ---- qualified names -------------------------------------------------------

regression("nothing is spaced after the dot of a qualified name", (api) => {
  assert.strictEqual(
    fmt(api, 'select t.*, "s"."t", [dbo].[x] from s.[t];'),
    'SELECT\n    t.*,\n    "s"."t",\n    [dbo].[x]\nFROM s.[t];\n',
  );
});

regression("a column named like a keyword keeps its case and its place after the dot", (api) => {
  assert.strictEqual(
    fmt(api, "select e.end, e.date, o.order from events e;"),
    "SELECT\n    e.end,\n    e.date,\n    o.order\nFROM events e;\n",
  );
});

// ---- the parenthesised list of a CREATE TABLE ------------------------------

regression("a type's length in ALTER TABLE stays on one line", (api) => {
  assert.strictEqual(fmt(api, "alter table t add column c varchar(10);"), "ALTER TABLE t ADD COLUMN c VARCHAR(10);\n");
});

regression("a foreign key added by ALTER TABLE stays on one line", (api) => {
  assert.strictEqual(
    fmt(api, "alter table t add constraint fk foreign key (a) references u (b);"),
    "ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(b);\n",
  );
});

preserved("ALTER TABLE ... ADD (several columns) is still laid out like a CREATE TABLE", (api) => {
  assert.strictEqual(fmt(api, "alter table t add (a int, b int);"), "ALTER TABLE t ADD (\n    a INT,\n    b INT\n);\n");
});

regression("CREATE TABLE ... AS SELECT does not lay out an IN list as columns", (api) => {
  assert.strictEqual(
    fmt(api, "create table t2 as select a from t where b in (1, 2);"),
    "CREATE TABLE t2 AS\nSELECT\n    a\nFROM t\nWHERE b IN (1, 2);\n",
  );
});

regression("a subquery in CREATE OR REPLACE VIEW is not laid out as columns", (api) => {
  assert.strictEqual(
    fmt(api, "create or replace view v as select a from (select b, c from t) x;"),
    "CREATE OR replace VIEW v AS\nSELECT\n    a\nFROM (\n    SELECT b, c FROM t\n) x;\n",
  );
});

regression("CREATE TEMPORARY TABLE and CREATE TABLE IF NOT EXISTS get the column layout", (api) => {
  for (const head of ["create temporary table t", "create table if not exists t"]) {
    const out = fmt(api, `${head} (a int, b int);`);
    assert.ok(out.endsWith(" (\n    a INT,\n    b INT\n);\n"), out);
  }
});

preserved("the columns of a CREATE TABLE are still one per line", (api) => {
  assertSameEffect(api, "create table t (id integer primary key, name varchar(20) not null, price decimal(10, 2));");
  assert.strictEqual(
    fmt(api, "create table t (id int, price decimal(10, 2));"),
    "CREATE TABLE t (\n    id INT,\n    price DECIMAL(10, 2)\n);\n",
  );
});

// ---- signs -----------------------------------------------------------------

regression("a minus sign stays against its number", (api) => {
  assert.strictEqual(
    fmt(api, "select -1, a - -2, a * -b from t where c > -5;"),
    "SELECT\n    -1,\n    a - -2,\n    a * -b\nFROM t\nWHERE c > -5;\n",
  );
  assert.strictEqual(fmt(api, "insert into t values (1, -5.5);"), "INSERT INTO t\nVALUES\n    (1, -5.5);\n");
});

preserved("subtraction keeps its spaces", (api) => {
  assert.ok(fmt(api, "select a - 1, b-2 from t;").includes("a - 1,\n    b - 2"));
});

regression("two signs in a row can never become a comment", (api) => {
  const out = assertSameSelect(api, "SELECT - -1 AS a, - - 2 AS b;");
  assert.ok(!out.includes("--"), out);
  assert.ok(out.includes("- -1 AS a"), out);
});
