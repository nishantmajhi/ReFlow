/* ============================================================
   SQL FORMATTER ENGINE
   Tokenizes SQL, splits it into statements and re-emits each one.
   It may change whitespace and the case of keywords, and nothing
   else: tests/ runs input and output through SQLite to check that.
   ============================================================ */

const KEYWORDS = new Set([
  "select","from","where","insert","into","values","update","set","delete",
  "create","table","alter","drop","add","column","constraint","primary","key",
  "foreign","references","not","null","unique","default","check","auto_increment",
  "join","inner","outer","left","right","full","cross","on","as","and","or",
  "group","by","order","having","limit","offset","union","all","distinct",
  "case","when","then","else","end","is","in","like","between","exists",
  "begin","commit","rollback","transaction","start","use","database","schema",
  "view","index","trigger","procedure","function","return","returns","declare",
  "if","while","for","cascade","restrict","engine","charset","collate",
  "varchar","char","int","integer","decimal","numeric","float","double",
  "date","datetime","timestamp","time","boolean","bool","text","blob","enum",
  "with","over","partition","asc","desc","explain","analyze","truncate","rename",
  "grant","revoke","to","lock","unlock","tables","temporary"
]);

const ALWAYS_NEWLINE_BEFORE = [
  "select","from","where","group by","order by","having","limit","offset",
  "union all","union","values","set",
  "left outer join","right outer join","full outer join",
  "inner join","left join","right join","full join","cross join","join",
  "when","then","else","end"
];

const BOUNDARY_KEYWORDS = [
  "create", "insert", "update", "delete", "select", "alter", "drop",
  "start transaction", "begin", "commit", "rollback", "truncate",
  "grant", "revoke", "use ", "with", "merge", "explain", "call"
];

