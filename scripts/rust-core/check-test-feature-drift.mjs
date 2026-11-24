#!/usr/bin/env node
// Fails when a native/core manifest's test-only features drift from the unified set (the one every `-p <crate>` test
// build then shares, so switching `-p` recompiles nothing). Fix: python scripts/rust-core/unify-test-features.py native/core --write
// Usage: node scripts/rust-core/check-test-feature-drift.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tool = fileURLToPath(new URL('./unify-test-features.py', import.meta.url));
const run = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [tool, `${root}native/core`], {
  encoding: 'utf8',
  cwd: root,
});
if (run.status !== 0) {
  process.stderr.write(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  process.exit(run.status ?? 1);
}
const drifted = /^(\d+) manifest\(s\) would change$/m.exec(run.stdout);
if (!drifted) {
  process.stderr.write(`unify-test-features printed no drift count:\n${run.stdout}`);
  process.exit(1);
}
if (drifted[1] !== '0') {
  process.stderr.write(`${run.stdout}\n${drifted[1]} native/core manifest(s) have drifted test features; run: python scripts/rust-core/unify-test-features.py native/core --write\n`);
  process.exit(1);
}
console.log('native/core test features are unified');
