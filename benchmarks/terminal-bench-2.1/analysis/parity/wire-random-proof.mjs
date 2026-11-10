// Proof that `Sec-WebSocket-Key` is the only value that varies between two Node recordings of the same inputs.
// Usage: node wire-random-proof.mjs <node-tree> --node-commit <sha> [--dir <scratch dir>]
// Records twice with the key kept, walks both documents and fails unless every leaf that differs is the value of a
// `Sec-WebSocket-Key` header of a ws-upgrade event, and at least one does (otherwise nothing proves the key is random).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tree = process.argv[2];
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const commit = arg('--node-commit');
const dir = process.argv.includes('--dir') ? resolve(arg('--dir')) : join(process.env.TEMP ?? '.', 'wire-random-proof');
mkdirSync(dir, { recursive: true });

const record = (name) => {
  const out = join(dir, name);
  const run = spawnSync(process.execPath, [join(here, 'node-wire-capture.mjs'), tree, '--node-commit', commit, '--session', join(here, 'fixtures/session.json'), '--scenarios', join(here, 'scenarios.json'), '--out', out, '--keep-random'], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error(`recording ${name} failed with status ${run.status}`);
  return JSON.parse(readFileSync(out, 'utf8'));
};

const first = record('run-a.json');
const second = record('run-b.json');
const differing = [];
const walk = (a, b, path) => {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) walk(a[key], b[key], [...path, key]);
  } else if (a !== b) {
    differing.push(path);
  }
};
walk(first, second, []);

const isKey = (path) => {
  // scenarios[i].traffic[j].headers[k][1] where headers[k][0] names Sec-WebSocket-Key
  let pair = first;
  for (const step of path.slice(0, -1)) pair = pair?.[step];
  return path.at(-1) === '1' && path.at(-3) === 'headers' && pair?.[0]?.toLowerCase() === 'sec-websocket-key';
};
const stray = differing.filter((path) => !isKey(path));
if (stray.length) throw new Error(`two recordings differ beyond Sec-WebSocket-Key at: ${stray.map((p) => p.join('.')).join(', ')}`);
if (!differing.length) throw new Error('the two recordings are identical: Sec-WebSocket-Key was not observed to vary');
console.log(`two runs differ in ${differing.length} value(s), all Sec-WebSocket-Key`);
