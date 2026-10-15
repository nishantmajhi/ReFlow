# Reflow

A SQL formatter that runs entirely in your browser. Paste SQL in, get it back
indented, with keywords in the case you choose.

It reads SQL as tokens — strings, quoted names, comments, numbers, operators —
rather than as lines, which is what lets it rebuild SQL that has lost every
line break: a schema exported onto one line, a query copied out of a log. It
works out where each statement ends and where each comment was meant to stop,
and lays the result out one clause per line.

Nothing leaves the page. There is no server and no network request.

## Using it

Open `index.html` in a browser. There is no build step and nothing to install.

```sh
git clone https://github.com/nishantmajhi/ReFlow.git
```

Paste into **Before**; the formatted SQL appears in **After** as you type.
**Copy formatted SQL** copies it. The toolbar sets:

| Option | Values | Default |
| --- | --- | --- |
| Case | keywords in UPPER or lower | UPPER |
| Indent | spaces or tabs, 0 to 8 of them per level | 4 spaces |
| Blank lines between statements | 0 to 5 | 1 |

## What it promises

Reflow changes whitespace and the case of keywords. Nothing else. The text of
every string, name, number and comment comes out exactly as it went in.

That promise is tested, not just stated: the test suite runs a corpus of
ordinary SQL through SQLite before and after formatting, under every option
set, and compares every table and every result.

Names that are declared keep the case they were written in even when they are
also keywords — `SELECT 1 AS date`, or a column called `text` in
`CREATE TABLE` — because the database returns that name to applications as
written.

### SQL that arrives on one line

If the whole input is a single line, a `--` or `#` comment has nothing to end
it, so Reflow has to guess where the SQL resumes: it ends the comment at a `;`,
or before a word that starts a statement (`CREATE`, `INSERT`, `SELECT` and so
on) when a `(` or `;` follows it. That guess is what the tool is built for, and
it is right for exports. It is still a guess: a one-line comment that itself
says `create table x (…)` will be split there.

As soon as the input has a line break, comments follow SQL's own rule and run
to the end of their line.

## Dialects

Reflow is not tied to one database. It recognises:

| | |
| --- | --- |
| Strings | `'…'` with `''` inside; MySQL's `\'` (as mysqldump writes it); prefixed literals `X'41'`, `N'…'`, `E'…'`, `B'…'`, `U&'…'`, `_utf8mb4'…'`; PostgreSQL's `$$…$$` and `$tag$…$tag$` |
| Names | `"double quoted"`, `` `backticked` ``, `[bracketed]`, names in any script (`नाम`, `prénom`), SQL Server's `#temp` and `##global` |
| Comments | `--`, `/* … */`, MySQL's `#` |
| Numbers | `42`, `4.2`, `.5`, `1e5`, `1.5E-3`, `0x1F`, `0b1010` |
| Operators | the usual, plus `->` `->>` `#>` `#>>` `@>` `<=>` `:=` `::` `<<` `>>` `&&` `~*` `!~` `!<` `!>` |
| Parameters | `?`, `:name`, `@name`, `$1` |

Whether a backslash escapes a quote depends on the database, and the text does
not say which one it is. Reflow reads backslashes as escapes if that closes
every string in the input, and the standard way (where `'C:\'` is a complete
string) if it does not.

Known limits, none of which changes what the SQL means:

- A MySQL comment with no space after the `#` (`#todo`) reads as a name, since
  SQL Server writes temporary tables that way.
- A subquery's clauses stay on one line inside its parentheses rather than
  one per line.
- The statements inside a `BEGIN … END` body are separated by blank lines,
  like top-level statements.
- The MySQL client's `DELIMITER` command is not understood.
- `VALUES(col)` in `ON DUPLICATE KEY UPDATE` is laid out like a `VALUES` list.

## How it works

`js/parser.js` is the formatter, and has no dependency on the page.

| Function | What it does |
| --- | --- |
| `tokenizeRaw(sql)` | Splits SQL into tokens — `ws`, `comment`, `string`, `ident`, `number`, `word`, `op`, `param`, `punct` — including whitespace, so joining them gives back the input exactly |
| `tokenize(sql)` | The same without whitespace, for the formatter |
| `splitStatements(tokens)` | Splits at each `;` outside parentheses |
| `formatStatement(tokens, opts)` | Lays out one statement |
| `formatSQL(sql, options)` | Tokenizes, splits, formats each statement and joins them |

`formatSQL` takes `upper` (boolean), `indentChar` (`" "` or `"\t"`),
`indentSize` and `blankLinesBetween`, with the defaults in the table above.

`js/script.js` connects the page to it and highlights the output. `css/style.css`
is the styling.

## Tests

Node 22.13 or later, for `node:sqlite` without a flag. There are no dependencies to install.

```sh
npm test               # 228 tests
npm run test:browser   # 11 checks in headless Chrome or Edge
```

- `tests/sqlite.test.js` runs the SQLite corpus described above, and checks
  that formatting twice changes nothing and that the output does not depend on
  how the input was laid out.
- `tests/preserved.test.js` pins the output for the page's own sample and for
  the two single-line scripts in `tests/fixtures/`.
- The other files each cover one area — comments, strings, tokens, names,
  layout, the page — and most tests there are `regression:` tests. Each one
  runs against both the current `js/parser.js` and the version in the first
  commit, and fails unless the original gets it wrong. A regression test that
  passes against the unfixed code is reported as a failure.
- `npm run test:browser` types a set of inputs into the real page in headless
  Chrome and checks that it produces exactly what Node does. It skips if no
  Chrome or Edge is installed; set `REFLOW_BROWSER` to point at one.

## Credits

Built by Manish Majhi with Claude.

## Licence

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.
