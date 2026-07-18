import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDesktopDiagnostics } from './desktop-diagnostics.ts';

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
  assert.match(source, /5 \* 60 \* 1000/);
  assert.doesNotMatch(snapshot, /commandLine|creationTime|cpu|session|transcript|prompt|cwd/i);
  const initializationFailure = source.match(/diagnostics\?\.write\('desktop-initialize-failed'[\s\S]*?\n\s*}\);/)?.[0];
  assert.ok(initializationFailure, 'expected bounded initialization-failure diagnostics');
  assert.match(initializationFailure, /errorName/);
  assert.match(initializationFailure, /errorCode/);
  assert.doesNotMatch(initializationFailure, /message|String\(error\)/);
});