function startsBoundaryKeyword(sql, pos) {
  const prevChar = sql[pos - 1];
  if (pos > 0 && !/\s/.test(prevChar)) return false;

  for (const kw of BOUNDARY_KEYWORDS) {
    const trimmedKw = kw.trim();
    if (sql.slice(pos, pos + trimmedKw.length).toLowerCase() === trimmedKw) {
      const after = sql[pos + trimmedKw.length];
      if (after === undefined || /[\s(,;]/.test(after)) {
        const windowEnd = Math.min(sql.length, pos + trimmedKw.length + 200);
        const window = sql.slice(pos + trimmedKw.length, windowEnd);
        const nextDashDash = window.indexOf("--");
        const nextParen = window.indexOf("(");
        const nextSemi = window.indexOf(";");
        const structuralSignalIdx = [nextParen, nextSemi]
          .filter(x => x !== -1)
          .sort((a, b) => a - b)[0];

        if (structuralSignalIdx === undefined) continue;
        if (nextDashDash !== -1 && nextDashDash < structuralSignalIdx) continue;
        return true;
      }
    }
  }
  return false;
}

// Names may be written in any script, and a Devanagari vowel sign is a
// combining mark (\p{M}), not a letter.
const WORD_START = /[\p{L}_$#@]/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}_$#@]/u;

// Hex (`0x1F`), MySQL binary (`0b1010`), then decimals with an optional
// exponent: `1`, `1.5`, `1.`, `.5`, `1e5`, `1.5E-3`.
const NUMBER = /0[xX][0-9A-Fa-f]+|0[bB][01]+|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;

// Longest first, so `->>` is not read as `->` and `>`. Beyond the standard
// comparisons: JSON arrows (MySQL, PostgreSQL, SQLite), MySQL's `<=>`, `:=`
// and `&&`, PostgreSQL's `#>`, `#>>`, `@>` and regex matches, and SQL
// Server's `!<` and `!>`. PostgreSQL's `<@` is left out on purpose: SQL
// Server writes `a<@b` to mean `a < @b`.
const OPERATORS = [
  "->>", "<=>", "#>>", "!~*",
  "->", "#>", "@>", "~*", "!~", "!<", "!>", ">=", "<=", "<>", "!=", "==",
  "||", "::", ":=", "<<", ">>", "&&"
];

// Whether the `.` at `pos` qualifies the name it is written against (`t.col`,
// `"s".t`, `f(x).y`) rather than starting a number like `.5`.
function followsName(sql, pos) {
  return pos > 0 && /[\p{L}\p{M}\p{N}_$#@"`\])]/u.test(sql[pos - 1]);
}

// A string literal with a prefix: X'41', N'...', E'...', B'...', U&'...',
// and MySQL's character set introducers such as _utf8mb4'...'.
const STRING_PREFIX = /(?:[NnEeXxBb]|[Uu]&|_[A-Za-z][A-Za-z0-9]*)'/y;

// $$...$$ or $tag$...$tag$ (PostgreSQL). `$1` is a parameter, not a tag.
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

// MySQL's `# comment`. SQL Server names temporary tables `#name` and
// `##name`, so a run of `#` followed by a name character is a word, and
// PostgreSQL's `#>` and `#>>` are operators.
function isHashComment(sql, pos) {
  if (sql[pos] !== "#" || sql[pos + 1] === ">") return false;
  let k = pos;
  while (sql[k] === "#") k++;
  return !(k < sql.length && WORD_CHAR.test(sql[k]));
}

// Where the quoted run starting at `start` ends. A doubled quote is an
// escape everywhere; a backslash is one only in MySQL and E'' strings.
function readQuoted(sql, start, quote, backslashEscapes) {
  let j = start + 1;
  while (j < sql.length) {
    if (backslashEscapes && sql[j] === "\\") { j += 2; continue; }
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }
      return { end: j + 1, closed: true };
    }
    j++;
  }
  return { end: sql.length, closed: false };
}

function tokenizeRaw(sql) {
  // MySQL escapes a quote inside a string with a backslash - `'O\'Connor'`,
  // which is how mysqldump writes it. Standard SQL does not, and there
  // `'C:\'` is a complete string. Read backslashes as escapes when that
  // closes every string in the input, and the standard way otherwise.
  if (sql.includes("\\")) {
    const mysql = scan(sql, true);
    if (!mysql.unterminated) return mysql.tokens;
  }
  return scan(sql, false).tokens;
}

function scan(sql, backslashEscapes) {
  const tokens = [];
  let unterminated = false;
  let i = 0;
  const n = sql.length;

  // A `--` comment ends at the end of its line. Only when the input has no
  // line breaks at all - an export flattened onto one line - does a comment
  // run into the SQL after it, and only then is it cut short at a `;` or
  // before the next statement. Doing that to ordinary SQL turns the rest of
  // a comment into code.
  const singleLine = !/[\r\n]/.test(sql.trim());

  while (i < n) {
    const c = sql[i];

    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(sql[j])) j++;
      tokens.push({ type: "ws", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if ((c === "-" && sql[i + 1] === "-") || isHashComment(sql, i)) {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\n") break;
        if (singleLine && sql[j] === ";") break;
        if (singleLine && startsBoundaryKeyword(sql, j)) break;
        j++;
      }
      // The whitespace after a comment is its own token, so that joining
      // the tokens gives back the input exactly.
      const text = sql.slice(i, j);
      const body = text.trimEnd();
      tokens.push({ type: "comment", value: body });
      if (body.length < text.length) tokens.push({ type: "ws", value: text.slice(body.length) });
      i = j;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      tokens.push({ type: "comment", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    STRING_PREFIX.lastIndex = i;
    const prefix = c === "'" ? "" : (STRING_PREFIX.exec(sql) || [null])[0];
    if (prefix !== null) {
      const quoteAt = i + prefix.length - (prefix ? 1 : 0);
      const escapes = backslashEscapes || /^[Ee]'$/.test(prefix);
      const { end, closed } = readQuoted(sql, quoteAt, "'", escapes);
      if (!closed) unterminated = true;
      tokens.push({ type: "string", value: sql.slice(i, end) });
      i = end;
      continue;
    }

    // A double-quoted identifier - or, in MySQL, a string.
    if (c === '"') {
      const { end, closed } = readQuoted(sql, i, '"', backslashEscapes);
      if (!closed) unterminated = true;
      tokens.push({ type: "ident", value: sql.slice(i, end) });
      i = end;
      continue;
    }

    if (c === "$") {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql);
      const close = tag ? sql.indexOf(tag[0], i + tag[0].length) : -1;
      if (close !== -1) {
        const end = close + tag[0].length;
        tokens.push({ type: "string", value: sql.slice(i, end) });
        i = end;
        continue;
      }
    }

    if (c === "`") {
      let j = i + 1;
      while (j < n && sql[j] !== "`") j++;
      j = Math.min(j + 1, n);
      tokens.push({ type: "ident", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (c === "[") {
      let j = i + 1;
      while (j < n && sql[j] !== "]") j++;
      j = Math.min(j + 1, n);
      tokens.push({ type: "ident", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    // `.5` is a number; the `.` in `t.col` is not.
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1]) && !followsName(sql, i))) {
      NUMBER.lastIndex = i;
      let j = i + NUMBER.exec(sql)[0].length;
      // MySQL allows a name to start with a digit (`1st_place`), so digits
      // running straight into letters are one word, not a number and a name.
      if (j < n && WORD_CHAR.test(sql[j])) {
        while (j < n && WORD_CHAR.test(sql[j])) j++;
        tokens.push({ type: "word", value: sql.slice(i, j) });
      } else {
        tokens.push({ type: "number", value: sql.slice(i, j) });
      }
      i = j;
      continue;
    }

    if ("(),;.".includes(c)) {
      tokens.push({ type: "punct", value: c });
      i++;
      continue;
    }

    const operator = OPERATORS.find(op => sql.startsWith(op, i));
    if (operator) {
      tokens.push({ type: "op", value: operator });
      i += operator.length;
      continue;
    }
    if ("=<>+-*/%&|^~".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
      continue;
    }

    // Placeholders: `?`, and `:name` (`::` and `:=` were taken above).
    if (c === "?") {
      tokens.push({ type: "param", value: c });
      i++;
      continue;
    }
    if (c === ":" && i + 1 < n && WORD_CHAR.test(sql[i + 1])) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      tokens.push({ type: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    if (WORD_START.test(c)) {
      let j = i;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      tokens.push({ type: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }

    tokens.push({ type: "punct", value: c });
    i++;
  }

  return { tokens, unterminated };
}

function tokenize(sql) {
  // used by the parser/formatter - whitespace tokens are irrelevant once
  // we're deciding statement structure, since the formatter controls all
  // spacing and line breaks itself.
  return tokenizeRaw(sql).filter(t => t.type !== "ws");
}

function isWord(tok) { return tok && tok.type === "word"; }
function lc(tok) { return isWord(tok) ? tok.value.toLowerCase() : null; }

function matchPhrase(tokens, i, phrases) {
  for (const phrase of phrases) {
    const words = phrase.split(" ");
    let ok = true;
    let ti = i;
    for (const w of words) {
      if (lc(tokens[ti]) !== w) { ok = false; break; }
      ti++;
    }
    if (ok) return { phrase, length: ti - i };
  }
  return null;
}

const SORTED_NEWLINE_PHRASES = [...ALWAYS_NEWLINE_BEFORE].sort(
  (a, b) => b.split(" ").length - a.split(" ").length
);

function splitStatements(tokens) {
  const statements = [];
  let current = [];
  let depth = 0;

  for (const tok of tokens) {
    if (tok.type === "punct" && tok.value === "(") depth++;
    if (tok.type === "punct" && tok.value === ")") depth = Math.max(0, depth - 1);

    if (tok.type === "punct" && tok.value === ";" && depth === 0) {
      current.push(tok);
      statements.push(current);
      current = [];
      continue;
    }
    current.push(tok);
  }
  if (current.length) statements.push(current);
  return statements;
}

let selectListActive = false;
let selectListDepth = 0;
let insideValuesRowList = false;
let valuesRowListDepth = 0;

// Words after which a value starts, so a `-` or `+` there is a sign.
const OPERAND_AFTER = new Set([
  "select", "where", "and", "or", "not", "case", "when", "then", "else",
  "by", "return", "like", "between", "limit", "offset", "having", "on",
  "set", "values", "in", "is", "default", "interval"
]);

// Whether the token before a `-` or `+` makes it a sign rather than
// subtraction or addition.
function startsOperand(prev) {
  if (!prev) return true;
  if (prev.type === "op") return true;
  if (prev.type === "punct") return prev.value === "(" || prev.value === ",";
  return isWord(prev) && OPERAND_AFTER.has(prev.value.toLowerCase());
}

// A name that is being declared keeps the case it was written in, even
// when it is also a keyword: the database hands it back to applications
// as written, so `SELECT 1 AS date` must still return a column `date`.
// Declared here means an alias after AS, and the name at the start of a
// column definition in CREATE TABLE or ALTER TABLE ... ADD.
const NOT_AN_ALIAS = new Set(["select", "with", "values", "begin"]);
const CAST_FUNCTIONS = new Set(["cast", "try_cast", "safe_cast"]);
const TABLE_ITEM_KEYWORDS = new Set([
  "constraint", "primary", "foreign", "unique", "check", "fulltext",
  "spatial", "like", "exclude", "period", "column"
]);

function declaresName(tokens, i, ctx, atItemStart, isAlterTable) {
  const lower = tokens[i].value.toLowerCase();
  const prev = lc(tokens[i - 1]);

  if (prev === "as") {
    return !NOT_AN_ALIAS.has(lower) && !(ctx && CAST_FUNCTIONS.has(ctx.opener));
  }

  const columnStart = (atItemStart && ctx.kind === "createTableList") ||
    (isAlterTable && (prev === "add" || (prev === "column" && lc(tokens[i - 2]) === "add")));
  if (!columnStart || TABLE_ITEM_KEYWORDS.has(lower)) return false;
  if (lower === "key" || lower === "index") return !isIndexDefinition(tokens, i);
  return true;
}

// MySQL's `KEY name (cols)` and `INDEX (cols)`, as against a column that
// happens to be called key: `key VARCHAR(10)`.
function isIndexDefinition(tokens, i) {
  const next = tokens[i + 1];
  const after = tokens[i + 2];
  const opens = (t) => t && t.type === "punct" && t.value === "(";
  if (opens(next)) return true;
  const named = next && (next.type === "ident" || (isWord(next) && !KEYWORDS.has(lc(next))));
  return Boolean(named) && opens(after);
}

function isSubqueryStart(tokens, openParenIdx) {
  let j = openParenIdx + 1;
  while (j < tokens.length && tokens[j].type === "comment") j++;
  return lc(tokens[j]) === "select" || lc(tokens[j]) === "with";
}

function formatStatement(tokens, opts) {
  const { indentSize, indentChar, upper } = opts;
  const IND = indentChar.repeat(indentSize);

  const meaningful = tokens.some(t => t.type !== "comment");
  if (!meaningful) {
    return tokens.map(t => t.value).join("\n");
  }

  let out = [];
  let indentLevel = 0;
  let clauseBaseIndent = 0;
  let i = 0;
  const n = tokens.length;

  const ctxStack = [];
  // The indent of the line each open top-level CASE started on.
  const caseIndents = [];

  let firstMeaningfulIdx = 0;
  while (firstMeaningfulIdx < tokens.length && tokens[firstMeaningfulIdx].type === "comment") {
    firstMeaningfulIdx++;
  }
  const firstWord = lc(tokens[firstMeaningfulIdx]);
  const secondWord = lc(tokens[firstMeaningfulIdx + 1]);
  // The parenthesis of CREATE TABLE that holds the columns, laid out one per
  // line: the statement's first parenthesis, if TABLE comes before it and
  // AS or SELECT does not (CREATE TABLE ... AS SELECT has no column list).
  let columnListParen = -1;
  if (firstWord === "create") {
    let sawTable = false;
    for (let k = firstMeaningfulIdx; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === "punct" && t.value === "(") {
        if (sawTable) columnListParen = k;
        break;
      }
      const w = lc(t);
      if (w === "as" || w === "select") break;
      if (w === "table") sawTable = true;
    }
  }
  const isInsert = firstWord === "insert";
  const isAlterTable = firstWord === "alter" && secondWord === "table";

  function lastNonSpaceChar() {
    for (let k = out.length - 1; k >= 0; k--) {
      const s = out[k];
      if (s.trim() === "" && !s.includes("\n")) continue;
      return s;
    }
    return "";
  }

  let justNewlined = false;

  // A statement never contains a blank line, so a line break replaces any
  // whitespace already at the end - including a line break just emitted
  // after a comment.
  function newline(extra = 0) {
    while (out.length && /^\s*$/.test(out[out.length - 1])) out.pop();
    out.push("\n" + IND.repeat(Math.max(0, indentLevel + extra)));
    justNewlined = true;
  }

  // Where a sign was just written: nothing is spaced after it.
  let signAt = -1;

  function space() {
    if (out.length === signAt) return;
    if (justNewlined) { justNewlined = false; return; }
    const last = out.length ? out[out.length - 1] : "";
    if (last.endsWith("\n") || last.endsWith(" ") || last === "") return;
    if (last.endsWith("(")) return;
    out.push(" ");
  }

  function emit(text) {
    out.push(text);
    if (text.trim() !== "") justNewlined = false;
  }

  // A clause keyword leaves a space after itself; `,` and `;` go straight
  // after the word, so `END;` rather than `END ;`.
  function unspace() {
    while (out.length && out[out.length - 1] === " ") out.pop();
  }

  function caseWord(w) {
    return upper ? w.toUpperCase() : w.toLowerCase();
  }

  while (i < n) {
    const tok = tokens[i];

    // What follows a `.` is the rest of a qualified name - `t.*`, `s."t"`,
    // `e.end` - so it gets no space, is never a clause keyword, and keeps
    // the case it was written in.
    const prev = tokens[i - 1];
    if (prev && prev.type === "punct" && prev.value === "." && tok.type !== "comment" && tok.type !== "punct") {
      emit(tok.value);
      i++;
      continue;
    }

    // Whether this token starts an item of a CREATE TABLE column list.
    const top = ctxStack[ctxStack.length - 1];
    const atItemStart = Boolean(top && top.itemStart);
    if (top && tok.type !== "comment") top.itemStart = false;

    if (tok.type === "comment") {
      if (out.length && lastNonSpaceChar() !== "") newline();
      emit(tok.value.trim());
      i++;
      if (i < n) newline();
      continue;
    }

    if (tok.type === "punct" && tok.value === "(") {
      const prevWord = lc(tokens[i - 1]);

      let kind = "exprGroup";
      let isInsertColumnList = false;

      if (i === columnListParen) {
        kind = "createTableList";
      } else if (prevWord === "values" || (insideValuesRowList && ctxStack.length === 0)) {
        kind = "valuesRow";
      } else if (isAlterTable && ctxStack.length === 0 && (prevWord === "add" || prevWord === "modify")) {
        // ALTER TABLE t ADD (a INT, b INT) - several columns at once.
        kind = "createTableList";
      } else if (isSubqueryStart(tokens, i)) {
        kind = "subquery";
      } else if (isInsert && ctxStack.length === 0 && indentLevel === 0) {
        kind = "exprGroup";
        isInsertColumnList = true;
      } else {
        kind = "exprGroup";
      }

      if (prevWord === "values") {
        insideValuesRowList = true;
        valuesRowListDepth = ctxStack.length;
        indentLevel++;
        newline();
      }

      ctxStack.push({
        kind,
        savedClauseBaseIndent: clauseBaseIndent,
        opener: prevWord, // `cast` in CAST(x AS type)
        itemStart: kind === "createTableList",
      });

      if (kind === "createTableList") {
        space();
        emit("(");
        indentLevel++;
        newline();
      } else if (kind === "valuesRow") {
        emit("(");
      } else if (kind === "subquery") {
        const spaceBeforeWords = new Set(["key", "references", "in", "not", "exists", "as"]);
        if (spaceBeforeWords.has(prevWord)) space();
        emit("(");
        indentLevel++;
        clauseBaseIndent = indentLevel;
        newline();
      } else {
        const spaceBeforeWords = new Set(["key", "references", "in", "not", "exists", "as"]);
        if (isInsertColumnList || spaceBeforeWords.has(prevWord)) space();
        emit("(");
      }
      i++;
      continue;
    }

    if (tok.type === "punct" && tok.value === ")") {
      const ctx = ctxStack.pop() || { kind: "exprGroup" };
      if (ctx.kind === "createTableList" || ctx.kind === "subquery") {
        indentLevel = Math.max(0, indentLevel - 1);
        newline();
        emit(")");
      } else {
        emit(")");
      }
      if (ctx.savedClauseBaseIndent !== undefined) {
        clauseBaseIndent = ctx.savedClauseBaseIndent;
      }
      if (ctx.kind === "valuesRow" && insideValuesRowList && ctxStack.length === valuesRowListDepth) {
        const next = tokens[i + 1];
        const isAnotherRow = next && next.type === "punct" && next.value === ",";
        if (!isAnotherRow) {
          insideValuesRowList = false;
          indentLevel = Math.max(0, indentLevel - 1);
        }
      }
      i++;
      continue;
    }

    if (tok.type === "punct" && tok.value === ",") {
      unspace();
      const ctx = ctxStack[ctxStack.length - 1];
      if (!ctx) {
        if (insideValuesRowList) {
          emit(",");
          newline();
        } else if (selectListActive && ctxStack.length === selectListDepth) {
          emit(",");
          newline();
        } else {
          emit(",");
          space();
        }
        i++;
        continue;
      }
      if (ctx.kind === "createTableList") {
        emit(",");
        newline();
        ctx.itemStart = true;
      } else if (ctx.kind === "valuesRow") {
        emit(",");
        space();
      } else {
        emit(",");
        if (selectListActive && ctxStack.length === selectListDepth) {
          newline();
        } else {
          space();
        }
      }
      i++;
      continue;
    }

    if (tok.type === "punct" && tok.value === ";") {
      unspace();
      emit(";");
      i++;
      continue;
    }

    if (tok.type === "punct" && tok.value === ".") {
      emit(".");
      i++;
      continue;
    }

    if (isWord(tok)) {
      const lower = tok.value.toLowerCase();

      if (declaresName(tokens, i, top, atItemStart, isAlterTable)) {
        space();
        emit(tok.value);
        i++;
        continue;
      }

      const phraseMatch = matchPhrase(tokens, i, SORTED_NEWLINE_PHRASES);

      if (phraseMatch && ctxStack.length === 0) {
        // The WHEN, THEN and ELSE of a CASE sit one level inside the line
        // the CASE is on, and its END goes back to that line, so whatever
        // follows the END keeps that line's indent.
        const inCase = caseIndents.length > 0 && ["when", "then", "else", "end"].includes(phraseMatch.phrase);
        if (inCase) {
          const caseIndent = caseIndents[caseIndents.length - 1];
          indentLevel = phraseMatch.phrase === "end" ? caseIndents.pop() : caseIndent + 1;
        } else {
          indentLevel = clauseBaseIndent;
        }
        if (out.length) newline();
        const words = phraseMatch.phrase.split(" ");
        const rendered = words
          .map((w, idx) => {
            const t = tokens[i + idx];
            return KEYWORDS.has(w) ? caseWord(t.value) : t.value;
          })
          .join(" ");
        emit(rendered);
        i += phraseMatch.length;

        if (["select","group by","order by"].includes(phraseMatch.phrase)) {
          selectListActive = true;
          selectListDepth = ctxStack.length;
          indentLevel = clauseBaseIndent + 1;
          newline();
        } else if (phraseMatch.phrase === "from" || phraseMatch.phrase === "where" ||
                   phraseMatch.phrase === "having" || phraseMatch.phrase === "values" ||
                   phraseMatch.phrase === "set" || phraseMatch.phrase.includes("join") ||
                   phraseMatch.phrase === "on" || phraseMatch.phrase === "limit" ||
                   phraseMatch.phrase === "offset" || phraseMatch.phrase === "union" ||
                   phraseMatch.phrase === "union all") {
          selectListActive = false;
          indentLevel = clauseBaseIndent;
          space();
        } else {
          space();
        }
        continue;
      }

      // `END CASE` closes a CASE statement in a procedure; it opens nothing.
      if (lower === "case" && ctxStack.length === 0 && lc(tokens[i - 1]) !== "end") {
        caseIndents.push(indentLevel);
      }

      const rendered = KEYWORDS.has(lower) ? caseWord(tok.value) : tok.value;
      space();
      emit(rendered);
      i++;
      continue;
    }

    if (tok.type === "string") {
      space();
      emit(tok.value);
      i++;
      continue;
    }

    if (tok.type === "ident") {
      space();
      emit(tok.value);
      i++;
      continue;
    }

    if (tok.type === "number" || tok.type === "param") {
      space();
      emit(tok.value);
      i++;
      continue;
    }

    if (tok.type === "op") {
      space();
      emit(tok.value);
      // A sign - `-1`, `a * -b`, `(1, -5.5)` - stays against what it signs.
      // Never against another operator: `- -1` must not become `--1`.
      const next = tokens[i + 1];
      if ((tok.value === "-" || tok.value === "+") && startsOperand(tokens[i - 1]) && next &&
          (["number", "word", "ident", "param", "string"].includes(next.type) ||
           (next.type === "punct" && next.value === "("))) {
        signAt = out.length;
      }
      i++;
      continue;
    }

    emit(tok.value);
    i++;
  }

  return out.join("");
}

function formatSQL(sql, options = {}) {
  const opts = {
    indentSize: options.indentSize ?? 4,
    indentChar: options.indentChar ?? " ",
    upper: options.upper ?? true,
    blankLinesBetween: options.blankLinesBetween ?? 1,
  };

  const tokens = tokenize(sql);
  const statementsTokens = splitStatements(tokens);

  const blocks = [];
  for (const stmtTokens of statementsTokens) {
    selectListActive = false;
    selectListDepth = 0;
    insideValuesRowList = false;
    valuesRowListDepth = 0;

    const text = formatStatement(stmtTokens, opts);
    blocks.push(text.trim());
  }

  const sep = "\n".repeat(Math.max(0, opts.blankLinesBetween) + 1);
  return blocks
    .filter(t => t.length > 0)
    .join(sep) + "\n";
}
