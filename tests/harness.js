"use strict";

// Loads js/parser.js the way index.html does -- as a classic script, into one
// global scope -- and hands back the functions it declares.
//
// parser.js exports nothing: the page reaches formatSQL and tokenizeRaw as
// globals. Running it in a node:vm context gives the tests the same globals
// without changing how the page loads it.
//
// `loadParser()` reads the working tree. `loadOriginal()` reads the same file
// out of the baseline commit, so a regression test can assert that a bug is
// present before the fix and absent after it, in the same run, against the
// real file rather than a transcription of it.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PARSER = path.join(ROOT, "js", "parser.js");

// The commit that holds the code exactly as it was found. Looked up by subject
// so the harness survives a rebuilt branch, and so a missing baseline fails
// loudly instead of silently testing the fixed code twice.
const BASELINE_SUBJECT = "Initial commit";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

let baselineSha = null;
function baselineCommit() {
  if (baselineSha) return baselineSha;
  const line = git(["log", "--all", "--format=%H %s"])
    .split("\n")
    .find((l) => l.slice(41).trim() === BASELINE_SUBJECT);
  if (!line) throw new Error(`baseline commit "${BASELINE_SUBJECT}" not found in this repository`);
  baselineSha = line.slice(0, 40);
  return baselineSha;
}

function load(source, filename) {
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx, { filename });
  // Top-level `const`s live in the context's lexical scope, not on the
  // context object, so read everything by evaluating its name.
  const get = (name) => vm.runInContext(name, ctx);
  return {
    formatSQL: get("formatSQL"),
    tokenizeRaw: get("tokenizeRaw"),
    tokenize: get("tokenize"),
    KEYWORDS: get("KEYWORDS"),
    source,
  };
}

let current = null;
function loadParser() {
  if (!current) current = load(fs.readFileSync(PARSER, "utf8"), PARSER);
  return current;
}

let original = null;
function loadOriginal() {
  if (!original) {
    const sha = baselineCommit();
    original = load(git(["show", `${sha}:js/parser.js`]), `${sha.slice(0, 7)}:js/parser.js`);
  }
  return original;
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

module.exports = { ROOT, loadParser, loadOriginal, baselineCommit, fixture };
