import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCaptureAfterOptions,
  assertOcrLanguageTag,
  captureAfterImageIsRedundant,
  captureIdentityMap,
  captureMode,
  dedupeOcrWords,
  evaluateVerifyPredicate,
  framePoint,
  recommendedRecovery,
  screenshotInteger,
  shouldUseOcrFallback,
  summarizeCaptureChanges,
} from './analysis.ts';

test('OCR language tags stay bounded and use one host-wide grammar', () => {
  for (const language of ['ko', 'en-US', 'zh-Hans', 'sr-Latn-RS']) {
    assert.doesNotThrow(() => assertOcrLanguageTag(language), language);
  }
  for (const language of [
    '',
    'e',
    ' en-US',
    'en-US ',
    'en_US',
    'en--US',
    'en-US!',
    `en-${'a'.repeat(63)}`,
  ]) {
    assert.throws(
      () => assertOcrLanguageTag(language),
      /BCP-47 language tag/,
      JSON.stringify(language),
    );
  }
  assert.doesNotThrow(() => assertCaptureAfterOptions({
    action: 'click',
    capture_after_ocr_language: 'ko',
  }));
  assert.throws(
    () => assertCaptureAfterOptions({
      action: 'click',
      capture_after_ocr_language: 'ko_KR',
    }),
    /capture_after_ocr_language.*BCP-47/,
  );
});

function element(overrides = {}) {
  return {
    mark: 1,
    ref: 's1:e0',
    source: 'uia',
    role: 'Button',
    name: 'Save',
    value: '',
    state: '',
    enabled: true,
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    center_x: 20,
    center_y: 10,
    actions: ['click'],
    ...overrides,
  };
}

test('element identity survives a recapture and numbers repeated labels', () => {
  const refIdentities = new Map();
  const identities = captureIdentityMap([
    element({ name: 'Save' }),
    element({ name: 'Save', mark: 2, ref: 's1:e1' }),
    element({ role: 'Edit', name: 'File name', value: 'report.txt', ref: 's1:e2' }),
    // OCR marks are pixel guesses, not stable identities.
    element({ source: 'ocr', role: 'Text', name: 'SEND', mark: 9, ref: 's1:e8' }),
  ], refIdentities);
  assert.deepEqual([...identities.keys()], ['Button|Save', 'Button|Save#2', 'Edit|File name']);
  assert.match(identities.get('Edit|File name'), /^report\.txt\u0000/);
  assert.equal(refIdentities.get('s1:e0'), 'Button|Save');
  assert.equal(refIdentities.get('s1:e1'), 'Button|Save#2');
  assert.equal(refIdentities.has('s1:e8'), false);
});

test('a capture summary separates added, removed, updated, and unchanged', () => {
  const before = captureIdentityMap([
    element({ name: 'Save' }),
    element({ role: 'Edit', name: 'File name', value: 'draft.txt' }),
    element({ name: 'Cancel' }),
  ]);
  const after = captureIdentityMap([
    element({ name: 'Save' }),
    element({ role: 'Edit', name: 'File name', value: 'report.txt' }),
    element({ name: 'Close' }),
  ]);
  const changes = summarizeCaptureChanges(before, after);
  assert.equal(changes.baseline, 'previous_capture_of_same_window');
  assert.deepEqual(changes.added, { count: 1, sample: ['Button|Close'] });
  assert.deepEqual(changes.removed, { count: 1, sample: ['Button|Cancel'] });
  assert.deepEqual(changes.updated, { count: 1, sample: ['Edit|File name'] });
  assert.equal(changes.unchanged, 1);
  // An identical tree is reported as pure evidence of no change.
  const same = summarizeCaptureChanges(before, before);
  assert.equal(same.unchanged, 3);
  assert.deepEqual(same.added, { count: 0 });
});

test('a capture summary counts beyond the sample it names', () => {
  const many = new Map(Array.from({ length: 12 }, (_, index) => [`Button|b${index}`, 'x']));
  const changes = summarizeCaptureChanges(new Map(), many);
  assert.equal(changes.added.count, 12);
  assert.equal(changes.added.sample.length, 8);
});

