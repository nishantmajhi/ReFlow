/*
 * Opens the real page in real headless Chrome and checks that it formats
 * exactly what the Node tests say it formats.
 *
 * `npm test` runs js/parser.js and js/script.js in a node:vm context. What
 * that cannot show is the browser agreeing: the tokenizer now depends on
 * Unicode property escapes (\p{L}, \p{M}) and sticky regular expressions,
 * and the page reads its result back through the output pane's real
 * textContent, which is what Copy copies.
 *
 * The page is staged in a temporary directory with two script tags appended:
 * cases.js (the inputs) and driver.js, which types each input into the real
 * textarea, calls the page's own runFormat(), and writes what the output
 * pane says into a <div> that --dump-dom brings back. Node then formats the
 * same inputs and compares.
 *
 * With no browser installed this exits 0 and says SKIP.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadParser, fixture } = require("../harness.js");

const ROOT = path.join(__dirname, "..", "..");

const CANDIDATES = [
  process.env.REFLOW_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

// One input per thing the tokenizer had to learn, plus the headline case.
const CASES = {
  "Devanagari alias": "select a नाम, prénom from t;",
  "mysqldump escapes": "INSERT INTO `people` VALUES (1,'O\\'Connor','Sam\\'s  dog'),(2,'plain','x');",
  "dollar quotes": "select $$two  spaces$$, $tag$a ; b$tag$ from t;",
  numbers: "select 1e5, 0x1F, .5, -3, X'41' as blob from t;",
  operators: "select data->>'a', b <=> c, d << 2, :name, ? from t where e @> '{x}';",
  "# comments": "# select nothing\nselect a from #temp;",
  "comment with a semicolon": "delete from t -- careful; old rows only\nwhere created < '2020';",
  "CASE in a select list": "select id, case when a then 1 else 2 end as k, b from t;",
  "markup in a string": "select '<b>&amp;</b>' from t where a < b;",
  "the DDL fixture, on one line": fixture("DDL.sql"),
};

const DRIVER = `
(function () {
  var results = [];
  function read(name) {
    results.push({ name: name, text: document.getElementById("output").textContent });
  }
  read("the sample loaded on start");
  var cases = window.__cases;
  Object.keys(cases).forEach(function (name) {
    document.getElementById("input").value = cases[name];
    runFormat();
    read(name);
  });
  var div = document.createElement("div");
  div.id = "test-results";
  div.textContent = JSON.stringify(results);
  document.body.appendChild(div);
})();
`;

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflow-browser-"));
  for (const sub of ["js", "css"]) {
    fs.mkdirSync(path.join(dir, sub));
    for (const name of fs.readdirSync(path.join(ROOT, sub))) {
      fs.copyFileSync(path.join(ROOT, sub, name), path.join(dir, sub, name));
    }
  }
  fs.writeFileSync(path.join(dir, "cases.js"), "window.__cases = " + JSON.stringify(CASES) + ";\n", "utf8");
  fs.writeFileSync(path.join(dir, "driver.js"), DRIVER, "utf8");

  const original = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const appended = '\n<script src="cases.js"></script>\n<script src="driver.js"></script>\n';
  fs.writeFileSync(path.join(dir, "index.html"), original + appended, "utf8");
  return dir;
}

function run(browser, dir) {
  const result = spawnSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      "--user-data-dir=" + path.join(dir, "profile"),
      "--virtual-time-budget=10000",
      "--dump-dom",
      "file:///" + path.join(dir, "index.html").replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  );
  if (result.error) throw result.error;
  const dom = result.stdout || "";
  const match = dom.match(/<div id="test-results">([\s\S]*?)<\/div>/);
  if (!match) {
    throw new Error(
      "the page produced no results, so a script failed to load or threw. Last of the DOM:\n" +
        dom.slice(-1500) +
        "\n--- stderr ---\n" +
        (result.stderr || "").slice(-1500),
    );
  }
  const decoded = match[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return JSON.parse(decoded);
}

function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log("SKIP: no Chrome or Edge found. Set REFLOW_BROWSER to one.");
    return 0;
  }
  console.log("browser: " + browser);

  const { formatSQL } = loadParser();
  const sample = JSON.parse(
    fs.readFileSync(path.join(ROOT, "js", "script.js"), "utf8").match(/const SAMPLE_DDL = (".*");/)[1],
  );
  const expected = { "the sample loaded on start": formatSQL(sample) };
  for (const [name, sql] of Object.entries(CASES)) expected[name] = formatSQL(sql);

  // The staging directory holds a Chrome profile, about 11 MB; remove it.
  const dir = stage();
  let results;
  try {
    results = run(browser, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  let failed = 0;
  for (const r of results) {
    if (r.text === expected[r.name]) {
      console.log("  ok   " + r.name);
    } else {
      failed++;
      console.log("  FAIL " + r.name + "\n  browser: " + JSON.stringify(r.text) + "\n  node:    " + JSON.stringify(expected[r.name]));
    }
  }
  if (results.length !== Object.keys(expected).length) {
    failed++;
    console.log("  FAIL expected " + Object.keys(expected).length + " results, got " + results.length);
  }
  console.log(failed === 0 ? `\nbrowser: all ${results.length} checks passed` : `\nbrowser: ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
