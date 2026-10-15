"use strict";

// The output the tool already got right, pinned against both the fixed and
// the original parser. These are the single-line exports Reflow was built
// for: the sample the page loads on start, and the two scripts in fixtures/.
//
// The fixtures' formatted output is pinned by hash rather than committed as
// text, because it would be a second copy of someone's coursework.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert");
const { preserved } = require("./helpers.js");
const { ROOT, fixture } = require("./harness.js");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// The page's own sample, read out of script.js so a change there shows up here.
const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "js", "script.js"), "utf8").match(/const SAMPLE_DDL = (".*");/)[1],
);

const SAMPLE_FORMATTED = `-- ==================================================== -- Schema: simple e-commerce orders -- ====================================================
CREATE TABLE CUSTOMERS (
    customer_id INT NOT NULL AUTO_INCREMENT,
    full_name VARCHAR(120) NOT NULL,
    email VARCHAR(150) NOT NULL,
    CONSTRAINT pk_customers PRIMARY KEY (customer_id)
);

CREATE TABLE ORDERS (
    order_id INT NOT NULL AUTO_INCREMENT,
    customer_id INT NOT NULL,
    order_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    CONSTRAINT pk_orders PRIMARY KEY (order_id),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES CUSTOMERS(customer_id)
);

-- seed a few rows so the table isn't empty on first run
INSERT INTO CUSTOMERS (full_name, email)
VALUES
    ('Jordan Reyes', 'jordan@example.com'),
    ('Priya Nair', 'priya@example.com'),
    ('Sam O''Connor', 'sam@example.com');

SELECT
    o.order_id,
    c.full_name,
    o.status
FROM ORDERS o
INNER JOIN CUSTOMERS c ON o.customer_id = c.customer_id
WHERE o.status = 'pending'
ORDER BY
    o.order_date DESC;
`;

preserved("the sample the page loads on start formats exactly as before", (api) => {
  assert.strictEqual(api.formatSQL(SAMPLE), SAMPLE_FORMATTED);
});

preserved("the sample is a single line, so it exercises the comment recovery", () => {
  assert.ok(!SAMPLE.includes("\n"));
  assert.ok(SAMPLE.length > 300, "the page's explanation panel only appears above 300 characters");
});

const OPTIONS = {
  default: {},
  "lower case, one tab, no blank lines": { upper: false, indentChar: "\t", indentSize: 1, blankLinesBetween: 0 },
  "eight spaces, five blank lines": { indentSize: 8, blankLinesBetween: 5 },
};

const PINNED = {
  "DDL.sql": {
    default: "8e7bc25520a4171161f9f7a8c2bc84717cbb066c73acb96634b963a8d6c2b456",
    "lower case, one tab, no blank lines": "bf09712606ca6760349cc470f03545087c2f384e5fc7b22a61a60a81d2049b03",
    "eight spaces, five blank lines": "5b8bab291c2b655a164f6742431b898f57fe356503cf7cd0904340abfb8e1bd2",
  },
  "DML.sql": {
    default: "8cae2db429cf7be74f95e0b23563e8c6cf2ed1df0652ae4a531de1069f1f02f1",
    "lower case, one tab, no blank lines": "a5535c9cbcd2b0de32fab1f02806e88a6a2610e673660626014a5053b0d0d82c",
    "eight spaces, five blank lines": "b74f295424c5f177bb355151ccd85393ce5298cab2d6000b4cd49ee5d604eb65",
  },
};

for (const [file, byOption] of Object.entries(PINNED)) {
  for (const [label, hash] of Object.entries(byOption)) {
    preserved(`${file} (${label}) formats exactly as before`, (api) => {
      assert.strictEqual(sha256(api.formatSQL(fixture(file), OPTIONS[label])), hash);
    });
  }

  preserved(`${file} is one physical line and formatting it twice changes nothing`, (api) => {
    const input = fixture(file);
    assert.ok(!input.includes("\n"));
    const once = api.formatSQL(input);
    assert.strictEqual(api.formatSQL(once), once);
  });

  preserved(`${file} keeps every statement: one block per semicolon, each ending in it`, (api) => {
    const input = fixture(file);
    const blocks = api.formatSQL(input).trim().split("\n\n");
    // Every statement ends in a `;` that is not inside a string.
    const terminators = api.tokenize(input).filter((t) => t.type === "punct" && t.value === ";").length;
    assert.strictEqual(blocks.length, terminators);
    for (const block of blocks) assert.ok(block.endsWith(";"), `a block does not end its statement:\n${block}`);
  });
}
