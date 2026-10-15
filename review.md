# Review — Reflow

First pass 2026-09-04. Remediated 2026-09-30 on `cleanup/2026-09-30` (not
pushed): eleven defects fixed, five of which changed what the SQL does, one of
them destructively. 228 tests, up from none. 51 are regression tests, each
asserted in the same run to fail against the first commit. There are also 11
checks in real Chrome.

## Corrections to the first review

The first review's findings are kept at the bottom. Read these before it.

**1. "I found no correctness bugs in the paths I read."** There were five
classes of defect that change what formatted SQL does, and the worst deletes
data. Every one was reproduced by running the input and the output through
SQLite and comparing the results:

    DELETE FROM t -- careful; only old rows
    WHERE created < '2020';

came out as a `DELETE` with no `WHERE`, followed by `only old rows WHERE ...`
as a statement of its own. Run as a script, the first statement deletes every
row and only then does the second fail. The input deletes two rows of three.
This is exactly the failure the review's own closing note warned about ("the
failure mode of a formatter bug is silently rewritten SQL that still runs").
It read the tokenizer and did not run it on anything with a line break.

**2. "Tokenising rather than pattern-matching is what makes it work."** True,
and the tokenizer is the right design. But the one heuristic that makes
single-line input work was applied to every input. That is defect 1 below. The
praise was for the architecture, and the bug was in how far one rule reached.

**3. Finding 5 (`anatomyBody.innerHTML = msg`) is safe.** `showAnatomy` only
ever chooses between three fixed messages and never quotes the input. A test
now drives all three branches with input that would run if it were ever
interpolated.

**4. Findings 3 and 4 (re-formatting on every keystroke, rebuilding the output
DOM) measured fine.** A 574 KB export formats in about 0.3 s and is
re-tokenised for highlighting in 40 ms. That is linear, and on a par with the
original. Nothing was changed.

## Fixed

Each has regression tests in `tests/` that run against both the current
parser and the first commit's, and fail unless the original gets it wrong.

### Changed what the SQL does

1. **A `--` comment was cut short at a `;` or a statement keyword even when a
   line break ended it** (`comments.test.js`). The rule exists for exports
   flattened onto one line, where nothing else marks a comment's end. Applied
   to ordinary SQL, the rest of the comment became code: the `DELETE` above;
   `-- Create the users table` became `CREATE the users TABLE`; a
   `-- when finished: DROP TABLE t;` on the last line became a `DROP` that
   runs. It now applies only when the whole input is one line.
2. **Tokens cut in two** (`tokens.test.js`). Numbers were `[0-9.]+`, so `1e5`
   became `1 e5` and `0x1F` became `0 x1F`. Both still run, as the number 1
   under the column name `e5`, and as 0. `->>`, `<<`, `>>`, `==`, `<=>`, `:=`,
   `@>`, `#>>` and `:name` were split into syntax errors. A letter outside
   A–Z was punctuation, emitted with no space before it, so `SELECT a नाम` (a
   column and its alias) became `aनाम`.
3. **Strings misread** (`strings.test.js`). mysqldump escapes quotes as
   `'O\'Connor'`. Read the standard way, that string ends at `\'`, and the
   data was re-spaced; with two escaped quotes the misreading even parses, and
   every value changes. `X'41'`, `N'…'`, `E'…'` lost their prefix. PostgreSQL
   `$$…$$` bodies were re-spaced, and split into statements at each `;`.
4. **MySQL `#` comments were code** (`comments.test.js`): `# select
   everything` added a clause, and a `;` in one ended the statement.
5. **A declared name that is also a keyword was re-cased** (`names.test.js`).
   `SELECT X'4142' AS blob` returned a column called `BLOB`, and
   `CREATE TABLE log (date DATE)` created a column called `DATE`. The
   database hands those names to applications as written, so `$row['date']`
   found nothing. The SQLite corpus found this; no targeted test had.

### Layout

6. A blank line after any comment before `SELECT`/`SET`/`VALUES`; trailing
   comments glued into one line (`-- a-- b`).
7. `CASE` put `WHEN`/`THEN`/`ELSE`/`END` at the clause's margin, and every
   select item after it lost its indent. Also `END ;`.
8. `t.*` became `t. *`, and `"s"."t"` became `"s". "t"`. A column named `end`
   or `order` after a dot started a new clause.
