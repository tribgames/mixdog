#!/usr/bin/env node
// Golden twin of the media model catalog loader: Node's real `createMediaModelLoader`
// (catalog.mjs) over a scripted source (credential keys, revisions, fetch results), an
// in-memory cache and a scripted clock. Records, step by step, what each load answered (rows,
// the stale-catalog warning, or the failure's code), how many provider requests were made and
// what was saved. Rust `media::loader` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-media-loader.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-loader-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
const tree = resolveTree(parseArgs());
const { createMediaModelLoader } = await importFrom(tree, 'src/runtime/media/catalog.mjs');

const rows = (...ids) => ids.map((id) => ({ id }));
// Lane -> credential: its cache key, its revision, whether it has a cache of its own.
const TARGETS = {
  a: { key: 'a-key', revision: 'r1' },
  b: { key: 'b-key', revision: 'r1' },
  c: { key: 'c-key', revision: 'r1' },
  d: { key: 'd-key', revision: 'r1' },
  f: { key: 'f-key', revision: 'r1', cache: false },
  e: { error: { code: 'MEDIA_LANE_UNAUTHENTICATED' } },
};
const STEPS = [
  { op: 'script', lane: 'a', results: [{ rows: rows('x') }] },
  { op: 'load', lane: 'a' },
  { op: 'load', lane: 'a' },
  { op: 'expire', key: 'a-key' },
  { op: 'script', lane: 'a', results: [{ error: { code: 'MEDIA_CATALOG_TIMEOUT' } }] },
  { op: 'load', lane: 'a' },
  { op: 'load', lane: 'a' },
  { op: 'tick', ms: 59_999 },
  { op: 'load', lane: 'a' },
  { op: 'tick', ms: 2 },
  { op: 'script', lane: 'a', results: [{ rows: rows('y', 'z') }] },
  { op: 'load', lane: 'a' },
  { op: 'load', lane: 'a' },
  { op: 'expire', key: 'a-key' },
  { op: 'script', lane: 'a', results: [{ error: { code: 'MEDIA_AUTH_REJECTED' } }] },
  { op: 'load', lane: 'a' },
  { op: 'script', lane: 'a', results: [{ error: { code: 'MEDIA_ACCESS_DENIED' } }] },
  { op: 'load', lane: 'a' },
  { op: 'script', lane: 'a', results: [{ error: { code: 'MEDIA_BILLING_BLOCKED' } }] },
  { op: 'load', lane: 'a' },
  { op: 'script', lane: 'a', results: [{ error: { name: 'TimeoutError' } }] },
  { op: 'load', lane: 'a' },
  { op: 'tick', ms: 61_000 },
  { op: 'script', lane: 'a', results: [{ error: { code: 'MEDIA_RATE_LIMITED' } }] },
  { op: 'load', lane: 'a' },
  { op: 'unexpire', key: 'a-key' },
  { op: 'load', lane: 'a' },
  { op: 'revision', lane: 'a', revision: 'r2' },
  { op: 'script', lane: 'a', results: [{ rows: rows('w') }] },
  { op: 'load', lane: 'a' },
  { op: 'load', lane: 'a' },
  { op: 'expire', key: 'a-key' },
  { op: 'script', lane: 'a', results: [{ error: { code: 'MEDIA_CATALOG_UNAVAILABLE' } }] },
  { op: 'load', lane: 'a' },
  { op: 'revision', lane: 'a', revision: 'r3' },
  { op: 'script', lane: 'a', results: [{ rows: rows('v') }] },
  { op: 'load', lane: 'a' },
  { op: 'script', lane: 'b', results: [{ error: { message: 'down' } }] },
  { op: 'load', lane: 'b' },
  { op: 'script', lane: 'b', results: [{ rows: [] }] },
  { op: 'load', lane: 'b' },
  { op: 'expire', key: 'b-key' },
  { op: 'script', lane: 'b', results: [{ error: { message: 'down' } }] },
  { op: 'load', lane: 'b' },
  { op: 'script', lane: 'c', results: [{ rows: rows('c1') }] },
  { op: 'load-many', lane: 'c', count: 3 },
  { op: 'script', lane: 'd', results: [{ notArray: true }] },
  { op: 'load', lane: 'd' },
  { op: 'script', lane: 'd', results: [{ rows: rows('d1') }] },
  { op: 'expire', key: 'd-key' },
  { op: 'script', lane: 'd', results: [{ notArray: true }] },
  { op: 'load', lane: 'd' },
  { op: 'load', lane: 'e' },
  { op: 'script', lane: 'f', results: [{ rows: rows('f1') }, { rows: rows('f2') }, { error: { code: 'MEDIA_CATALOG_TIMEOUT' } }] },
  { op: 'load', lane: 'f' },
  { op: 'load', lane: 'f' },
  { op: 'load', lane: 'f' },
];

let clock = 1_700_000_000_000;
const targets = structuredClone(TARGETS);
const scripts = {};
const memory = new Map();
const expired = new Set();
const fetches = [];
const saves = [];
const failure = (spec) => Object.assign(new Error(spec.message ?? 'provider failed'), spec.code ? { code: spec.code } : {}, spec.name ? { name: spec.name } : {});

const loader = createMediaModelLoader({
  now: () => clock,
  source: async (lane) => {
    const target = targets[lane];
    if (target.error) throw failure(target.error);
    return {
      key: target.key,
      revision: target.revision,
      ...(target.cache === false ? { cache: false } : {}),
      fetchModels: async () => {
        fetches.push(lane);
        const next = scripts[lane].shift();
        if (!next) throw new Error('the script ran out');
        if (next.error) throw failure(next.error);
        return next.notArray ? { not: 'an array' } : structuredClone(next.rows);
      },
    };
  },
  cache: (key, stale = false) => ({
    loadSync: () => (stale || !expired.has(key) ? structuredClone(memory.get(key)) : undefined),
    save: (rowsToSave) => {
      saves.push(key);
      expired.delete(key);
      memory.set(key, structuredClone(rowsToSave));
    },
  }),
});

const outcome = async (lane) => {
  try {
    const got = await loader(lane);
    return { rows: [...got], warning: got.catalogWarning ?? null };
  } catch (error) {
    return { error: { code: error.code ?? null, timedOut: error.name === 'TimeoutError' } };
  }
};

const results = [];
for (const step of STEPS) {
  let result = null;
  if (step.op === 'script') scripts[step.lane] = structuredClone(step.results);
  else if (step.op === 'load') result = await outcome(step.lane);
  else if (step.op === 'load-many') result = await Promise.all(Array.from({ length: step.count }, () => outcome(step.lane)));
  else if (step.op === 'tick') clock += step.ms;
  else if (step.op === 'expire') expired.add(step.key);
  else if (step.op === 'unexpire') expired.delete(step.key);
  else if (step.op === 'revision') targets[step.lane].revision = step.revision;
  results.push({ step, result, fetches: [...fetches], saves: [...saves] });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-loader-twin.json'), { domain: 'media-loader-twin', recorder: 'benchmarks/rust-core/recorders/record-media-loader.mjs', clock: 1_700_000_000_000, targets: TARGETS, steps: results });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} steps`);
process.exit(0);
