#!/usr/bin/env node
// Finds values a recorder passed through `exact` twice. `exact` writes an object that has its own "$exact" key as
// {"$exact": "object", "entries": [...]}; when the entries hold a "$exact" key whose value is one of exact's own tag
// kinds, the object was a tag `exact` had already produced: Node had no such object, the recorder encoded a value
// that was already encoded.
//
//   node benchmarks/rust-core/recorders/scan-double-exact.mjs [fixturesRoot]
// Scans every JSON file of every fixture set whose MANIFEST.json says its values are `exact`; prints one line per hit
// (set, file, JSON path, the tag kind) and exits 1 when there is any.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT } from './lib/common.mjs';

const KINDS = new Set(['undefined', 'NaN', 'Infinity', '-Infinity', '-0', 'hole', 'bigint', 'date', 'bytes', 'map', 'set', 'error', 'object']);
const root = process.argv[2] ?? FIXTURES_ROOT;

const hits = [];
const walk = (value, path, at) => {
  if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${path}[${i}]`, at));
  if (!value || typeof value !== 'object') return;
  if (value.$exact === 'object' && Array.isArray(value.entries)) {
    const inner = value.entries.find((entry) => Array.isArray(entry) && entry[0] === '$exact');
    if (inner && typeof inner[1] === 'string' && KINDS.has(inner[1])) hits.push(`${at} ${path} ${inner[1]}`);
  }
  for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, at);
};

const jsonFiles = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
  const sub = rel ? `${rel}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return jsonFiles(dir, sub);
  return entry.name.endsWith('.json') && entry.name !== 'MANIFEST.json' ? [sub] : [];
});

const sets = [];
for (const set of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
  const manifest = join(root, set, 'MANIFEST.json');
  if (!existsSync(manifest)) continue;
  if (!String(JSON.parse(readFileSync(manifest, 'utf8')).values ?? '').startsWith('exact')) continue;
  sets.push(set);
  for (const file of jsonFiles(join(root, set))) walk(JSON.parse(readFileSync(join(root, set, file), 'utf8')), '$', `${set}/${file}`);
}
console.log(`${sets.length} exact sets scanned: ${sets.join(' ')}`);
for (const hit of hits) console.log(hit);
console.log(`${hits.length} hit(s)`);
process.exitCode = hits.length ? 1 : 0;
