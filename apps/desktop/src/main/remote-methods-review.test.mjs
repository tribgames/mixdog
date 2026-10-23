import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;

// The daemon answers a session-addressed call with that session's whole
// snapshot. A phone's turn review re-read must not carry the conversation.
test('a remote turn review answers its value without the session snapshot', async () => {
  const calls = [];
  const transcript = { sessionId: SESSION, items: [{ kind: 'assistant', text: 'x'.repeat(50_000) }] };
  const methods = createRemoteMethods({
    host: {
      async invokeCapability(capability, args, sessionId) {
        calls.push([capability, sessionId]);
        return { value: { supported: true, capability }, snapshot: transcript };
      },
    },
  });
  const review = await methods.invokeCapability([
    { capability: 'getTurnReviewDiff', args: [{ refresh: true }], sessionId: SESSION },
  ]);
  assert.deepEqual(review, { value: { supported: true, capability: 'getTurnReviewDiff' } });
  assert.ok(JSON.stringify(review).length < 200);
  // Every other capability keeps its snapshot: callers apply it.
  const other = await methods.invokeCapability([{ capability: 'contextStatus', sessionId: SESSION }]);
  assert.equal(other.snapshot, transcript);
  assert.deepEqual(calls, [
    ['getTurnReviewDiff', SESSION],
    ['contextStatus', SESSION],
  ]);
});

// The phone's session diff read is re-run by the scheduler; its only reader
// (session-diff-cache) takes `.value`, so the transcript must not ride along
// and queue ahead of the next history page.
test('a remote session diff answers its value without the session snapshot', async (t) => {
  const transcript = {
    sessionId: SESSION,
    items: Array.from({ length: 600 }, (_, index) => ({
      kind: index % 2 ? 'assistant' : 'user',
      id: `item-${index}`,
      text: `${index} ${'line of a long conversation '.repeat(22)}`,
    })),
  };
  const value = { supported: true, files: [{ id: 'src/a.ts', status: 'M' }], patch: '' };
  const methods = createRemoteMethods({
    host: {
      async invokeCapability() {
        return { value, snapshot: transcript };
      },
    },
  });
  const reply = await methods.invokeCapability([{ capability: 'getSessionReviewDiff', args: [], sessionId: SESSION }]);
  assert.deepEqual(reply, { value });
  assert.equal('snapshot' in reply, false);
  const unshaped = JSON.stringify({ value, snapshot: transcript }).length;
  const shaped = JSON.stringify(reply).length;
  t.diagnostic(`getSessionReviewDiff reply: ${unshaped} bytes with snapshot, ${shaped} bytes value-only`);
  assert.ok(unshaped > 300_000);
  assert.ok(shaped < 500);
});

// The composer re-reads its session's skills on focus and on every skill
// change signal; on a phone each of those would otherwise ship the transcript.
test('a remote session skill status answers its value without the session snapshot', async () => {
  const transcript = { sessionId: SESSION, items: [{ kind: 'assistant', text: 'x'.repeat(50_000) }] };
  const methods = createRemoteMethods({
    host: {
      async invokeCapability(capability, _args, sessionId) {
        return { value: { skills: [{ name: 'api-review', activeHere: true }], sessionId }, snapshot: transcript };
      },
    },
  });
  const status = await methods.invokeCapability([{ capability: 'skillsStatus', sessionId: SESSION }]);
  assert.deepEqual(status, { value: { skills: [{ name: 'api-review', activeHere: true }], sessionId: SESSION } });
  assert.ok(JSON.stringify(status).length < 300);
});