test('the post-action image is dropped only when a semantic action has a named diff', () => {
  const changed = {
    pixel_status: 'available',
    mode: 'state',
    returned_elements: 12,
    changes: {
      added: { count: 0 },
      removed: { count: 0 },
      updated: { count: 1, sample: ['Button|Save'] },
    },
  };
  assert.equal(
    captureAfterImageIsRedundant(
      { action: 'invoke', ref: 's1:e0' },
      changed,
      'Button|Save',
    ),
    true,
  );
  assert.equal(
    captureAfterImageIsRedundant(
      { action: 'invoke', ref: 's1:e0' },
      changed,
      'Button|Unrelated',
    ),
    false,
  );
  assert.equal(
    captureAfterImageIsRedundant({ action: 'set_value', ref: 's1:e0' }, {
      ...changed,
      changes: { added: { count: 2 }, removed: { count: 1 }, updated: { count: 0 } },
    }),
    false,
  );
  // An unrelated tree update cannot replace pixel evidence for coordinate input.
  assert.equal(captureAfterImageIsRedundant({ action: 'click' }, changed), false);
  assert.equal(captureAfterImageIsRedundant({ action: 'invoke' }, changed), false);
  // An unchanged tree cannot tell "nothing happened" from a pixel-only change,
  // so the frame is the only remaining evidence.
  assert.equal(
    captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0' }, {
      ...changed,
      changes: { added: { count: 0 }, removed: { count: 0 }, updated: { count: 0 } },
    }),
    false,
  );
  // Every guard that means the pixels still carry evidence.
  assert.equal(captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0', include_ocr: true }, changed), false);
  assert.equal(captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0', capture_after_include_ocr: true }, changed), false);
  assert.equal(captureAfterImageIsRedundant(
    { action: 'invoke', ref: 's1:e0' },
    { ...changed, ocr_elements: 2 },
  ), false);
  assert.equal(
    captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0' }, { ...changed, pixel_status: 'unavailable' }),
    false,
  );
  assert.equal(captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0' }, { ...changed, mode: 'som' }), false);
  // A near-empty tree proves nothing on its own, so its image stays.
  assert.equal(captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0' }, { ...changed, returned_elements: 2 }), false);
  assert.equal(captureAfterImageIsRedundant({ action: 'invoke', ref: 's1:e0' }, { ...changed, changes: undefined }), false);
});

test('a predicate is proven, disproven, or unknown — never optimistic', () => {
  const seen = { ok: true, exists: true, title: 'report.txt - notepad', haystack: 'saved\nfile name' };
  const gone = { ok: true, exists: false, title: '', haystack: '' };
  const providerError = { ok: false, exists: false, title: '', haystack: '' };
  assert.equal(evaluateVerifyPredicate({ present: 'saved' }, seen), 'satisfied');
  assert.equal(evaluateVerifyPredicate({ present: 'saving' }, seen), 'unsatisfied');
  assert.equal(evaluateVerifyPredicate({ absent: 'saving' }, seen), 'satisfied');
  assert.equal(evaluateVerifyPredicate({ absent: 'saved' }, seen), 'unsatisfied');
  assert.equal(evaluateVerifyPredicate({ title_contains: 'notepad' }, seen), 'satisfied');
  assert.equal(evaluateVerifyPredicate({ window_exists: false }, gone), 'satisfied');
  assert.equal(evaluateVerifyPredicate({ window_exists: true }, gone), 'unsatisfied');
  // An unobserved window can prove nothing about its contents.
  assert.equal(evaluateVerifyPredicate({ present: 'saved' }, gone), 'unknown');
  assert.equal(evaluateVerifyPredicate({ absent: 'saved' }, gone), 'unknown');
  assert.equal(evaluateVerifyPredicate({ window_exists: false }, providerError), 'unknown');
  assert.equal(evaluateVerifyPredicate({ window_exists: true }, providerError), 'unknown');
  assert.equal(evaluateVerifyPredicate({ unsupported: 'x' }, seen), 'unknown');
});

test('bounded integers report their own field and range', () => {
  assert.equal(screenshotInteger(undefined, 80, 1, 1000, 'max_elements'), 80);
  assert.equal(screenshotInteger(5, 80, 1, 1000, 'max_elements'), 5);
  assert.throws(
    () => screenshotInteger(0, 80, 1, 1000, 'max_elements'),
    /max_elements must be an integer from 1 to 1000/,
  );
  assert.throws(() => screenshotInteger(1.5, 80, 1, 1000, 'max_elements'), /integer/);
});

test('frame coordinates map into physical pixels and refuse to leave the frame', () => {
  const frame = {
    originX: 100,
    originY: 50,
    physicalWidth: 1600,
    physicalHeight: 900,
    captureWidth: 800,
    captureHeight: 450,
  };
  assert.deepEqual(framePoint(frame, 0, 0), { x: 100, y: 50 });
  assert.deepEqual(framePoint(frame, 400, 225), { x: 900, y: 500 });
  assert.throws(() => framePoint(frame, 800, 0), /must be inside 0\.\.799,0\.\.449/);
  assert.throws(() => framePoint(frame, -1, 0), /must be inside/);
});

test('OCR words that a labelled control already covers are dropped', () => {
  const words = [
    { text: 'Save', line: 0, x: 10, y: 10, width: 30, height: 12, center_x: 25, center_y: 16 },
    { text: 'Untitled', line: 1, x: 200, y: 80, width: 50, height: 12, center_x: 225, center_y: 86 },
    // Too small to act on, whatever it says.
    { text: 'x', line: 2, x: 0, y: 0, width: 1, height: 1, center_x: 0, center_y: 0 },
  ];
  const kept = dedupeOcrWords(words, [{ name: 'Save', value: '', bounds: [8, 8, 40, 20] }]);
  assert.deepEqual(kept.map((word) => word.text), ['Untitled']);
});

test('capture mode defaults to state and rejects anything the host cannot render', () => {
  assert.equal(captureMode({}), 'state');
  assert.equal(captureMode({ mode: 'ax' }), 'ax');
  // zoom is a separate host command, never a capture mode at this point.
  assert.throws(() => captureMode({ mode: 'zoom' }), /must be state, som, vision, or ax/);
});

test('state and SOM automatically use OCR only when semantic accessibility is empty', () => {
  assert.equal(shouldUseOcrFallback('state', false, false), true);
  assert.equal(shouldUseOcrFallback('som', false, false), true);
  assert.equal(shouldUseOcrFallback('state', true, false), false);
  assert.equal(shouldUseOcrFallback('vision', false, false), false);
  assert.equal(shouldUseOcrFallback('vision', false, true), true);
});

test('foreground-lock failures recommend pixel activation instead of permissions', () => {
  assert.equal(
    recommendedRecovery('key', 'suspected_noop', 'foreground_unavailable', 'foreground', null),
    'pixel',
  );
  assert.equal(
    recommendedRecovery('click', 'suspected_noop', 'foreground_changed', 'foreground', null),
    'pixel',
  );
});
