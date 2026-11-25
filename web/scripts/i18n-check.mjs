#!/usr/bin/env node
/**
 * Lists every t('…') / tn('…', '…') source string in src/ and checks each locale catalog.
 *   node scripts/i18n-check.mjs            → report, exit 1 if anything is missing
 *   node scripts/i18n-check.mjs --keys     → print all keys (one JSON array) for translators
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name)) files.push(p); } })(root);

const lit = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60((?:[^\x60\\$]|\\.)*)\x60)`;
const reT = new RegExp(String.raw`\bt[k]?\(\s*${lit}`, 'g');
const reTn = new RegExp(String.raw`\btn\(\s*${lit}\s*,\s*${lit}`, 'g');
const unescape = (s) => s.replace(/\\(['"\x60\\])/g, '$1').replace(/\\n/g, '\n');
const keys = new Map();
for (const f of files) {
  // ignore comments (doc examples), keep string contents intact
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of src.matchAll(reT)) keys.set(unescape(m[1] ?? m[2] ?? m[3]), path.relative(root, f));
  for (const m of src.matchAll(reTn)) { keys.set(unescape(m[1] ?? m[2] ?? m[3]), path.relative(root, f)); keys.set(unescape(m[4] ?? m[5] ?? m[6]), path.relative(root, f)); }
}
if (process.argv.includes('--keys')) { console.log(JSON.stringify([...keys.keys()].sort(), null, 1)); process.exit(0); }

let missingTotal = 0;
for (const lang of fs.readdirSync(path.join(root, 'locales')).filter((f) => f.endsWith('.json'))) {
  const cat = JSON.parse(fs.readFileSync(path.join(root, 'locales', lang), 'utf8'));
  const missing = [...keys.keys()].filter((k) => !(k in cat));
  const unused = Object.keys(cat).filter((k) => !keys.has(k));
  const badVars = [...keys.keys()].filter((k) => k in cat && JSON.stringify((k.match(/\{\w+\}/g) ?? []).sort()) !== JSON.stringify((cat[k].match(/\{\w+\}/g) ?? []).sort()));
  missingTotal += missing.length + badVars.length;
  console.log(`${lang}: ${keys.size - missing.length}/${keys.size} translated${unused.length ? `, ${unused.length} unused` : ''}${badVars.length ? `, ${badVars.length} with mismatched {placeholders}` : ''}`);
  for (const k of missing.slice(0, 15)) console.log(`   missing: ${JSON.stringify(k)}  (${keys.get(k)})`);
  if (missing.length > 15) console.log(`   … ${missing.length - 15} more`);
  for (const k of badVars.slice(0, 10)) console.log(`   placeholders differ: ${JSON.stringify(k)}`);
}
process.exit(missingTotal ? 1 : 0);
