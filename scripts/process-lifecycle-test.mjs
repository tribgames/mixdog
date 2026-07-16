import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  beginProcessLifecycle,
  finishProcessLifecycle,
  lifecyclePathsForTest,
  LIFECYCLE_LEDGER_MAX_BYTES,
  recordCatchableFatal,
} from '../src/runtime/shared/process-lifecycle.mjs';
import { installProcessSignalCleanup } from '../src/runtime/shared/process-shutdown.mjs';
import { stagedChildExitCode } from '../src/runtime/shared/staged-child-result.mjs';

const REPO_ROOT = new URL('..', import.meta.url);

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-'));
}

function entries(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('lifecycle ledger records bounded metadata and removes only its own marker', async () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    const api = beginProcessLifecycle({ directory: root, configureReports: false });
    const foreignMarker = join(paths.markerDir, `${process.pid}-foreign.json`);
    writeFileSync(foreignMarker, JSON.stringify({ pid: process.pid, ppid: process.ppid, token: 'foreign' }));
    recordCatchableFatal(1);
    const duplicate = await import(`../src/runtime/shared/process-lifecycle.mjs?duplicate=${Date.now()}`);
    assert.equal(duplicate.beginProcessLifecycle({ directory: join(root, 'ignored') }).markerPath, api.markerPath);
    assert.equal(duplicate.finishProcessLifecycle('catchable-fatal-error', 1), true);
    const rows = entries(paths.ledger);
    assert.deepEqual(rows.map((row) => row.reason), [
      'process-start',
      'catchable-fatal-error',
      'catchable-fatal-error',
    ]);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      'cwd', 'exitCode', 'memory', 'pid', 'ppid', 'reason', 'timestamp', 'version',
    ]);
    assert.equal(existsSync(api.markerPath), false);
    assert.equal(existsSync(foreignMarker), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vanished evidence uses only old-process fields and both ledger files stay hard-bounded', () => {
  const root = tempRoot();
  const originalKill = process.kill;
  try {
    process.kill = () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; };
    const paths = lifecyclePathsForTest(root);
    mkdirSync(paths.markerDir, { recursive: true });
    const staleMarker = join(paths.markerDir, '2147483647-stale.json');
    writeFileSync(staleMarker, JSON.stringify({
      version: 1,
      timestamp: new Date(0).toISOString(),
      pid: 2147483647,
      ppid: 1,
      token: 'stale',
    }));
    writeFileSync(paths.ledger, `${'x'.repeat(LIFECYCLE_LEDGER_MAX_BYTES * 3)}\n`);
    writeFileSync(paths.previousLedger, 'y'.repeat(LIFECYCLE_LEDGER_MAX_BYTES * 3));
    beginProcessLifecycle({ directory: root, configureReports: false });
    assert.ok(readFileSync(paths.previousLedger).byteLength <= LIFECYCLE_LEDGER_MAX_BYTES);
    finishProcessLifecycle('clean-shutdown', 0);
    const rows = entries(paths.ledger);
    const vanished = rows.find((row) => row.reason === 'prior-process-vanished');
    assert.deepEqual(Object.keys(vanished).sort(), [
      'exitCode', 'pid', 'ppid', 'reason', 'timestamp', 'version',
    ]);
    assert.equal(vanished.pid, 2147483647);
    assert.equal(existsSync(staleMarker), false);
    assert.ok(readFileSync(paths.ledger).byteLength <= LIFECYCLE_LEDGER_MAX_BYTES);
    assert.ok(readFileSync(paths.previousLedger).byteLength <= LIFECYCLE_LEDGER_MAX_BYTES);
  } finally {
    process.kill = originalKill;
    rmSync(root, { recursive: true, force: true });
  }
});

