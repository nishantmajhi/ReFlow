"use strict";

// A corpus of ordinary SQL (SQLite's dialect, so no MySQL # comments), run through a real engine before and after
// formatting, in every combination of the page's options.
//
// A formatter may change whitespace and keyword case and nothing else. This
// file asserts exactly that, without predicting what shape a mistake would
// take: SQLite executes the input and the output, and every table and every
// result is compared. It also asserts two properties of the output itself:
// formatting it again changes nothing, and it does not depend on how the
// input was laid out.

const test = require("node:test");
const assert = require("node:assert");
const { loadParser } = require("./harness.js");
const { assertSameEffect, assertSameSelect } = require("./helpers.js");

const OPTIONS = {
  default: {},
  "lower case": { upper: false },
  "one tab": { indentChar: "\t", indentSize: 1 },
  "no indent, no blank lines": { indentSize: 0, blankLinesBetween: 0 },
};

const SCHEMA = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  "full name" TEXT NOT NULL,
  email TEXT UNIQUE,
  tier TEXT DEFAULT 'basic' CHECK (tier IN ('basic', 'gold')),
  credit REAL DEFAULT -1.5
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers (id),
  placed TEXT NOT NULL,
  total NUMERIC(10, 2),
  notes TEXT
);
INSERT INTO customers (id, "full name", email, tier) VALUES
  (1, 'Jordan Reyes', 'jordan@example.com', 'gold'),
  (2, 'Sam O''Connor', 'sam@example.com', 'basic'),
  (3, 'Priya; Nair -- not a comment', NULL, 'basic');
INSERT INTO orders VALUES
  (1, 1, '2026-01-05', 120.50, 'first /* not a comment */'),
  (2, 1, '2026-02-11', 80, NULL),
  (3, 2, '2026-02-12', 15.25, 'it''s  spaced'),
  (4, 3, '2026-03-01', -4, '{"gift":true,"items":[1,2]}');
`;

// Scripts: compared by the state of every table afterwards.
const SCRIPTS = {
  "schema and data": SCHEMA,
  "update and delete with comments": `${SCHEMA}
-- promote anyone who has spent over 100; nobody else
UPDATE customers SET tier = 'gold', credit = credit + 10
WHERE id IN (SELECT customer_id FROM orders GROUP BY customer_id HAVING SUM(total) > 100); -- trailing note
/* remove the refund
   rows */ DELETE FROM orders WHERE total < 0;
DELETE FROM orders -- careful; only the old ones
WHERE placed < '2026-02-01';`,
  "trigger with a body": `${SCHEMA}
CREATE TABLE audit (what TEXT, at TEXT);
CREATE TRIGGER log_order AFTER INSERT ON orders
BEGIN
  INSERT INTO audit VALUES ('order ' || NEW.id, NEW.placed);
  UPDATE customers SET credit = credit - 1 WHERE id = NEW.customer_id;
END;
INSERT INTO orders (customer_id, placed, total) VALUES (2, '2026-04-01', 9.99);`,
  "view, index and upsert": `${SCHEMA}
