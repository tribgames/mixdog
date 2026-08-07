import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDesktopDiagnostics } from './desktop-diagnostics.ts';
import {
  normalizeRendererDiagnostic,
  normalizeRendererLongTaskDiagnostic,
  rendererRecoveryDecision,
} from './renderer-recovery.ts';
import {
  gpuFallbackDecision,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
} from './gpu-recovery.ts';

test('desktop diagnostics persist structured process evidence without user content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-diagnostics-'));
  const filePath = join(root, 'logs', 'desktop-diagnostics.jsonl');
  try {
    const diagnostics = createDesktopDiagnostics(filePath, {
      appVersion: '0.9.55', packaged: true, platform: 'win32', arch: 'x64', pid: 42,
    }, { now: () => new Date('2026-07-18T03:00:00.000Z') });
    diagnostics.write('render-process-gone', { reason: 'crashed', exitCode: 9 });
    await diagnostics.flush();
    const record = JSON.parse((await readFile(filePath, 'utf8')).trim());
    assert.deepEqual(record, {
      schemaVersion: 1,
      at: '2026-07-18T03:00:00.000Z',
      event: 'render-process-gone',
      pid: 42,
      platform: 'win32',
      arch: 'x64',
      appVersion: '0.9.55',
      packaged: true,
      reason: 'crashed',
      exitCode: 9,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop diagnostics rotate before crossing the configured file limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-diagnostics-'));
  const filePath = join(root, 'logs', 'desktop-diagnostics.jsonl');
  try {
    const diagnostics = createDesktopDiagnostics(filePath, {
      appVersion: 'test', packaged: false, platform: 'win32', arch: 'x64', pid: 42,
    }, { maxBytes: 4 * 1024, now: () => new Date('2026-07-18T03:00:00.000Z') });
    diagnostics.write('first', { detail: 'a'.repeat(3_600) });
    diagnostics.write('second', { detail: 'b'.repeat(3_600) });
    await diagnostics.flush();
    assert.ok((await stat(`${filePath}.1`)).size < 4 * 1024);
    assert.match(await readFile(`${filePath}.1`, 'utf8'), /"event":"first"/);
    assert.match(await readFile(filePath, 'utf8'), /"event":"second"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop process snapshots stay bounded and omit user-content fields', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const snapshot = source.match(/function currentProcessMemory\(\)[\s\S]*?\n}\n\nfunction disposeDesktopResources/)?.[0];
  assert.ok(snapshot, 'expected the process snapshot helper');
  assert.match(snapshot, /getAppMetrics\(\)\.slice\(0, 32\)/);
  assert.match(source, /'process-memory'.*currentProcessMemory\(\)/s);
  assert.match(source, /onDiagnostic:[\s\S]*diagnostics\?\.write\(/,
    'service reconnect diagnostics must survive process restarts');
  assert.match(source, /5 \* 60 \* 1000/);
  assert.doesNotMatch(snapshot, /commandLine|creationTime|cpu|session|transcript|prompt|cwd/i);
  const initializationFailure = source.match(/diagnostics\?\.write\('desktop-initialize-failed'[\s\S]*?\n\s*}\);/)?.[0];
  assert.ok(initializationFailure, 'expected bounded initialization-failure diagnostics');
  assert.match(initializationFailure, /errorName/);
  assert.match(initializationFailure, /errorCode/);
  assert.doesNotMatch(initializationFailure, /message|String\(error\)/);
});

test('clustered Windows GPU crashes engage a build-scoped software fallback', async () => {
  const ignored = gpuFallbackDecision([], {
    platform: 'win32', type: 'Utility', reason: 'crashed',
  }, 1_000);
  assert.equal(ignored.action, 'none');
  const first = gpuFallbackDecision([], {
    platform: 'win32', type: 'GPU', reason: 'crashed',
  }, 1_000);
  const second = gpuFallbackDecision(first.crashes, {
    platform: 'win32', type: 'GPU', reason: 'abnormal-exit',
  }, 10_000);
  const third = gpuFallbackDecision(second.crashes, {
    platform: 'win32', type: 'GPU', reason: 'launch-failed',
  }, 29_000);
  assert.equal(first.action, 'none');
  assert.equal(second.action, 'none');
  assert.equal(third.action, 'engage');
  assert.equal(gpuFallbackDecision(third.crashes, {
    platform: 'win32', type: 'GPU', reason: 'killed',
  }, 29_500).action, 'none');

  const root = await mkdtemp(join(tmpdir(), 'mixdog-gpu-fallback-'));
  const environment = {
    appVersion: '0.9.87',
    electronVersion: '40.10.6',
    platform: 'win32',
  };
  try {
    writeGpuFallbackMarker(root, {
      engagedAt: 29_000,
      crashesInWindow: third.crashes.length,
    }, environment);
    assert.equal(readActiveGpuFallbackMarker(root, environment)?.crashesInWindow, 3);
    assert.equal(readActiveGpuFallbackMarker(root, {
      ...environment,
      electronVersion: '41.0.0',
    }), null, 'an Electron upgrade must retry hardware acceleration');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderer diagnostics keep failure identity while dropping messages and local paths', () => {
  const details = normalizeRendererDiagnostic({
    phase: 'boundary',
    errorName: 'TypeError',
    fingerprint: 'A1B2C3D4',
    source: 'C:\\Users\\person\\Project\\App.tsx?cache=1',
    line: 42.9,
    column: 7,
    failureCode: 'react-invalid-child',
    components: ['ApprovalCard', 'article', 'C:\\Users\\person\\Project\\App.tsx', ''],
    message: 'private prompt text',
    stack: 'private stack text',
  });
  assert.deepEqual(details, {
    phase: 'boundary',
    errorName: 'TypeError',
    fingerprint: 'a1b2c3d4',
    failureCode: 'react-invalid-child',
    components: ['ApprovalCard', 'article'],
    source: 'App.tsx',
    line: 42,
    column: 7,
  });
});

test('renderer long-task diagnostics retain only a bounded duration', () => {
  assert.deepEqual(normalizeRendererLongTaskDiagnostic({
    kind: 'long-task',
    durationMs: 2_345.6,
    transcript: 'private conversation',
  }), {
    durationMs: 2_346,
  });
  assert.deepEqual(normalizeRendererLongTaskDiagnostic({
    kind: 'long-task',
    durationMs: 999_999,
  }), {
    durationMs: 60_000,
  });
  assert.equal(normalizeRendererLongTaskDiagnostic({ kind: 'long-task', durationMs: 20 }), null);
});

test('renderer process recovery reloads twice, then stops a crash loop with a prompt', () => {
  const first = rendererRecoveryDecision([], 'crashed', 1_000);
  assert.equal(first.action, 'reload');
  const second = rendererRecoveryDecision(first.failures, 'oom', 2_000);
  assert.equal(second.action, 'reload');
  const third = rendererRecoveryDecision(second.failures, 'abnormal-exit', 3_000);
  assert.equal(third.action, 'prompt');
  assert.equal(rendererRecoveryDecision(third.failures, 'killed', 4_000).action, 'none');
  assert.equal(rendererRecoveryDecision(third.failures, 'crashed', 70_000).action, 'reload',
    'a stable minute should reset the automatic recovery allowance');
});

test('desktop main wires renderer diagnostics and bounded reload recovery', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(source, /normalizeRendererDiagnostic\(payload\)/);
  assert.match(source, /normalizeRendererLongTaskDiagnostic\(payload\)/);
  assert.match(source, /'renderer-long-task'/);
  assert.match(source, /'main-event-loop-lag'/);
  assert.match(source, /rendererRecoveryDecision\(rendererFailureTimes, details\.reason\)/);
  assert.match(source, /window\.webContents\.reload\(\)/);
  assert.match(source, /Mixdog needs to recover/);
  assert.match(source, /gpuFallbackDecision\(gpuCrashTimes/);
  assert.match(source, /app\.disableHardwareAcceleration\(\)/);
  assert.match(source, /app\.relaunch\(\)/);
});