test('PID reuse is detected by process identity while uncertain live identity is preserved', () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    mkdirSync(paths.markerDir, { recursive: true });
    const seed = beginProcessLifecycle({ directory: root, configureReports: false });
    const currentIdentity = JSON.parse(readFileSync(seed.markerPath, 'utf8')).processIdentity;
    assert.ok(currentIdentity);
    finishProcessLifecycle('clean-shutdown', 0);
    const reused = join(paths.markerDir, `${process.pid}-reused.json`);
    const matching = join(paths.markerDir, `${process.pid}-matching.json`);
    const uncertain = join(paths.markerDir, `${process.pid}-uncertain.json`);
    const malformed = join(paths.markerDir, `${process.pid}-malformed.json`);
    const clockAmbiguous = join(paths.markerDir, `${process.pid}-clock.json`);
    const differentKind = join(paths.markerDir, `${process.pid}-different-kind.json`);
    const reusedIdentity = currentIdentity.kind === 'linux-start-ticks'
      ? { kind: currentIdentity.kind, value: String(BigInt(currentIdentity.value) + 1n) }
      : { kind: currentIdentity.kind, value: currentIdentity.value + 1 };
    writeFileSync(reused, JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      token: 'reused',
      processIdentity: reusedIdentity,
    }));
    writeFileSync(matching, JSON.stringify({
      pid: process.pid,
      token: 'matching',
      processIdentity: currentIdentity,
    }));
    writeFileSync(uncertain, JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      token: 'uncertain',
    }));
    writeFileSync(malformed, JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      token: 'malformed',
      processIdentity: process.platform === 'linux'
        ? { kind: 'linux-start-ticks', value: 'not-a-number' }
        : { kind: 'start-seconds', value: 'not-a-number' },
    }));
    writeFileSync(clockAmbiguous, JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      token: 'clock-adjusted',
      processIdentity: { kind: 'legacy-wall-clock', value: Date.now() + 86400000 },
    }));
    writeFileSync(differentKind, JSON.stringify({
      pid: process.pid,
      token: 'different-kind',
      processIdentity: currentIdentity.kind === 'linux-start-ticks'
        ? { kind: 'start-seconds', value: 1 }
        : { kind: 'linux-start-ticks', value: '1' },
    }));
    beginProcessLifecycle({ directory: root, configureReports: false });
    finishProcessLifecycle('clean-shutdown', 0);
    assert.equal(entries(paths.ledger).filter((row) => row.reason === 'prior-process-vanished').length, 1);
    assert.equal(existsSync(reused), false);
    assert.equal(existsSync(matching), true);
    assert.equal(existsSync(uncertain), true);
    assert.equal(existsSync(malformed), true);
    assert.equal(existsSync(clockAmbiguous), true);
    assert.equal(existsSync(differentKind), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marker PID probing is tri-state and invalid PIDs preserve evidence', () => {
  const originalKill = process.kill;
  try {
    for (const [name, pid, code, vanished] of [
      ['success', 101, null, false],
      ['eperm', 102, 'EPERM', false],
      ['esrch', 103, 'ESRCH', true],
      ['eacces', 104, 'EACCES', false],
      ['zero', 0, 'ESRCH', false],
      ['negative', -1, 'ESRCH', false],
      ['fractional', 1.5, 'ESRCH', false],
      ['too-large', 2147483648, 'ESRCH', false],
    ]) {
      const root = tempRoot();
      try {
        const paths = lifecyclePathsForTest(root);
        mkdirSync(paths.markerDir, { recursive: true });
        const marker = join(paths.markerDir, `${name}.json`);
        writeFileSync(marker, JSON.stringify({ pid, token: name }));
        process.kill = () => {
          if (code === null) return true;
          const error = new Error(code);
          error.code = code;
          throw error;
        };
        beginProcessLifecycle({ directory: root, configureReports: false });
        finishProcessLifecycle('clean-shutdown', 0);
        assert.equal(existsSync(marker), !vanished, name);
        assert.equal(
          entries(paths.ledger).some((row) => row.reason === 'prior-process-vanished'),
          vanished,
          name,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    process.kill = originalKill;
  }
});

test('old live same-PID foreign-token lock is never stolen', () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    writeFileSync(paths.lock, `${process.pid} ${Date.now() - 60000} foreign-token\n`);
    const old = new Date(Date.now() - 60000);
    utimesSync(paths.lock, old, old);
    const api = beginProcessLifecycle({ directory: root, configureReports: false });
    assert.equal(existsSync(paths.lock), true);
    assert.equal(existsSync(api.markerPath), true);
    assert.equal(existsSync(paths.ledger), false);
    unlinkSync(paths.lock);
    assert.equal(finishProcessLifecycle('clean-shutdown', 0), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent writers serialize rotation', async () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    mkdirSync(root, { recursive: true });
    const childSource = `
      import { beginProcessLifecycle, finishProcessLifecycle, recordCatchableFatal } from './src/runtime/shared/process-lifecycle.mjs';
      beginProcessLifecycle({ directory: process.env.LEDGER_DIR, configureReports: false });
      for (let i = 0; i < 120; i++) recordCatchableFatal(1);
      if (!finishProcessLifecycle('catchable-fatal-error', 1)) process.exit(4);
    `;
    const children = Array.from({ length: 3 }, () => spawn(
      process.execPath,
      ['--input-type=module', '--eval', childSource],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, LEDGER_DIR: root },
        stdio: 'ignore',
      },
    ));
    const results = await Promise.all(children.map(childExit));
    assert.deepEqual(results, [
      { code: 0, signal: null },
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    for (const path of [paths.ledger, paths.previousLedger]) {
      assert.ok(readFileSync(path).byteLength <= LIFECYCLE_LEDGER_MAX_BYTES);
      entries(path);
    }
    assert.equal(existsSync(paths.lock), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed final ledger write preserves marker evidence', () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    const api = beginProcessLifecycle({ directory: root, configureReports: false });
    unlinkSync(paths.ledger);
    mkdirSync(paths.ledger);
    assert.equal(finishProcessLifecycle('clean-shutdown', 0), false);
    assert.equal(existsSync(api.markerPath), true);
    rmSync(paths.ledger, { recursive: true, force: true });
    assert.equal(finishProcessLifecycle('forced-cleanup', 1), true);
    assert.equal(existsSync(api.markerPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup rejection and timeout are forced cleanup, not clean shutdown', async () => {
  const root = tempRoot();
  const originalExit = process.exit;
  try {
    const exits = [];
    process.exit = (code) => { exits.push(code); };
    for (const [name, cleanupFn] of [
      ['rejection', async () => { throw new Error('fixture failure'); }],
      ['timeout', async () => new Promise(() => {})],
    ]) {
      const directory = join(root, name);
      const paths = lifecyclePathsForTest(directory);
      beginProcessLifecycle({ directory, configureReports: false });
      const cleanup = installProcessSignalCleanup({
        signals: [],
        fatal: false,
        timeoutMs: 20,
        cleanup: cleanupFn,
        log: () => {},
      });
      await cleanup.run('SIGTERM', { code: 143, shouldExit: true });
      assert.equal(entries(paths.ledger).at(-1).reason, 'forced-cleanup');
    }
    assert.deepEqual(exits, [143, 143]);
  } finally {
    process.exit = originalExit;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node report is compact, excludes environment, and rotates to one previous report', () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    writeFileSync(paths.report, 'previous-report');
    const source = `
      import { beginProcessLifecycle, finishProcessLifecycle } from './src/runtime/shared/process-lifecycle.mjs';
      const api = beginProcessLifecycle({ directory: process.env.REPORT_DIR, safeCommandLine: true });
      if (!api.reportPath || !process.report.compact || !process.report.excludeEnv || !process.report.excludeNetwork) process.exit(3);
      process.report.writeReport();
      finishProcessLifecycle('clean-shutdown', 0);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd: REPO_ROOT,
      env: { ...process.env, REPORT_DIR: root, MIXDOG_TEST_SECRET: 'must-not-appear' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(paths.report, 'utf8');
    const report = JSON.parse(raw);
    assert.equal(raw.includes('must-not-appear'), false);
    assert.equal('environmentVariables' in report, false);
    assert.equal('networkInterfaces' in report.header, false);
    assert.equal(raw.trim().includes('\n'), false);
    assert.equal(readFileSync(`${paths.report}.1`, 'utf8'), 'previous-report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executed TUI bundle shares lifecycle boundary and CLI preserves a bounded clean record', () => {
  const root = tempRoot();
  try {
    const dist = readFileSync(new URL('../src/tui/dist/index.mjs', import.meta.url), 'utf8');
    assert.match(dist, /from '\.\.\/\.\.\/runtime\/shared\/process-shutdown\.mjs'/);
    assert.doesNotMatch(dist, /function installProcessSignalCleanup\(/);
    const result = spawnSync(process.execPath, ['src/cli.mjs'], {
      cwd: REPO_ROOT,
      env: { ...process.env, MIXDOG_DATA_DIR: root, MIXDOG_DISABLE_STAGED_SWAP: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.status, 1, result.stderr);
    const diagnosticPaths = lifecyclePathsForTest(join(root, 'diagnostics'));
    const rows = entries(diagnosticPaths.ledger);
    assert.deepEqual(rows.map((row) => row.reason), ['process-start', 'clean-shutdown']);
    assert.ok(readFileSync(diagnosticPaths.ledger).byteLength <= LIFECYCLE_LEDGER_MAX_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executed staged-child signal handling is monotonic after failed forced finalization', () => {
  const root = tempRoot();
  try {
    const paths = lifecyclePathsForTest(root);
    const api = beginProcessLifecycle({ directory: root, configureReports: false });
    const statusChild = spawnSync(process.execPath, ['--eval', 'process.exit(7)']);
    assert.equal(stagedChildExitCode(statusChild), 7);
    unlinkSync(paths.ledger);
    mkdirSync(paths.ledger);
    assert.equal(stagedChildExitCode({ status: null, signal: 'SIGTERM', error: undefined }), 143);
    assert.equal(existsSync(api.markerPath), true);
    rmSync(paths.ledger, { recursive: true, force: true });
    assert.equal(finishProcessLifecycle('clean-shutdown', 0), true);
    const rows = entries(paths.ledger);
    assert.deepEqual(rows.map((row) => row.reason), ['forced-cleanup']);
    assert.equal(rows[0].exitCode, 143);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