9. The one-column-per-line layout fired on any top-level parenthesis in
   `CREATE TABLE`/`CREATE OR …`/`ALTER TABLE`, so `ADD COLUMN c VARCHAR(10)`
   spread `10` over three lines; and it missed `CREATE TEMPORARY TABLE`.
10. `-1` came out as `- 1`.

### Tests

11. **There were none.** The review's one P2. `test/DDL.sql` and `DML.sql`
    were inputs with nothing asserted; they are now `tests/fixtures/`, and
    their formatted output is pinned by hash (see "Unresolved" for why not as
    text).

## Left alone, and why

- **The single-line heuristic itself.** On a one-line input a comment like
  `-- Create the table create table t (` is still split at the first
  `Create`. On a single line that is genuinely ambiguous, and the heuristic is
  right for real exports: the two fixtures and the page's own sample format
  exactly as before, and are pinned by `preserved:` tests. Improving it needs
  more real flattened exports than the two here.
- **A two-line paste**, a short line followed by a flattened export, now gets
  the strict comment rule, so a comment at the start of the export swallows
  it. The output is visibly unformatted rather than silently wrong. The
  page's explanation panel appears for inputs of up to two lines, so in that
  case it can describe recovery that did not happen. Its text is on-screen
  copy and was not touched.
- **Subqueries** keep their clauses on one line inside the parentheses. That
  is a visible design choice, not a defect.
- **`BEGIN … END` bodies** are split into statements with blank lines between
  them, like top-level statements. That is harmless to meaning. Fixing it
  properly means telling a transaction's `BEGIN;` from a block's `BEGIN`.
- **`DELIMITER`** (a MySQL client command, not SQL) is not understood, and
  `VALUES(col)` in `ON DUPLICATE KEY UPDATE` is laid out like a `VALUES`
  list. Neither changes meaning. Both are in the README's known limits.
- **Recasing a keyword-named reference** (`WHERE date > …`). SQL looks names
  up without regard to case, so this is harmless; only declarations were
  fixed.
- **No `LICENSE`.** The first review's P3. That is the author's choice.

No on-screen change was made. `index.html` and `css/style.css` are untouched;
`script.js` lost one comment and nothing else.

## Unresolved

**The fixtures are someone's coursework, in a public repository.**
`tests/fixtures/DDL.sql` and `DML.sql` are headed "ICT702 Supplementary
Assignment", with the database named `ICT702_Nusrat_Supplementary_Assignment`,
and the remote is `github.com/nishantmajhi/ReFlow`. The people and companies
in the data look invented. Whether an assessment's answer should be public is
a decision, not a task. The files were moved, not changed, and their formatted
output is pinned by hash so that no second copy was committed.

## Checking it

```sh
npm test               # 228, about a second
npm run test:browser   # 11 in headless Chrome; skips without a browser
```

Every one of the 16 commits was checked out into its own worktree, where
`core.autocrlf=true` gives CRLF files, and tested there: 12, 22, 36, 50, 56,
56, 59, 65, 67, 74, 77, 86, 222, 228, 228, 228, all green. The suite was also
run three times in a row, and the browser check in a fresh worktree of the
last commit.

Nothing here needs a person. The page is formatting-only: no network, no
storage, no files. Chrome has run it with the driver.

## Notes for the next session

- **`tests/helpers.js` has the SQLite oracle** (`assertSameEffect`,
  `assertSameSelect`), and it is worth taking to any project here that
  generates or rewrites SQL. It compares every table and every result,
  including column names, before and after. Two traps are handled there:
  SQLite stores a declared type and a default as the text they were written
  in, so those are compared by meaning; and a query's column name is its
  source text unless aliased, so corpus queries alias their expressions.
- **`regression()` and `preserved()`** run one check against both the current
  file and the first commit's, in the same run. They are cheaper than a
  separate `--original` runner and cannot drift from the tests they guard.
- **The Bash tool un-escapes `\\` in heredocs.** Test strings with backslashes
  written through it lost them, twice. Write such files with the Write tool.
- The corpus in `tests/sqlite.test.js` is SQLite's dialect. MySQL-only syntax
  (`#` comments, backslash escapes) is tested by expected output instead.

## First-pass review (2026-09-04)

Kept as written. See the corrections above.

Reviewed 2026-09-04 against the working tree. Scope: `index.html`, `js/parser.js`, `js/script.js`,
`css/style.css`, `test/DDL.sql`, `test/DML.sql`, `README.md`.

### What this project is

