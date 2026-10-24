import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BROWSER_APPROVAL_SESSIONS_EVENT } from '../shared/browser-approval-sessions.ts';
import { createDesktopOperations } from './desktop-operations.ts';
import { createRelayPushLanes } from './remote-relay-push-lanes.ts';

test('the window publishes its waiting sessions through the desktop operations, which keep the last list', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-approval-marks-'));
  const events = [];
  const operations = createDesktopOperations({ userDataPath: directory, emit: (event) => events.push(event) });
  t.after(async () => {
    await operations.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  assert.deepEqual(await operations.invoke('readBrowserApprovalSessions', []), []);
  await operations.invoke('publishBrowserApprovalSessions', [['sess_a', 'sess_a', 'sess_b']]);
  assert.deepEqual(events.at(-1), { name: BROWSER_APPROVAL_SESSIONS_EVENT, value: ['sess_a', 'sess_b'] });
  assert.deepEqual(await operations.invoke('readBrowserApprovalSessions', []), ['sess_a', 'sess_b']);
  await assert.rejects(operations.invoke('publishBrowserApprovalSessions', [[{ id: 'x' }]]), /invalid/);
  // The relay seeded from it starts with that list.
  const seeded = createRelayPushLanes({
    clients: new Map(),
    broadcastEncrypted: () => {},
    readBrowserApprovalSessions: () => operations.invoke('readBrowserApprovalSessions', []),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seeded.joinFrames()[0].payload, ['sess_a', 'sess_b']);
  seeded.dispose();
});

function lanes({ clients = 1, seed } = {}) {
  const sent = [];
  let emit = () => {};
  const pushLanes = createRelayPushLanes({
    clients: new Map(Array.from({ length: clients }, (_, i) => [`c${i}`, { channel: {}, lanes: new Set() }])),
    broadcastEncrypted: (payload, droppable) => sent.push({ payload, droppable }),
    subscribeDesktopEvents: (listener) => {
      emit = listener;
      return () => {};
    },
    readBrowserApprovalSessions: seed,
  });
  return { sent, pushLanes, emit: (name, value) => emit({ name, value }) };
}

test('the browser-approval sessions reach every device undroppably, and join with the latest list', async () => {
  const h = lanes();
  h.emit(BROWSER_APPROVAL_SESSIONS_EVENT, ['sess_a', 'sess_b']);
  assert.deepEqual(h.sent, [
    { payload: { event: BROWSER_APPROVAL_SESSIONS_EVENT, payload: ['sess_a', 'sess_b'] }, droppable: false },
  ]);
  assert.deepEqual(h.pushLanes.joinFrames(), [{ event: BROWSER_APPROVAL_SESSIONS_EVENT, payload: ['sess_a', 'sess_b'] }]);
  h.emit(BROWSER_APPROVAL_SESSIONS_EVENT, []);
  assert.deepEqual(h.sent.at(-1).payload.payload, []);
  assert.deepEqual(h.pushLanes.joinFrames()[0].payload, []);
  // A malformed publication changes nothing.
  h.emit(BROWSER_APPROVAL_SESSIONS_EVENT, 'sess_x');
  assert.equal(h.sent.length, 2);
  h.pushLanes.dispose();
});

test('a device that joined before the seed answered is sent the seeded list', async () => {
  let answer;
  const h = lanes({ clients: 1, seed: () => new Promise((resolve) => (answer = resolve)) });
  assert.deepEqual(h.pushLanes.joinFrames()[0].payload, [], 'the early handshake baseline');
  answer(['sess_waiting']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.sent, [
    { payload: { event: BROWSER_APPROVAL_SESSIONS_EVENT, payload: ['sess_waiting'] }, droppable: false },
  ]);
  assert.deepEqual(h.pushLanes.joinFrames()[0].payload, ['sess_waiting']);
  h.pushLanes.dispose();
});

test('a list published before the lanes started is the join baseline until the next publication', async () => {
  const h = lanes({ clients: 0, seed: async () => ['sess_early'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.pushLanes.joinFrames()[0].payload, ['sess_early']);
  h.emit(BROWSER_APPROVAL_SESSIONS_EVENT, []);
  assert.deepEqual(h.pushLanes.joinFrames()[0].payload, [], 'kept even with no device attached');
  assert.equal(h.sent.length, 0, 'nothing to broadcast to');
  // A seed answering after a publication never overrides it.
  let answer;
  const late = lanes({ seed: () => new Promise((resolve) => (answer = resolve)) });
  late.emit(BROWSER_APPROVAL_SESSIONS_EVENT, ['sess_now']);
  answer(['sess_stale']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(late.pushLanes.joinFrames()[0].payload, ['sess_now']);
});
