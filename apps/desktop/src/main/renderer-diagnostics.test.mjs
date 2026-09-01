import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeRendererDiagnostic } from './renderer-recovery.ts';

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
