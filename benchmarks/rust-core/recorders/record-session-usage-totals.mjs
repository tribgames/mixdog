#!/usr/bin/env node
// Records `sessionUsageTotals(session)` (src/runtime/shared/session-usage-totals.mjs) for the session records of
// session-usage-totals.test.mjs:13 and the stored rows of :46/:83 (counted, legacy without counters).
//
//   node benchmarks/rust-core/recorders/record-session-usage-totals.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/session-usage-totals/golden.json (+ MANIFEST.json).
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-session-usage-totals.mjs';
const common = 'benchmarks/rust-core/recorders/lib/common.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const { sessionUsageTotals } = await importFrom(tree, 'src/runtime/shared/session-usage-totals.mjs');

const sessions = [
  { totalInputTokens: 120, totalOutputTokens: 30, totalToolCalls: 7 },
  { totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0 },
  { totalInputTokens: 5, totalOutputTokens: 1 },
  null,
  {},
  { totalInputTokens: 'x', totalToolCalls: -1 },
  { totalInputTokens: 900, totalOutputTokens: 100, totalToolCalls: 12 },
  { totalInputTokens: 40, totalOutputTokens: 2, totalToolCalls: 5 },
];
const cases = sessions.map((session) => ({ session, totals: sessionUsageTotals(session) }));

const finalDir = join(FIXTURES_ROOT, 'session-usage-totals');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's sessionUsageTotals at ${NODE_COMMIT} over its unit test's sessions`, cases });
writeSetManifest(stage, {
  set: 'session-usage-totals',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recordingProvenance(recorder, [common]),
    tests: ['src/runtime/shared/session-usage-totals.test.mjs:13', 'src/runtime/shared/session-usage-totals.test.mjs:46 (stored rows)', 'src/runtime/shared/session-usage-totals.test.mjs:83 (live rows)'],
    exclusions: {
      undefinedSession: 'the test also passes undefined; JSON has no undefined, and `session?.` reads it exactly as null, which is recorded',
      deltaAndTerminalCounting: ':31 (usageDeltaEvent / applyAskTerminalUsageTotals) is not this module; not recorded here',
    },
  },
});
commitStage(stage, finalDir);
console.log(`cases=${cases.length}`);
