/* ============================================================
   UI WIRING
   ============================================================ */

const SAMPLE_DDL = "-- ==================================================== -- Schema: simple e-commerce orders -- ====================================================  create table CUSTOMERS (     customer_id   int           not null auto_increment,     full_name     varchar(120)  not null,     email         varchar(150)  not null,     constraint pk_customers primary key (customer_id) );  create table ORDERS (     order_id      int           not null auto_increment,     customer_id   int           not null,     order_date    date          not null,     status        varchar(20)   not null default 'pending',     constraint pk_orders primary key (order_id),     constraint fk_orders_customer foreign key (customer_id) references CUSTOMERS (customer_id) );  -- seed a few rows so the table isn't empty on first run insert into CUSTOMERS (full_name, email) values ('Jordan Reyes', 'jordan@example.com'), ('Priya Nair', 'priya@example.com'), ('Sam O''Connor', 'sam@example.com');  select o.order_id, c.full_name, o.status from ORDERS o inner join CUSTOMERS c on o.customer_id = c.customer_id where o.status = 'pending' order by o.order_date desc;";

const state = {
  upper: true,
  indentChar: " ",
  indentSize: 4,
  blankLines: 1
};

const input = document.getElementById('input');
const output = document.getElementById('output');
const beforeMeta = document.getElementById('beforeMeta');
const afterMeta = document.getElementById('afterMeta');
const anatomy = document.getElementById('anatomy');
const anatomyBody = document.getElementById('anatomyBody');

function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function highlight(code){
  // light, display-only highlighting on top of the already-formatted text.
  // Must NOT use tokenize() here - that function strips whitespace tokens
  // (correct for parsing input, wrong for re-displaying formatted output,
  // since it would collapse every line back onto one line).
  const tokens = tokenizeRaw(code);
  let html = '';
  for (const t of tokens){
    const esc = escapeHtml(t.value);
    if (t.type === 'ws') html += esc;
    else if (t.type === 'comment') html += '<span class="com">' + esc + '</span>';
    else if (t.type === 'string') html += '<span class="str">' + esc + '</span>';
    else if (t.type === 'number') html += '<span class="num">' + esc + '</span>';
    else if (t.type === 'word' && KEYWORDS.has(t.value.toLowerCase())) html += '<span class="kw">' + esc + '</span>';
    else html += esc;
  }
  return html;
}

function countLines(s){
  if (!s.trim()) return 0;
  return s.split('\n').length;
}

function runFormat(){
  const raw = input.value;
  beforeMeta.textContent = countLines(raw) + (countLines(raw) === 1 ? ' line' : ' lines');

  if (!raw.trim()){
    output.innerHTML = '';
    afterMeta.textContent = '0 lines';
    anatomy.classList.remove('show');
    return;
  }

  let formatted;
  try {
    formatted = formatSQL(raw, {
      indentSize: state.indentSize,
      indentChar: state.indentChar,
      upper: state.upper,
      blankLinesBetween: state.blankLines
    });
  } catch (e){
    output.textContent = 'Could not format this input - ' + e.message;
    afterMeta.textContent = 'error';
    return;
  }

  output.innerHTML = highlight(formatted);
  const lineCount = countLines(formatted);
  afterMeta.innerHTML = '<b>' + lineCount + '</b>' + (lineCount === 1 ? ' line' : ' lines');

  showAnatomy(raw);
}

function showAnatomy(raw){
  const lower = raw.toLowerCase();
  let msg = null;

  if (countLines(raw) <= 2 && raw.length > 300){
    if (lower.includes('values') && lower.includes('insert')){
      msg = 'This came in as one line with a multi-row <code>VALUES</code> list. Reflow found the table-name boundary, then split each <code>(...)</code> row onto its own line rather than treating the whole list as one long expression.';
    } else if (lower.includes('create table')){
      msg = 'This came in as one line. Reflow located each <code>CREATE TABLE (...)</code> body, broke the column and constraint definitions one per line, and kept the trailing <code>--</code> comments from swallowing the SQL that followed them.';
    } else {
      msg = 'This came in as one physical line. Reflow tokenized it - strings, comments, parentheses, keywords - rather than splitting on character patterns, so it could tell where one statement ends and the next begins even with zero real newlines to go on.';
    }
  }

  if (msg){
    anatomyBody.innerHTML = msg;
    anatomy.classList.add('show');
  } else {
    anatomy.classList.remove('show');
  }
}

// case toggle
document.getElementById('caseToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.upper = btn.dataset.case === 'upper';
  document.querySelectorAll('#caseToggle button').forEach(b => b.classList.toggle('active', b === btn));
  runFormat();
});

// indent char seg
document.getElementById('indentCharSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.indentChar = btn.dataset.char === 'tab' ? '\t' : ' ';
  document.querySelectorAll('#indentCharSeg button').forEach(b => b.classList.toggle('active', b === btn));
  runFormat();
});

// indent size stepper
const indentSizeValue = document.getElementById('indentSizeValue');
document.getElementById('indentSizeStepper').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const dir = parseInt(btn.dataset.dir, 10);
  state.indentSize = Math.max(0, Math.min(8, state.indentSize + dir));
  indentSizeValue.textContent = state.indentSize;
  runFormat();
});

// blank lines stepper
const blankLinesValue = document.getElementById('blankLinesValue');
document.getElementById('blankLinesStepper').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const dir = parseInt(btn.dataset.dir, 10);
  state.blankLines = Math.max(0, Math.min(5, state.blankLines + dir));
  blankLinesValue.textContent = state.blankLines;
  runFormat();
});

document.getElementById('formatBtn').addEventListener('click', runFormat);

document.getElementById('copyBtn').addEventListener('click', () => {
  const text = output.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copyBtn');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = original; }, 1400);
  });
});

// format on type, lightly debounced
let debounceTimer;
input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runFormat, 220);
});

// seed with the sample that started this whole thing
input.value = SAMPLE_DDL;
runFormat();
