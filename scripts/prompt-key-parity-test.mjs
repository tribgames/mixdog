import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { classifyPromptEscape } from '../src/tui/components/prompt-input/escape-policy.mjs';
import { promptInterruptRestoreText } from '../src/tui/components/prompt-input/interrupt-policy.mjs';
import { mergeQueuedRestoreText } from '../src/tui/components/prompt-input/restore-policy.mjs';
import {
  isAnyModifiedEnterSequence,
  isModifiedEnterSequence,
} from '../src/tui/components/prompt-input/edit-helpers.mjs';
import { verticalOffset } from '../src/tui/input-editing.mjs';

test('Claude-compatible Esc prioritizes active cancellation over a typed steering draft', () => {
  assert.deepEqual(
    classifyPromptEscape({ interruptActive: true, value: 'typed while busy', lastClearPressAt: 900, now: 1000 }),
    { action: 'interrupt', nextClearPressAt: 0 },
  );
});

test('idle non-empty Esc requires a second press while idle empty Esc reaches queue restore', () => {
  const first = classifyPromptEscape({ value: 'draft', now: 1000 });
  assert.deepEqual(first, { action: 'arm-clear', nextClearPressAt: 1000 });
  assert.deepEqual(
    classifyPromptEscape({ value: 'draft', lastClearPressAt: first.nextClearPressAt, now: 1800 }),
    { action: 'clear', nextClearPressAt: 0 },
  );
  assert.deepEqual(
    classifyPromptEscape({ value: 'draft', lastClearPressAt: first.nextClearPressAt, now: 1801 }),
    { action: 'arm-clear', nextClearPressAt: 1801 },
  );
  assert.deepEqual(
    classifyPromptEscape({ value: '', lastClearPressAt: 1000, now: 1500 }),
    { action: 'idle', nextClearPressAt: 0 },
  );
});

test('Claude-compatible idle queue restore precedes draft clearing while active cancel still wins', () => {
  assert.deepEqual(
    classifyPromptEscape({ hasQueuedMessages: true, value: 'current draft' }),
    { action: 'restore-queue', nextClearPressAt: 0 },
  );
  assert.deepEqual(
    classifyPromptEscape({ interruptActive: true, hasQueuedMessages: true, value: 'current draft' }),
    { action: 'interrupt', nextClearPressAt: 0 },
  );
});

test('interrupt restore never clobbers text typed while cancellation settles', () => {
  const result = { aborted: true, restoreText: 'submitted prompt' };
  assert.equal(promptInterruptRestoreText(result, ''), 'submitted prompt');
  assert.equal(promptInterruptRestoreText(result, 'new draft'), '');
  assert.equal(promptInterruptRestoreText({ aborted: false, restoreText: 'submitted prompt' }, ''), '');
});

test('queued restore rebases delayed daemon text onto the latest local draft', () => {
  assert.equal(mergeQueuedRestoreText('queued follow-up', ''), 'queued follow-up');
  assert.equal(
    mergeQueuedRestoreText('queued follow-up', 'typed while restore settles'),
    'queued follow-up\ntyped while restore settles',
  );
  assert.equal(mergeQueuedRestoreText('', 'latest draft'), 'latest draft');
});

test('empty-draft double Esc opens the message selector only when a conversation exists', () => {
  assert.deepEqual(
    classifyPromptEscape({ value: '', hasMessages: false, now: 1000 }),
    { action: 'idle', nextClearPressAt: 0 },
  );
  const armed = classifyPromptEscape({ value: '', hasMessages: true, now: 1000 });
  assert.deepEqual(armed, { action: 'arm-select', nextClearPressAt: 1000 });
  assert.deepEqual(
    classifyPromptEscape({ value: '', hasMessages: true, lastClearPressAt: armed.nextClearPressAt, now: 1800 }),
    { action: 'message-selector', nextClearPressAt: 0 },
  );
  assert.deepEqual(
    classifyPromptEscape({ value: '', hasMessages: true, lastClearPressAt: armed.nextClearPressAt, now: 1801 }),
    { action: 'arm-select', nextClearPressAt: 1801 },
  );
  // Cancellation and queued follow-ups still outrank the selector.
  assert.deepEqual(
    classifyPromptEscape({ interruptActive: true, hasMessages: true, value: '' }),
    { action: 'interrupt', nextClearPressAt: 0 },
  );
  assert.deepEqual(
    classifyPromptEscape({ hasQueuedMessages: true, hasMessages: true, value: '' }),
    { action: 'restore-queue', nextClearPressAt: 0 },
  );
});

test('Shift, Alt/Meta, and Ctrl Enter decode as newlines while plain Enter remains submit', () => {
  for (const sequence of ['\x1b[13;2u', '\x1b[13;3u', '\x1b[13;5u', '\x1b[27;3;13~']) {
    assert.equal(isModifiedEnterSequence(sequence), true, sequence);
  }
  assert.equal(isModifiedEnterSequence('\x1b[13;1u'), false);
  assert.equal(isAnyModifiedEnterSequence('\x1b[13;1u'), false);
});

test('Up/Down move inside multiline input and reach history only at document boundaries', () => {
  const value = 'first\nsecond';
  assert.notEqual(verticalOffset(value, value.length, 80, -1, null).cursor, value.length);
  assert.equal(verticalOffset(value, 0, 80, -1, null).cursor, 0);
  assert.notEqual(verticalOffset(value, 0, 80, 1, null).cursor, 0);
  assert.equal(verticalOffset(value, value.length, 80, 1, null).cursor, value.length);
});

test('Ink dispatches a bare ESC immediately while retaining the partial-sequence timer', async () => {
  const source = await readFile(
    new URL('../vendor/ink/build/components/App.js', import.meta.url),
    'utf8',
  );
  assert.match(source,
    /bareEscapeChunk[\s\S]{0,500}?flushPendingEscape\(\)/,
    'a one-byte ESC read must flush in the same readable turn');
  assert.match(source,
    /hasPendingEscape\(\)[\s\S]{0,120}?schedulePendingInputFlush\(\)/,
    'partial CSI/Alt sequences must retain the bounded completion timer');
});
