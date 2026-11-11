#!/usr/bin/env node
// Records `setBoundedTextCacheEntry` (session/cache/text-cache-budget.mjs) over the steps of its unit test
// (text-cache-budget.test.mjs:5, :22): after each put, the return value, the stored entries in insertion order and
// the keys the eviction callback received so far.
//
//   node benchmarks/rust-core/recorders/record-text-cache-budget.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/text-cache-budget/golden.json (+ MANIFEST.json).
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-text-cache-budget.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const S = 'src/runtime/agent/orchestrator/session';
const { setBoundedTextCacheEntry } = await importFrom(tree, `${S}/cache/text-cache-budget.mjs`);

const scenario = (name, maxEntries, maxBytes, puts) => {
  const map = new Map();
  const evicted = [];
  const steps = puts.map(([key, content]) => {
    const stored = setBoundedTextCacheEntry(map, key, { content }, { maxEntries, maxBytes, onEvict: (k) => evicted.push(k) });
    return { key, content, stored, entries: [...map].map(([k, v]) => ({ key: k, content: v.content })), evicted: [...evicted] };
  });
  return { name, maxEntries, maxBytes, steps };
};

const scenarios = [
  scenario('count and UTF-16 byte bounds', 2, 16, [['a', '가가'], ['b', 'bb'], ['c', 'cc'], ['b', 'bbbb'], ['d', 'dddd']]),
  scenario('an oversized replacement drops only its old value', 2, 12, [['a', 'aa'], ['b', 'bb'], ['a', '123456'], ['c', 'cc']]),
];

const finalDir = join(FIXTURES_ROOT, 'text-cache-budget');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's setBoundedTextCacheEntry at ${NODE_COMMIT} over its unit test's steps`, scenarios });
writeSetManifest(stage, {
  set: 'text-cache-budget',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: [`${S}/cache/text-cache-budget.test.mjs:5`, `${S}/cache/text-cache-budget.test.mjs:22`],
    exclusions: {},
  },
});
commitStage(stage, finalDir);
console.log(`scenarios=${scenarios.length}`);
