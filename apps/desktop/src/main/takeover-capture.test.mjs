import assert from 'node:assert/strict';
import test from 'node:test';

import { waitUntil } from './bounded-wait.mjs';
import { captureTakeoverOrDecline } from './takeover-capture.ts';

function fixture({ capture = () => {}, decline = async () => true } = {}) {
  const calls = { captured: [], declined: [], reports: [] };
  const deps = {
    capture: (...args) => (calls.captured.push(args), capture(...args)),
    decline: (...args) => (calls.declined.push(args), decline(...args)),
    report: (event, details) => calls.reports.push([event, details]),
  };
  return { deps, calls };
}

test('a takeover whose page is fixed is left pending for the user', () => {
  const { deps, calls } = fixture();
  assert.equal(captureTakeoverOrDecline(deps, 's1', 't1', 'v2'), true);
  assert.deepEqual(calls.captured, [['s1', 't1', 'v2']]);
  assert.deepEqual(calls.declined, []);
  assert.deepEqual(calls.reports, []);
});

test('a tab that cannot be handed over declines the pending takeover with that error and reports it', () => {
  const failure = 'Cannot hand over tab "v9": no page "v9".';
  const { deps, calls } = fixture({
    capture: () => {
      throw new Error(failure);
    },
  });
  assert.equal(captureTakeoverOrDecline(deps, 's1', 't2', 'v9'), false);
  assert.deepEqual(calls.declined, [['s1', 't2', failure]]);
  assert.deepEqual(calls.reports, [['takeover-capture-failed', { sessionId: 's1', id: 't2', tab: 'v9', message: failure }]]);
});

test('a decline that is itself refused is reported, not lost', async () => {
  const { deps, calls } = fixture({
    capture: () => {
      throw new Error('no page');
    },
    decline: () => Promise.reject(new Error('service stopped')),
  });
  assert.equal(captureTakeoverOrDecline(deps, 's1', 't3', 'v1'), false);
  await waitUntil(() => calls.reports.length === 2, 'the refused decline to be reported');
  assert.deepEqual(calls.reports[1], [
    'takeover-decline-failed',
    { sessionId: 's1', id: 't3', message: 'service stopped' },
  ]);
});