A fully client-side SQL formatter. It tokenises the input properly — handling strings, quoted
identifiers, comments, operators and parentheses — then re-emits the statement with configurable
keyword casing, indentation and blank-line spacing, with display-only syntax highlighting on the
output.

### Verdict

This is a well-built little tool and the design decisions behind it are the right ones. Tokenising
rather than pattern-matching is what makes it work on minified single-line SQL, which is the stated
purpose. Two details stand out as evidence of real care:

- `highlight()` escapes `&`, `<` and `>` through `escapeHtml` before wrapping any token in a span. SQL
  is full of comparison operators, so this is exactly where a lesser implementation would corrupt its
  own output or open an injection hole. It does not.
- The comment above `highlight()` explains that it deliberately uses `tokenizeRaw` rather than
  `tokenize`, because the latter strips whitespace tokens — correct for parsing, wrong for
  re-displaying formatted text. That is a real bug someone hit once, fixed, and wrote down.

I found no security issues and no correctness bugs in the paths I read. The notes below are
improvements.

### Findings

**1. There are no automated tests, and this is the single most testable project in the archive.**
`formatSQL(sql, options)` is a pure function: string and options in, string out. The `test/` directory
already contains `DDL.sql` and `DML.sql` as inputs — but nothing asserts anything about the output,
so they are demo fixtures rather than tests.

What you want is a set of input/expected-output pairs plus a runner that diffs them. Then the tricky
cases become permanent: a string literal containing a semicolon, a `--` comment containing a quote, a
`/* */` block spanning statements, nested subqueries, a quoted identifier containing a space, and
dialect-specific operators. Every one of those is a place a formatter can silently mangle SQL, and
mangled SQL that still parses is the worst possible failure for this tool.

**2. "Best-effort" dialect support is honest but undefined.** The README lists MySQL, PostgreSQL, SQL
Server and SQLite. Real divergences that will bite: MySQL backtick identifiers versus SQL Server
square brackets versus standard double quotes; `#` comments in MySQL; dollar-quoted strings in
PostgreSQL (`$$ ... $$`), which a tokeniser unaware of them will mis-split. Check whether
`tokenizeRaw` handles each, and document which dialect quirks are supported rather than leaving it at
"best-effort".

**3. Live formatting on every keystroke, debounced at 220 ms.** Fine for typical input; a very large
script re-tokenises and re-highlights the whole document on each pause. If it ever feels sluggish, the
fix is to skip the highlight pass while typing and apply it once on idle.

**4. `output.innerHTML = highlight(formatted)`** is safe because of the escaping noted above, but it
does rebuild the entire output DOM on every format. For large inputs that is the expensive part. Not
worth changing unless it becomes noticeable.

**5. `anatomyBody.innerHTML = msg`** at `script.js:96` assigns a message string. Confirm `msg` is
always a literal you constructed and never contains any part of the user's SQL — if it ever quotes
the input to explain what it did, that path needs `escapeHtml` too.

**6. No `LICENSE`.** The README describes a tool people would plausibly want to reuse.

### Cleanup

Nothing to remove. No debug output, no secrets, no analytics, no dead code, no committed artifacts.
The comments explain reasoning rather than restating the code.

### Action checklist

- [ ] **P2** Add input/expected-output tests covering strings, comments, subqueries and quoted
      identifiers.
- [ ] **P3** Document which dialect-specific syntax is actually handled; check dollar-quoting and
      backtick or bracket identifiers.
- [ ] **P3** Verify the anatomy message never interpolates raw input; add a `LICENSE`.

### Notes for a future session

Static site — open `index.html`. The parser is in `js/parser.js` and is the whole product; `script.js`
is presentation. Before changing tokenisation, write the test case first, because the failure mode of
a formatter bug is silently rewritten SQL that still runs, which nobody notices until it matters.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same, and `package.json`
declares `SEE LICENSE IN LICENSE`, npm's form for a licence with no SPDX
identifier. Anything above that calls the licence an open question, or calls
the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the node checks and the browser suite as two
jobs on `ubuntu-latest`, on Node 24, which has `node:sqlite`. Nothing has been
pushed, so it has not run on GitHub yet. Every job was run before committing,
from a fresh clone of this branch, the way a runner would run it: Linux jobs
in a throwaway Ubuntu 24.04 (the image `ubuntu-latest` uses) with the same
tool versions. 228 and 11.

The node job fetches full history, which the regression tests read (they fail
without it, checked). The browser job fails if the runner prints `SKIP`, which
it does when it finds no Chrome; otherwise a missing browser would read as a
pass.
