#!/usr/bin/env node
// Ask the artifact written by `node scripts/test.mjs --coverage` whether the
// suite executed the function a line belongs to. A file that changed since the
// collection answers STALE instead of a verdict nobody should act on.
//
// Usage: node scripts/coverage-query.mjs <file> <line>
//        node scripts/coverage-query.mjs --status
import { relative, resolve } from 'node:path';
import {
  coverageStaleness,
  formatCoverageAnswer,
  formatStaleness,
  loadCoverageArtifact,
  queryCoverage,
} from './lib/coverage.mjs';

const [file, line] = process.argv.slice(2);
if (file === '--status') {
  console.log(formatStaleness(await coverageStaleness(await loadCoverageArtifact())));
} else if (!file || !/^\d+$/.test(line ?? '')) {
  console.error('usage: node scripts/coverage-query.mjs <file> <line> | --status');
  process.exitCode = 1;
} else {
  const artifact = await loadCoverageArtifact();
  const path = relative(process.cwd(), resolve(process.cwd(), file));
  console.log(formatCoverageAnswer(await queryCoverage(artifact, path, Number(line))));
}
