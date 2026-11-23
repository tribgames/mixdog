import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDesktopDiagnostics } from './desktop-diagnostics.ts';
import {
  normalizeRendererComposerActionDiagnostic,
  normalizeRendererDiagnostic,
  normalizeRendererFollowReleaseDiagnostic,
  normalizeRendererFollowRearmDiagnostic,
  normalizeRendererWhatsNewDiagnostic,
} from './renderer-recovery.ts';

test('a composer Stop record keeps what the core answered', () => {
  const stop = {
    kind: 'composer-action',
    action: 'stop',
    turnBusy: true,
    queueCount: 0,
    draftLength: 0,
    composing: false,
    uptimeMs: 10,
  };
  assert.deepEqual(
    normalizeRendererComposerActionDiagnostic({
      ...stop,
      source: 'stop-button',
      stopOutcome: 'nothing',
      aborted: false,
      stopReason: 'idle',
    }),
    {
      action: 'stop',
      source: 'stop-button',
      turnBusy: true,
      queueCount: 0,
      draftLength: 0,
      composing: false,
      uptimeMs: 10,
      stopOutcome: 'nothing',
      aborted: false,
      stopReason: 'idle',
    }
  );
  const escaped = normalizeRendererComposerActionDiagnostic({ ...stop, source: 'escape', stopOutcome: 'bogus' });
  assert.equal(escaped.action, 'stop');
  assert.equal('stopOutcome' in escaped, false, 'an unknown outcome is dropped, the record kept');
});

test('a follow release is recorded with its reason and where the view stood', () => {
  assert.deepEqual(
    normalizeRendererFollowReleaseDiagnostic({
      kind: 'follow-release',
      reason: 'scroll',
      top: 1200.4,
      delta: -31.6,
      distance: 31.6,
      windowFocused: true,
      pageHidden: false,
      extra: 'dropped',
    }),
    { reason: 'scroll', top: 1200, delta: -32, distance: 32, windowFocused: true, pageHidden: false }
  );
  assert.equal(normalizeRendererFollowReleaseDiagnostic({ kind: 'follow-release', reason: '' }), null);
  assert.equal(normalizeRendererFollowReleaseDiagnostic({ kind: 'long-task' }), null);
});

test('a follow re-arm is recorded with its reason and where the view stood', () => {
  assert.deepEqual(
    normalizeRendererFollowRearmDiagnostic({ kind: 'follow-rearm', reason: 'scroll', top: 1800.6, distance: 149.4 }),
    { reason: 'scroll', top: 1801, distance: 149 }
  );
  assert.equal(normalizeRendererFollowRearmDiagnostic({ kind: 'follow-rearm', reason: '' }), null);
  assert.equal(normalizeRendererFollowRearmDiagnostic({ kind: 'follow-release', reason: 'wheel' }), null);
});

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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserts the NUL in the input was stripped
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
