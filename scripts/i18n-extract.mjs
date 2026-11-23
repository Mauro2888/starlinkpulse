#!/usr/bin/env node
// Collects translation keys from src (t("…"), tk("…"), tr("…") with literal strings),
// updates src/locales/en.json (English source = key; plural keys get _one/_other),
// and reports keys missing from or extra in it.json.
// Usage: node scripts/i18n-extract.mjs [--check]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const EN = join(SRC, "locales/en.json");
const IT = join(SRC, "locales/it.json");
const check = process.argv.includes("--check");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "mock" || name === "locales" || name === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const CALL = /\b(?:t|tk|tr)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const keys = new Set();
const plurals = new Set();
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(CALL)) {
    const raw = m[2];
    if (m[1] === "`" && raw.includes("${")) continue; // dynamic, not a key
    const key = raw.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
    // Options object right after the key: plural if it has `count`.
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 160);
    const opts = /^\s*,\s*\{([^}]*)\}/.exec(tail);
    if (opts && /\bcount\b/.test(opts[1])) plurals.add(key);
    else keys.add(key);
  }
}

const en = JSON.parse(readFileSync(EN, "utf8"));
const it = JSON.parse(readFileSync(IT, "utf8"));
const wanted = new Map();
for (const k of keys) wanted.set(k, en[k] ?? k);
for (const k of plurals) {
  wanted.set(`${k}_one`, en[`${k}_one`] ?? k);
  wanted.set(`${k}_other`, en[`${k}_other`] ?? k);
}
const sorted = Object.fromEntries([...wanted.entries()].sort(([a], [b]) => a.localeCompare(b)));

const missingIt = Object.keys(sorted).filter((k) => !(k in it));
const extraIt = Object.keys(it).filter((k) => !(k in sorted));
const changedEn = JSON.stringify(sorted) !== JSON.stringify(en);

if (check) {
  if (changedEn || missingIt.length || extraIt.length) {
    console.error(`en.json out of date: ${changedEn}; missing in it.json: ${missingIt.length}; extra in it.json: ${extraIt.length}`);
    for (const k of missingIt) console.error(`  missing it: ${JSON.stringify(k)}`);
    for (const k of extraIt) console.error(`  extra it: ${JSON.stringify(k)}`);
    process.exit(1);
  }
  console.log(`i18n OK: ${Object.keys(sorted).length} keys`);
} else {
  writeFileSync(EN, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`en.json: ${Object.keys(sorted).length} keys (${plurals.size} plural)`);
  if (missingIt.length) console.log(`it.json missing ${missingIt.length} keys`);
  if (extraIt.length) console.log(`it.json has ${extraIt.length} stale keys: ${extraIt.map((k) => JSON.stringify(k)).join(", ")}`);
}
