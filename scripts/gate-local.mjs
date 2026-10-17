#!/usr/bin/env node
// Local pre-push check. Mirrors the test legs of .github/workflows/release-gate.yml
// (jobs: runtime, runtime-slow, desktop, desktop-tests fast/slow). It MUST be
// updated together with that workflow whenever those commands change.
// Up front, before any build or leg, it runs two fast source checks and stops
// if either fails: the gate's shipped-history job (build-shipped-history.mjs
// --check; needs a full clone, a shallow one keeps the committed file), and the
// released-section changelog check the desktop fast lane asserts
// (changelog-locales.test.mjs; Deploy's plan adds the Unreleased section).
// Not covered locally: runtime-macos, computer-backend (cargo + Linux X11),
// desktop-tests `computer` lane (windows-latest, src/main/computer/ only),
// relay (apps/relay tests), graph (cargo test), patch (cargo test of the
// checked-out engine), mobile-scripts (Python unittest). The gate's path
// filtering is not applied: every check and leg always runs. Run `npm ci`
// (root and apps/desktop) first.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateTestBudget, runGateLegs } from './lib/gate-scheduler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();

const preChecks = ['node scripts/build-shipped-history.mjs --check', 'node scripts/check-changelog-locales.mjs'];
const failedPreChecks = preChecks.filter(
  (cmd) => spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true }).status !== 0
);
if (failedPreChecks.length) {
  console.error(`[gate:local] pre-check failed: ${failedPreChecks.join('; ')}`);
  process.exit(1);
}

const build = spawnSync('npm run build:spawn:test', { cwd: root, stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error('[gate:local] build:spawn:test failed');
  process.exit(1);
}

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-gate-local-'));
const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-gate-resources-'));
const budget = gateTestBudget();
// weight: relative worker share, roughly each leg's measured duration x its 3 workers
// (runtime ~440s, runtime-slow ~545s, desktop fast ~390s, desktop slow ~280s).
const legs = [
  { name: 'runtime', weight: 3, cmds: ['npm test', 'npm run smoke:patch'] },
  { name: 'desktop-tests-fast', weight: 3, cmds: ['npm test --prefix apps/desktop'] },
  { name: 'runtime-slow', weight: 4, cmds: ['npm run test:slow'] },
  { name: 'desktop-tests-slow', weight: 2, cmds: ['npm run test:slow --prefix apps/desktop'] },
  { name: 'desktop', cmds: ['npm run build --prefix apps/desktop', 'npm run test:daemon:e2e --prefix apps/desktop'] },
];

function runCmd(cmd, logFd, concurrency) {
  return new Promise((resolve) => {
    fs.writeSync(logFd, `\n$ ${cmd}\n`);
    const child = spawn(cmd, {
      cwd: root,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        MIXDOG_TEST_CONCURRENCY: String(concurrency),
        MIXDOG_TEST_OOXML_CACHE_DIR: resourceDir,
      },
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runLeg(leg, concurrency) {
  const t0 = Date.now();
  leg.log = path.join(logDir, `${leg.name}.log`);
  const fd = fs.openSync(leg.log, 'w');
  leg.ok = true;
  for (const cmd of leg.cmds) {
    if ((await runCmd(cmd, fd, concurrency)) !== 0) {
      leg.ok = false;
      break;
    }
  }
  fs.closeSync(fd);
  leg.ms = Date.now() - t0;
}

console.log(`[gate:local] build separately, then tests sharing ${budget} workers; logs: ${logDir}`);
try {
  // TypeScript/bundling must not compete with four independent test runners.
  await runLeg(legs.at(-1), budget);
  await runGateLegs(legs.slice(0, -1), budget, runLeg);
} finally {
  fs.rmSync(resourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log('\n=== gate:local summary ===');
for (const leg of legs) {
  console.log(`${leg.ok ? 'PASS' : 'FAIL'}  ${leg.name}  ${(leg.ms / 1000).toFixed(1)}s  ${leg.log}`);
  if (!leg.ok) {
    const lines = fs
      .readFileSync(leg.log, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('[failure-summary]'));
    for (const l of lines) console.log(`    ${l}`);
  }
}
console.log(
  'Not covered locally: runtime-macos, computer-backend, desktop-tests computer lane (Windows-only), relay, graph, patch, mobile-scripts'
);
console.log(`Total: ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(legs.every((l) => l.ok) ? 0 : 1);
