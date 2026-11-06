#!/usr/bin/env node
// Golden twin of `Array.prototype.sort(compareFn)` (V8's TimSort) for comparators that are not a
// strict weak order, whose result depends on the exact sequence of comparisons. Node's own sort
// runs over shuffled arrays of every size class (insertion only, one run, merge stack, galloping)
// and comparator kind; Rust `mixdog_js::js_sort_by` must give the same order.
//
//   node benchmarks/rust-core/recorders/record-js-array-sort.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
let seed = 0x7155_0b17;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The comparators the Rust side spells the same way.
const COMPARATORS = {
  numeric: () => (a, b) => a - b,
  descending: () => (a, b) => b - a,
  ties: () => (a, b) => (a % 5) - (b % 5),
  cyclic: (k) => (a, b) => ((a * 7919 + b * 104729 + k) % 7) - 3,
  mostlyOrdered: (k) => (a, b) => (((a + b + k) % 11 === 0) ? b - a : a - b),
  nan: () => (a, b) => (a % 3 === 0 || b % 3 === 0 ? NaN : a - b),
};
const SIZES = [0, 1, 2, 3, 4, 5, 8, 13, 31, 32, 33, 63, 64, 65, 100, 127, 128, 129, 200, 255, 300, 500, 1000];

const cases = [];
for (const size of SIZES) {
  for (const kind of Object.keys(COMPARATORS)) {
    for (let round = 0; round < 6; round += 1) {
      const k = Math.floor(rnd() * 1000);
      const input = Array.from({ length: size }, (_, i) => i);
      // Shuffled, partly sorted or partly reversed: runs of every length for the run detection.
      const style = round % 3;
      if (style !== 1) for (let i = size - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [input[i], input[j]] = [input[j], input[i]];
      }
      if (style === 1) for (let at = 0; at < size; at += 1 + Math.floor(rnd() * 20)) {
        const to = Math.min(size, at + Math.floor(rnd() * 40));
        const part = input.slice(at, to).reverse();
        input.splice(at, part.length, ...part);
      }
      const output = [...input].sort(COMPARATORS[kind](k));
      cases.push({ kind, k, input, output });
    }
  }
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'js-array-sort-twin.json'), {
  domain: 'js-array-sort-twin',
  recorder: 'benchmarks/rust-core/recorders/record-js-array-sort.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-js-array-sort.mjs',
  command: 'node benchmarks/rust-core/recorders/record-js-array-sort.mjs',
  identityTree: tree,
});
console.log(`recorded ${cases.length} sorts`);
