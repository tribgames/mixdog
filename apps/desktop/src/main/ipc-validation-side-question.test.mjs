import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_CONFIGURE_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { longRunningRequestTimeout } from './local-provider-install-timeout.ts';
import { createRemoteCallQueue } from './remote-call-queue.ts';

test('/btw capabilities: askSide takes one question, cancelSide nothing', () => {
  for (const capability of ['askSide', 'cancelSide']) {
    assert.equal(DESKTOP_CAPABILITIES.includes(capability), true);
    assert.equal(DESKTOP_READ_CAPABILITIES.includes(capability), false);
    assert.equal(SESSION_CONFIGURE_ACTIONS.includes(capability), true, 'routed through session.configure');
  }
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'askSide', args: ['Why?'], sessionId: 's' }), {
    capability: 'askSide',
    args: ['Why?'],
    sessionId: 's',
  });
  for (const args of [[], [''], ['   '], [3], ['a', 'b']]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'askSide', args }), TypeError);
  }
  assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability: 'cancelSide', sessionId: 's' }));
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'cancelSide', args: ['x'] }), TypeError);
  assert.throws(
    () => requiredDesktopCapabilityReadRequests([{ capability: 'askSide', args: ['Why?'] }]),
    /not read-only/
  );
});

test('a side question has a model-response deadline', () => {
  assert.ok(longRunningRequestTimeout('askSide', ['Why?']) >= 10 * 60_000);
  assert.equal(longRunningRequestTimeout('cancelSide', []), undefined);
});

test('a remote side question does not hold later calls, its cancel included', async () => {
  const queue = createRemoteCallQueue();
  let finishAsk;
  let markStarted;
  const started = new Promise((resolve) => (markStarted = resolve));
  const ask = queue.run('invokeCapability:askSide', () => {
    markStarted();
    return new Promise((resolve) => (finishAsk = resolve));
  });
  await started;
  let cancelled = false;
  await queue.run('invokeCapability:cancelSide', async () => {
    cancelled = true;
  });
  assert.equal(cancelled, true);
  finishAsk();
  await ask;
  queue.close();
});

test('a queued side question is withdrawn by its session cancel or a newer ask, never run late', async () => {
  const queue = createRemoteCallQueue();
  const ran = [];
  const answered = [];
  const holds = [];
  const ask = (sessionId, label, hold = false) =>
    queue.run(
      'invokeCapability:askSide',
      async () => {
        ran.push(label);
        if (hold) await new Promise((resolve) => holds.push(resolve));
      },
      {
        sessionId,
        superseded: async () => {
          answered.push(`${label}:canceled`);
        },
      }
    );
  // Both side slots busy (two other sessions), so the next asks queue.
  const busy = [ask('s1', 'busy-1', true), ask('s2', 'busy-2', true)];
  while (holds.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const queuedOld = ask('s3', 'queued-old');
  const queuedNew = ask('s3', 'queued-new');
  await queuedOld;
  assert.deepEqual(answered, ['queued-old:canceled'], 'a newer ask of the session replaces the queued one');
  const otherSession = ask('s4', 'other-session');
  await queue.run('invokeCapability:cancelSide', async () => ran.push('cancel'), { sessionId: 's3' });
  await queuedNew;
  assert.deepEqual(answered, ['queued-old:canceled', 'queued-new:canceled']);
  for (const release of holds) release();
  await Promise.all([...busy, otherSession]);
  // The withdrawn asks never ran; another session's queued ask still did.
  assert.deepEqual(ran, ['busy-1', 'busy-2', 'cancel', 'other-session']);
  queue.close();
});
