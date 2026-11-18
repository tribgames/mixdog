#!/usr/bin/env node
// How many shards the root default Node lane (release-gate.yml, job `runtime`) runs in, from the number of test files it
// discovers (scripts/test.mjs, the same discovery `npm test` uses), the way core-select.mjs sizes the Rust legs.
//
// A shard is its own machine and pays its own install (npm ci, the Office fonts), so a shard has to be long enough to cover that:
// the lane is one job until it holds more than FILES_PER_SHARD files, and never more than MAX_SHARDS. The lane runs beside the
// Rust core's build, which is the gate's critical path by an order of magnitude, so a shard count only matters once the lane
// itself becomes the longest job. The runner forwards `--test-shard=<n>/<of>` to `node --test`.
//
// Prints the runtime matrix and the subtree, if any, delegated to the packages lane (GitHub output format).
// Usage: node scripts/ci/node-shards.mjs        (from the repository root, before any install)
import { pathToFileURL } from 'node:url';

import { discoverTestFiles, selectTestFiles } from '../test.mjs';

export const FILES_PER_SHARD = 250;
export const MAX_SHARDS = 3;
export const PROTOCOL_CLIENT_TEST_PATH = 'packages/protocol-client/test';

export function shardsFor(files, { fullCoverage = false } = {}) {
  // Coverage reconciliation requires the fixed linux/root-fast/1of1 leg.
  if (fullCoverage) return 1;
  return Math.min(MAX_SHARDS, Math.max(1, Math.ceil(files / FILES_PER_SHARD)));
}

export function shardMatrix(shards) {
  return { include: Array.from({ length: shards }, (_, index) => ({ shard: index + 1, of: shards })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const delegated = process.env.PROTOCOL_IN_PACKAGES === 'true' ? PROTOCOL_CLIENT_TEST_PATH : '';
  const excludePaths = delegated ? [delegated] : [];
  const files = selectTestFiles(await discoverTestFiles(), { lane: 'fast', filters: [], excludePaths }).length;
  const shards = shardsFor(files, { fullCoverage: process.env.FULL_COVERAGE === 'true' });
  console.error(`[node-shards] ${files} fast-lane files, ${shards} shard(s)`);
  console.log(`runtime_files=${files}`);
  console.log(`runtime_shards=${shards}`);
  console.log(`runtime_matrix=${JSON.stringify(shardMatrix(shards))}`);
  console.log(`runtime_excluded_path=${delegated}`);
}
