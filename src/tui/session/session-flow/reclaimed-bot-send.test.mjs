// A bot's send queued behind the user's work and then reclaimed by the user:
// the work it owned ends with the reclaim (once), and closing the session
// afterwards does not settle it again.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('../tui-steering-persist.mjs', {
  namedExports: {
    appendTuiSteeringPersist: (_sessionId, entry) => {
      entry.steeringPersistId = `ts_${entry.id}`;
      return Promise.resolve(true);
    },
    dropTuiSteeringPersist: () => Promise.resolve(),
    readTuiSteeringPersist: async () => [],
  },
});
const { createSessionFlow } = await import('../session-flow.mjs');
const { createAgentTaskSessions } = await import('../../../session-runtime/agent-task-sessions.mjs');
const { botWorkBySession, endBotWork } = await import('../../../runtime/shared/bot-owned-work.mjs');

for (const notify of [true, false]) {
  test(`a reclaimed bot send releases its ownership and listener, once (notify ${notify})`, async (t) => {
    const state = { busy: true, commandBusy: false, queued: [] };
    const pending = [];
    let nextId = 0;
    const flow = createSessionFlow({
      runtime: { id: 'sess_task_e2e' },
      flags: {},
      pending,
      pendingNotificationKeys: new Set(),
      getState: () => state,
      set: (patch) => Object.assign(state, patch),
      nextId: () => `queued-${++nextId}`,
      tuiDebug() {},
      pushUserOrSyntheticItem() {},
      flushDeferredExecutionPendingResumeKick() {},
      runTurn: async () => 'done',
    });
    const listeners = new Set();
    const runtime = {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const delivered = [];
    const api = createAgentTaskSessions({
      getSessionService: () => ({
        materializeSession: async () => runtime,
        submitSession: async ({ prompt, options }) => ({ accepted: (await flow.enqueue(prompt, options)) !== false }),
      }),
      deliver: async (_agentId, report) => delivered.push(report),
      watches: { add: async () => {}, list: async () => [], remove: async () => {} },
      loadSession: async () => null,
      pendingWork: async () => false,
      settleMs: 0,
      retryDelaysMs: [],
      log: () => {},
    });
    const owners = () => botWorkBySession().get('sess_task_e2e') ?? [];
    await flow.enqueue('user work', { id: 'user-1', awaitPersistence: true });
    const sent = await api.send('sess_task_e2e', 'bot work', {
      agentId: 'bot_e2e',
      sessionId: 'sess_home_e2e',
      title: 'T',
      notify,
    });
    assert.equal(sent.accepted, true);
    const botId = pending.find((entry) => entry.text === 'bot work').id;
    t.after(() => endBotWork(botId));
    assert.deepEqual(owners(), ['bot_e2e']);
    assert.equal(listeners.size, 1);
    assert.equal(flow.restoreQueued('', botId).count, 1);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(owners(), [], 'the reclaim ends the bot’s work');
    assert.equal(listeners.size, 0, 'and releases the listener');
    flow.settleClosedQueue();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(owners(), []);
    assert.equal(delivered.length, notify ? 1 : 0, 'a reporting send says cancelled once; a quiet one reports nothing');
    if (notify) assert.equal(delivered[0].status, 'cancelled');
  });
}
