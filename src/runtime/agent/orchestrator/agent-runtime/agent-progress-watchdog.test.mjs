import assert from 'node:assert/strict';
import test from 'node:test';
import {
  partialHandoffTextFromSession,
  resolveHandoffMessageStartIndex,
  watchdogPartialHandoffFromError,
} from './agent-progress-watchdog.mjs';

test('partial handoff collects only assistant text appended in the current turn', () => {
  const session = { messages: [{ role: 'assistant', content: 'previous turn' }] };
  const start = resolveHandoffMessageStartIndex(session);
  session.messages.push(
    { role: 'user', content: 'query' },
    { role: 'assistant', content: '  first  ' },
    { role: 'assistant', content: '.' },
    { role: 'tool', content: 'tool output' },
    {
      role: 'assistant',
      content: [
        null,
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'second' },
        { type: 'output_text', text: 'third' },
        { type: 'text', text: 42 },
      ],
    },
    { role: 'assistant', content: { text: 'not a content block array' } }
  );
  assert.equal(start, 1);
  assert.equal(partialHandoffTextFromSession(session, start), 'first\n\nsecond\nthird');
});

test('watchdog handoff preserves supported stale-error messages and the turn boundary', () => {
  const session = {
    messages: [
      { role: 'assistant', content: 'old' },
      { role: 'assistant', content: '  current  ' },
    ],
  };
  for (const message of [
    'agent first transport stale (100ms)',
    'agent first semantic response stale (100ms)',
    'agent first response stale (100ms)',
    'agent task stale (100ms without stream/tool progress)',
    'agent tool running stale (100ms)',
  ]) {
    assert.equal(watchdogPartialHandoffFromError(new Error(message), session, 1), 'current');
  }
});

test('non-watchdog failures do not inspect or salvage the session', () => {
  const session = {
    get messages() {
      throw new Error('non-watchdog failures must not read the transcript');
    },
  };
  for (const error of [null, new Error('cancelled'), new Error('deadline'), { message: 42 }]) {
    assert.equal(watchdogPartialHandoffFromError(error, session), null);
  }
});

test('empty handoffs stay null and message offsets keep their normalization', () => {
  const error = new Error('agent task stale (100ms without progress)');
  for (const session of [
    null,
    { messages: null },
    { messages: [] },
    { messages: [{ role: 'assistant', content: '  .  ' }] },
    { messages: [{ role: 'assistant', content: '  ' }] },
  ]) {
    assert.equal(partialHandoffTextFromSession(session), null);
    assert.equal(watchdogPartialHandoffFromError(error, session), null);
  }
  const session = {
    messages: [
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
  };
  assert.equal(partialHandoffTextFromSession(session, -2), 'first\n\nsecond');
  assert.equal(watchdogPartialHandoffFromError(error, session, '1.9'), 'second');
  assert.equal(watchdogPartialHandoffFromError(error, session, 2), null);
});
