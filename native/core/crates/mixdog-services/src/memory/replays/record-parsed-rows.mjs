// Records what the TUI's `parseMemoryCoreRows` (src/tui/app/input-parsers.mjs of the Node tree) answers for the list texts
// the memory-core-index and memory-core-management recordings hold, into `parsed_rows.json` next to the replays that read it.
// The Node TUI is not part of this tree, so the replays read this file instead of running the parser.
//
//   node record-parsed-rows.mjs <node tree root> [<fixtures dir> [<exact.mjs>]]
//
// <fixtures dir> defaults to native/core/fixtures and <exact.mjs> to benchmarks/rust-core/recorders/lib/exact.mjs of the
// repository this script is in. Each text is recorded with its UUIDs renamed `<uuid-1>`, `<uuid-2>`... by first appearance
// in that text, which is how the replay looks it up (the replay's own UUIDs are real ones).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../../../../..');
const [treeRoot, fixtures = path.join(repo, 'native/core/fixtures'), exactPath = path.join(repo, 'benchmarks/rust-core/recorders/lib/exact.mjs')] = process.argv.slice(2);
if (!treeRoot) throw new Error('usage: node record-parsed-rows.mjs <node tree root> [<fixtures dir> [<exact.mjs>]]');

const { parseMemoryCoreRows } = await import(pathToFileURL(path.join(treeRoot, 'src/tui/app/input-parsers.mjs')).href);
const { exact } = await import(pathToFileURL(exactPath).href);

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|<uuid-\d+>/g;
const renamed = (text) => {
  const seen = [];
  return text.replace(uuid, (u) => {
    if (!seen.includes(u)) seen.push(u);
    return `<uuid-${seen.indexOf(u) + 1}>`;
  });
};

const texts = new Set();
const collect = (value) => {
  if (!value || typeof value !== 'object') return;
  if (typeof value.formatted === 'string' && value.roundTrip) texts.add(renamed(value.formatted));
  for (const child of Object.values(value)) collect(child);
};
for (const set of ['memory-core-index', 'memory-core-management']) {
  collect(JSON.parse(readFileSync(path.join(fixtures, set, 'golden.json'), 'utf8')));
}

const rows = [...texts].map((text) => ({ text, parsed: exact(parseMemoryCoreRows(text)) }));
writeFileSync(path.join(here, 'parsed_rows.json'), `${JSON.stringify(rows, null, 1)}\n`);
console.log(`${rows.length} texts recorded`);
