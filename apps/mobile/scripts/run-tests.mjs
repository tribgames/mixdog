#!/usr/bin/env node
// Runs the mobile tests of one lane. `unit` is every src/**/*.test.ts that is not a slow test; `e2e` is every
// src/**/*.slow.test.ts, which starts the Rust relay (native/core/target/{release,debug}/mixdog-relay, built by
// `cargo build -p mixdog-relay`) and so runs only where that binary exists (release-gate's relay-rust job).
//   node scripts/run-tests.mjs unit|e2e
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLOW = /\.slow\.test\.ts$/;

export function testFiles(lane, root = ROOT) {
  if (lane !== 'unit' && lane !== 'e2e') throw new Error(`lane must be unit or e2e, got ${lane}`);
  return readdirSync(join(root, 'src'), { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((entry) => entry.endsWith('.test.ts') && SLOW.test(entry) === (lane === 'e2e'))
    .sort()
    .map((entry) => `src/${entry}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = testFiles(process.argv[2]);
  if (!files.length) {
    console.error(`no ${process.argv[2]} test files under src/`);
    process.exit(1);
  }
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: ROOT, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
