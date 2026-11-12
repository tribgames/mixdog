import assert from 'node:assert/strict';
import test from 'node:test';

import { createEntryLifecycle } from './lifecycle.mjs';

test("an agent's status change leaves as one agent-status frame to the session's subscribers, each on its own key", async () => {
  const frames = [];
  let push = null;
  let stopped = 0;
  const runtime = {
    getState: () => ({ sessionId: 'sess_lead' }),
    subscribe: () => () => {},
    onAgentStatusRows(listener) {
      push = listener;
      return () => {
        stopped += 1;
      };
    },
  };
  const sessions = new Set();
  const { createEntry, destroy } = createEntryLifecycle({
    createRuntime: async () => runtime,
    revisionEpoch: 0,
    sessions,
    sessionsById: new Map(),
    pendingDisposals: new Set(),
    desktopServices: null,
    onFrame: (frame, targets) => frames.push({ frame, targets: [...targets] }),
    log: () => {},
    isClosed: () => false,
    indexSessionEntry: () => {},
    schedulePublish: () => {},
    subscriberToken: (ctx) => ctx?.token || null,
    addSubscriber: (entry, ctx) => entry.subscribers.add(ctx.token),
    updateEntryBusy: () => {},
    releaseProjection: () => {},
    idleStateChanged: () => {},
  });
  const entry = await createEntry({ sessionId: 'sess_lead' }, { token: 'client-a' });
  const row = { sessionId: 'sess_w', status: 'running' };
  push({ sessionId: 'sess_lead', epoch: 'e', seq: 1, list: 'workers', id: 'sess_w', order: [0, 1], row });
  push({ sessionId: 'sess_lead', epoch: 'e', seq: 2, list: 'workers', id: 'sess_w', removed: true });
  assert.deepEqual(frames, [
    {
      frame: {
        type: 'agent-status',
        key: 'agent-status:sess_lead:1',
        sessionId: 'sess_lead',
        epoch: 'e',
        seq: 1,
        list: 'workers',
        id: 'sess_w',
        order: [0, 1],
        row,
      },
      targets: ['client-a'],
    },
    {
      frame: {
        type: 'agent-status',
        key: 'agent-status:sess_lead:2',
        sessionId: 'sess_lead',
        epoch: 'e',
        seq: 2,
        list: 'workers',
        id: 'sess_w',
        removed: true,
      },
      targets: ['client-a'],
    },
  ]);
  await destroy(entry, 'test', { announce: false });
  assert.equal(stopped, 1, 'the row subscription ends with the entry');
});
