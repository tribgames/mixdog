import assert from 'node:assert/strict';
import test from 'node:test';

import { mergePromptContents, promptDisplayText } from './queue-helpers.mjs';

test('merging keeps an externalized single text part as a parts array', () => {
  // Prompts over the attachment externalization threshold arrive as
  // [{ type:'text', attachmentRef, sizeBytes }] with NO inline .text.
  // Collapsing that part to `.text` returned undefined and the turn ran with
  // an invisible prompt (silent empty worker turns on long agent briefs).
  const ref = {
    type: 'text',
    attachmentRef: 'a'.repeat(64),
    sizeBytes: 1286,
  };
  const merged = mergePromptContents([{ content: [ref] }]);
  assert.deepEqual(merged, [ref]);
});

test('merging still collapses a single inline text part to a string', () => {
  assert.equal(mergePromptContents([{ content: 'plain prompt' }]), 'plain prompt');
  assert.equal(
    mergePromptContents([{ content: [{ type: 'text', text: 'inline part' }] }]),
    'inline part',
  );
});

test('merging joins mixed inline and externalized parts without dropping refs', () => {
  const ref = { type: 'text', attachmentRef: 'b'.repeat(64), sizeBytes: 900 };
  const merged = mergePromptContents([
    { content: 'first' },
    { content: [ref] },
  ]);
  assert.ok(Array.isArray(merged));
  assert.ok(merged.some((part) => part?.attachmentRef === ref.attachmentRef));
  assert.ok(merged.some((part) => part?.text === 'first'));
});

test('empty display text falls back to structured attachment content', () => {
  assert.equal(
    promptDisplayText([{ type: 'image', data: 'AA==', mimeType: 'image/png' }], {
      displayText: '',
    }),
    '[Image]',
  );
});