CREATE VIEW big_spenders AS SELECT c.id, c."full name" AS name, SUM(o.total) AS spent
FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id HAVING spent > 50;
CREATE TABLE spenders AS SELECT * FROM big_spenders;
CREATE INDEX orders_by_customer ON orders (customer_id, placed DESC);
INSERT INTO customers (id, "full name") VALUES (2, 'Sam') ON CONFLICT (id) DO UPDATE SET "full name" = excluded."full name" || ' (again)';
INSERT INTO orders (customer_id, placed, total) SELECT id, '2026-05-01', 0x10 FROM customers WHERE tier = 'gold';`,
  "flattened export": "CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'), (-2, 'y;z'), (3e2, 'it''s'); UPDATE t SET b = b || '!' WHERE a > 0;",
};

// Queries: compared by column names and rows.
const QUERIES = {
  join: `SELECT o.id, c."full name", o.total FROM orders o INNER JOIN customers c ON c.id = o.customer_id WHERE o.total >= 15.25 ORDER BY o.id;`,
  "left join and null": `SELECT c.id, o.id AS order_id FROM customers c LEFT OUTER JOIN orders o ON o.customer_id = c.id AND o.total > 100 WHERE c.email IS NOT NULL ORDER BY c.id;`,
  aggregate: `SELECT customer_id, COUNT(*) AS n, SUM(total) AS spent, MAX(placed) AS last FROM orders GROUP BY customer_id HAVING COUNT(*) >= 1 ORDER BY spent DESC LIMIT 2 OFFSET 0;`,
  "case in a select list": `SELECT id, CASE WHEN total > 100 THEN 'big' WHEN total > 0 THEN 'small' ELSE 'refund' END AS size, total * -1 AS negated FROM orders ORDER BY id;`,
  "nested case": `SELECT id, CASE WHEN total > 0 THEN CASE WHEN total > 100 THEN 2 ELSE 1 END ELSE 0 END AS band FROM orders ORDER BY id;`,
  "subqueries everywhere": `SELECT c.id, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS n FROM (SELECT * FROM customers WHERE tier IN ('basic', 'gold')) c WHERE EXISTS (SELECT 1 FROM orders WHERE customer_id = c.id) AND NOT c.id IN (SELECT 99) ORDER BY c.id;`,
  cte: `WITH totals AS (SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id), ranked AS (SELECT customer_id, spent, RANK() OVER (ORDER BY spent DESC) AS r FROM totals) SELECT * FROM ranked WHERE r <= 2 ORDER BY r;`,
  window: `SELECT id, total, SUM(total) OVER (PARTITION BY customer_id ORDER BY placed ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM orders ORDER BY id;`,
  union: `SELECT email AS v FROM customers WHERE email IS NOT NULL UNION ALL SELECT notes FROM orders WHERE notes LIKE '%comment%' UNION SELECT 'x' ORDER BY v;`,
  "strings that look like code": `SELECT 'a;b' AS s1, '-- no' AS s2, '/* no */' AS s3, 'it''s' AS s4, '  spaced  ' AS s5, "full name" FROM customers ORDER BY id;`,
  json: `SELECT id, notes ->> '$.gift' AS gift, json_array_length(notes -> '$.items') AS n FROM orders WHERE notes LIKE '{%' ;`,
  literals: `SELECT 1e3 AS e, 2.5E-1 AS f, .75 AS g, 0xff AS h, X'4142' AS blob, -3 AS neg, +4 AS pos, 7 % 3 AS m, 1 << 4 AS sh, 5 & 3 AS band, 5 | 3 AS bor, ~0 AS inv;`,
  "casts and functions": `SELECT CAST(total AS INTEGER) AS whole, COALESCE(notes, 'none') AS n, ROUND(total / 3.0, 2) AS third, UPPER(substr(placed, 1, 4)) AS yr, total BETWEEN 10 AND 100 AS mid FROM orders ORDER BY id;`,
  "like with escape": `SELECT id FROM orders WHERE notes LIKE '%\\%%' ESCAPE '\\' OR notes IS NULL ORDER BY id;`,
  "unicode names": `SELECT c.id AS नाम, c."full name" AS "पूरा नाम" FROM customers c ORDER BY नाम;`,
  "comments among the clauses": `SELECT id, -- the key
  total /* the amount */
FROM orders -- all of them; really
-- except refunds
WHERE total > 0
ORDER BY id;`,
  "qualified star and quoted names": `SELECT o.*, [c].[full name], \`c\`.email FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.id;`,
  parameters: `SELECT :first AS a, ? AS b, @third AS c, $fourth AS d;`,
};

const api = loadParser();

for (const [label, options] of Object.entries(OPTIONS)) {
  for (const [name, sql] of Object.entries(SCRIPTS)) {
    test(`sqlite: script "${name}" does the same (${label})`, () => {
      assertSameEffect(api, sql, {}, options);
    });
  }
  for (const [name, sql] of Object.entries(QUERIES)) {
    test(`sqlite: query "${name}" returns the same (${label})`, () => {
      assertSameSelect(api, sql, SCHEMA, options);
    });
  }
}

const ALL = { ...SCRIPTS, ...QUERIES };

for (const [name, sql] of Object.entries(ALL)) {
  test(`formatting "${name}" twice changes nothing`, () => {
    for (const options of Object.values(OPTIONS)) {
      const once = api.formatSQL(sql, options);
      assert.strictEqual(api.formatSQL(once, options), once);
    }
  });
}

// Reflow reads SQL, not lines, so how the input was laid out should not
// matter. Flattening an input with a line comment in it changes what it
// means, so those are left out.
for (const [name, sql] of Object.entries(ALL)) {
  if (api.tokenizeRaw(sql).some((t) => t.type === "comment" && !t.value.startsWith("/*"))) continue;
  test(`"${name}" formats the same whether or not it arrives on one line`, () => {
    const flat = api.tokenizeRaw(sql).map((t) => (t.type === "ws" ? " " : t.value)).join("").trim();
    assert.ok(!flat.includes("\n") || /\/\*[\s\S]*\n/.test(flat));
    assert.strictEqual(api.formatSQL(flat), api.formatSQL(sql));
  });
}
