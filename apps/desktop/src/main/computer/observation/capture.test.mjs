import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureAccessibilityError,
  createOcrCapturePreferenceStore,
  shouldRecordVisualOnlyCapabilityMiss,
  shouldRunCaptureOcr,
} from '../input/capability-policy.ts';

test('a visual-only cache hit is a deliberate skip rather than an accessibility error', () => {
  assert.equal(captureAccessibilityError(true, false, '', ''), '');
  assert.equal(captureAccessibilityError(false, true, '', ''), '');
  assert.equal(
    captureAccessibilityError(false, false, 'provider timed out', ''),
    'provider timed out',
  );
  assert.equal(
    captureAccessibilityError(false, false, '', 'snapshot refused'),
    'snapshot refused',
  );
  assert.equal(
    captureAccessibilityError(false, false, '', ''),
    'capture accessibility snapshot failed',
  );
});

test('visual-only capability learns only from a successful empty accessibility result', () => {
  assert.equal(shouldRecordVisualOnlyCapabilityMiss(false, ''), true);
  assert.equal(
    shouldRecordVisualOnlyCapabilityMiss(false, 'computer_command_timeout: snapshot exceeded 2500ms'),
    false,
  );
  assert.equal(shouldRecordVisualOnlyCapabilityMiss(true, ''), false);
});

test('explicit OCR overrides semantic availability and persists for post-action capture', () => {
  assert.equal(shouldRunCaptureOcr(true, true, true), true);
  assert.equal(shouldRunCaptureOcr(true, true, false), false);
  assert.equal(shouldRunCaptureOcr(true, false, false), true);

  const preferences = createOcrCapturePreferenceStore();
  preferences.remember('session-a', {
    includeOcr: true,
    ocrLanguage: 'ko',
    maxOcrWords: 77,
  });
  assert.deepEqual(preferences.resolve('session-a', {}), {
    includeOcr: true,
    ocrLanguage: 'ko',
    maxOcrWords: 77,
  });
  assert.deepEqual(preferences.resolve('session-a', { includeOcr: false }), {
    includeOcr: false,
  });
  assert.deepEqual(preferences.resolve('session-b', {}), { includeOcr: false });
  preferences.remember('session-a', { includeOcr: false });
  assert.deepEqual(preferences.resolve('session-a', {}), { includeOcr: false });
  preferences.remember('session-a', { includeOcr: true, ocrLanguage: 'ko' });
  assert.deepEqual(
    preferences.resolve('session-a', { includeOcr: true, ocrLanguage: 'en-US' }),
    { includeOcr: true, ocrLanguage: 'en-US', maxOcrWords: undefined },
  );
  assert.deepEqual(preferences.resolve('session-a', {}), {
    includeOcr: true,
    ocrLanguage: 'ko',
    maxOcrWords: undefined,
  });
  preferences.release('session-a');
  assert.deepEqual(preferences.resolve('session-a', {}), { includeOcr: false });
});

test('OCR capture preferences stay bounded when sessions disappear without release', () => {
  const preferences = createOcrCapturePreferenceStore();
  for (let index = 0; index < 129; index += 1) {
    preferences.remember(`session-${index}`, { includeOcr: true });
  }
  assert.deepEqual(preferences.resolve('session-0', {}), { includeOcr: false });
  assert.deepEqual(preferences.resolve('session-128', {}), {
    includeOcr: true,
    ocrLanguage: undefined,
    maxOcrWords: undefined,
  });
});

test('using an OCR capture preference protects the active session from bounded eviction', () => {
  const preferences = createOcrCapturePreferenceStore();
  for (let index = 0; index < 128; index += 1) {
    preferences.remember(`session-${index}`, {
      includeOcr: true,
      ocrLanguage: index === 0 ? 'ko' : undefined,
    });
  }
  assert.equal(preferences.resolve('session-0', {}).ocrLanguage, 'ko');
  preferences.remember('session-128', { includeOcr: true });
  assert.equal(preferences.resolve('session-1', {}).includeOcr, false);
  assert.deepEqual(preferences.resolve('session-0', {}), {
    includeOcr: true,
    ocrLanguage: 'ko',
    maxOcrWords: undefined,
  });
});
