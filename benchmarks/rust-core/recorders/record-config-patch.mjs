#!/usr/bin/env node
// Golden twin of the config patch (`shared/config-patch.mjs`): `diffConfig(before, after)` and
// `applyConfigPatch(current, changes)` with `ifAbsent` seeds, `unlessSet` guards and removals.
// 200 deterministic (fake) documents. An entry holds the two documents, Node's diff, the result
// of applying it to a third document (what another writer left), and a hand-shaped patch with
// guards applied to that document.
//
//   node benchmarks/rust-core/recorders/record-config-patch.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { diffConfig, applyConfigPatch } = await importFrom(tree, 'src/runtime/shared/config-patch.mjs');

let seed = 0x5a7c0de1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const KEYS = ['default', 'presets', 'agents', 'modelSettings', 'providers', 'builtins', 'recap', 'x', 'y'];

function scalar() {
  return pick([1, 2, 1.5, 'a', 'b', '', true, false, null, [], [1, 2], [{ id: 'p' }], {}]);
}
function value(depth) {
  if (depth > 2 || chance(0.5)) return scalar();
  const out = {};
  for (const key of KEYS) if (chance(0.3)) out[key] = value(depth + 1);
  return out;
}
function doc() {
  const out = {};
  for (const key of KEYS) if (chance(0.55)) out[key] = value(0);
  return out;
}
function mutate(base) {
  const out = structuredClone(base);
  for (const key of KEYS) {
    if (!chance(0.35)) continue;
    if (chance(0.25)) delete out[key];
    else if (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) && chance(0.6)) {
      const inner = out[key];
      for (const k of KEYS) if (chance(0.3)) { if (chance(0.3)) delete inner[k]; else inner[k] = value(1); }
    } else out[key] = value(0);
  }
  return out;
}
function guardedPatch() {
  const changes = [];
  for (let i = 0; i < 1 + Math.floor(rnd() * 4); i += 1) {
    const path = [pick(KEYS)];
    if (chance(0.4)) path.push(pick(KEYS));
    const change = chance(0.25) ? { path, remove: true } : { path, value: value(1) };
    if (chance(0.3)) change.ifAbsent = true;
    if (chance(0.4)) change.unlessSet = chance(0.5) ? ['default'] : [pick(KEYS), pick(KEYS)];
    changes.push(change);
  }
  return changes;
}

const entries = [];
for (let i = 0; i < 200; i += 1) {
  const before = doc();
  const after = chance(0.1) ? structuredClone(before) : mutate(before);
  const other = mutate(before);
  const changes = diffConfig(before, after);
  const guarded = guardedPatch();
  entries.push({
    before,
    after,
    changes,
    other,
    appliedToOther: applyConfigPatch(other, changes),
    guarded,
    guardedOnOther: applyConfigPatch(other, guarded),
  });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'config-patch-twin.json'), {
  domain: 'config-patch-twin',
  recorder: 'benchmarks/rust-core/recorders/record-config-patch.mjs',
  entries,
});
console.log(`recorded ${entries.length} config patches`);
