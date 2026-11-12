#!/usr/bin/env node
// What Node's glob orders and prunes by, for two helpers of the tool the public schema reaches only through a call that reads the
// host's file system (b6f10295a):
//  - search-glob-tool.mjs `_createGlobMtimeTopK`: the newest-first order of a glob's matches, where a match whose stat failed
//    (mtime 0, stat null) follows every stated match, itself dated at the epoch included, in walk order (search-glob-top-k.test.mjs);
//  - search-builders.mjs `rootScanIgnoreGlobs`: the kernel-virtual trees a scan rooted at a POSIX filesystem root leaves out
//    (search-builders.test.mjs). The tool calls it with process.platform; the recording machine is Windows, so the Linux answer is
//    recorded by the platform argument the helper takes.
//
//   node benchmarks/rust-core/recorders/record-tools-fs-glob-order.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/tools-fs-glob-order/golden.json (+ MANIFEST.json).
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-tools-fs-glob-order.mjs';
const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, importFrom } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const { _createGlobMtimeTopK } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/search-glob-tool.mjs');
const { rootScanIgnoreGlobs } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/search-builders.mjs');

// Names in byte order, as a walk visits them; a failed one has no stat. `completion` is the order the stats finished in.
const entries = [
  { path: 'a-tie.txt', mtimeMs: 9, failed: false },
  { path: 'b-tie.txt', mtimeMs: 9, failed: false },
  { path: 'failed-first.txt', mtimeMs: 0, failed: true },
  { path: 'failed-second.txt', mtimeMs: 0, failed: true },
  { path: 'middle.txt', mtimeMs: 5, failed: false },
  { path: 'newest.txt', mtimeMs: 12, failed: false },
  { path: 'z-epoch.txt', mtimeMs: 0, failed: false },
];
const completion = [5, 1, 6, 2, 4, 0, 3];
const topK = (bound) => {
  const selector = _createGlobMtimeTopK(bound);
  for (const index of completion) {
    const { path, mtimeMs, failed } = entries[index];
    selector.add({ path, full: path, mtime: mtimeMs, mtimeMs, stat: failed ? null : {} }, index);
  }
  return selector.values().map((item) => item.path);
};
const roots = ['/', '/proc', '/home/user/project', ''];
const cases = [
  { case: 'glob orders failed-stat matches last in walk order', entries, completion, bounded: [{ bound: entries.length, values: topK(entries.length) }, { bound: 6, values: topK(6) }] },
  {
    case: 'root-anchored kernel-tree prunes apply only to a posix filesystem-root scan',
    answers: [...roots.map((root) => ({ root, platform: 'linux', globs: rootScanIgnoreGlobs(root, 'linux') })), { root: '/', platform: 'win32', globs: rootScanIgnoreGlobs('/', 'win32') }],
  },
];
const finalDir = join(FIXTURES_ROOT, 'tools-fs-glob-order');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, {
  set: 'tools-fs-glob-order',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <export of ${NODE_COMMIT} with node_modules>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: cases.length,
    entry: 'search-glob-tool.mjs _createGlobMtimeTopK and search-builders.mjs rootScanIgnoreGlobs, the helpers the glob tool orders and prunes with; nothing else runs',
    replay: 'the core GlobTool over a workspace of the recorded entries, a stat failed for each failed one, whole; root_scan_prunes of each recorded root and platform, compared with the recorded globs',
    exclusions: {
      emptyRoot: 'the recorded roots are posix paths: the replay puts them under the host filesystem root; the empty root is a call with no path, which the core resolves to the cwd before any scan, so it is not replayed',
    },
    normalised: 'none',
  },
});
commitStage(stage, finalDir);
console.log(`tools-fs-glob-order: ${cases.length} cases`);
process.exit(0);
