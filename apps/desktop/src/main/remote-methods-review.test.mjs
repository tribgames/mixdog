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
