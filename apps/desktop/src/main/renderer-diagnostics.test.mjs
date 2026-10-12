import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDesktopDiagnostics } from './desktop-diagnostics.ts';
import { normalizeRendererDiagnostic, normalizeRendererWhatsNewDiagnostic } from './renderer-recovery.ts';

test("what's-new diagnostics keep a bounded event record and reject unknown events", () => {
  assert.deepEqual(
    normalizeRendererWhatsNewDiagnostic({
      kind: 'whats-new',
      event: 'failed',
      version: '1.1.1',
      errorName: 'TypeError',
      message: 'a\nb',
    }),
    { step: 'failed', version: '1.1.1', errorName: 'TypeError', message: 'a b' }
  );
  assert.equal(normalizeRendererWhatsNewDiagnostic({ kind: 'whats-new', event: 'bogus', version: '1' }), null);
  assert.equal(normalizeRendererWhatsNewDiagnostic({ kind: 'long-task' }), null);
});

test("a what's-new record keeps its own event name in the diagnostics log", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-whats-new-diag-'));
  try {
    const diagnostics = createDesktopDiagnostics(join(dir, 'desktop-diagnostics.jsonl'), {
      appVersion: '1.1.1',
      packaged: true,
    });
    diagnostics.write(
      'renderer-whats-new',
      normalizeRendererWhatsNewDiagnostic({ kind: 'whats-new', event: 'skipped', version: '1.1.1', reason: 'current' })
    );
    await diagnostics.flush();
    const line = JSON.parse(await readFile(diagnostics.filePath, 'utf8'));
    assert.equal(line.event, 'renderer-whats-new');
    assert.equal(line.step, 'skipped');
    assert.equal(line.reason, 'current');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a notice keeps the sentence the user saw', () => {
  const details = normalizeRendererDiagnostic({
    phase: 'notice',
    errorName: 'BridgeError',
    fingerprint: 'a1b2c3d4',
    message: 'Mixdog session request timed out: invokeCapability.',
  });
  assert.equal(details.phase, 'notice');
  assert.equal(details.message, 'Mixdog session request timed out: invokeCapability.');
  assert.equal(details.fingerprint, 'a1b2c3d4');
});

test('notice text is collapsed and bounded', () => {
  const details = normalizeRendererDiagnostic({
    phase: 'console',
    errorName: 'ConsoleError',
    fingerprint: '00ff00ff',
    message: `line one\n\tline\u0000two ${'x'.repeat(400)}`,
  });
  assert.ok(!/[\n\t\u0000]/.test(String(details.message)));
  assert.ok(String(details.message).startsWith('line one line two '));
  assert.equal(String(details.message).length, 300);
});

test('a crash report carries no free text', () => {
  const details = normalizeRendererDiagnostic({
    phase: 'boundary',
    errorName: 'TypeError',
    fingerprint: 'deadbeef',
    message: 'user@example.com opened C:\\Secret\\file.txt',
  });
  assert.equal(details.message, undefined);
});

test('an unknown phase collapses instead of passing through', () => {
  const details = normalizeRendererDiagnostic({
    phase: 'made-up',
    errorName: 'Whatever',
    fingerprint: 'zzzz',
    message: 'should not be recorded',
  });
  assert.equal(details.phase, 'unknown');
  assert.equal(details.message, undefined);
  assert.equal(details.fingerprint, '00000000');
});
