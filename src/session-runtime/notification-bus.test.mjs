import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompletionWakeScheduler, createNotificationBus } from './notification-bus.mjs';

const completionText = [
  '<task-notification>',
  '<task-id>task-agent-1</task-id>',
  '<tag>review</tag>',
  '<status>completed</status>',
  '<summary>Agent "review" completed</summary>',
  '<result>',
  'worker handoff',
  '</result>',
  '</task-notification>',
].join('\n');

const completionMeta = {
  type: 'agent_task_result',
  execution_surface: 'agent',
  execution_id: 'task-agent-1',
  status: 'completed',
};

test('session-id authority delivers to only the requested Lead among simultaneous listeners', () => {
  const enqueued = [];
  const deliveries = { a: [], b: [] };
  const mgr = {
    enqueuePendingMessage(sessionId, message) {
      enqueued.push({ sessionId, message });
      return 1;
    },
  };
  const busA = createNotificationBus({ listeners: new Set(), mgr });
  const busB = createNotificationBus({ listeners: new Set(), mgr });
  busA.subscribeRuntimeNotification('lead-a', (event) => {
    deliveries.a.push(event);
    event.modelVisibleDelivered = true;
    return true;
  });
  busB.subscribeRuntimeNotification('lead-b', (event) => {
    deliveries.b.push(event);
    event.modelVisibleDelivered = true;
    return true;
  });

  const delivered = busB.notifySessionCompletion('lead-a', completionText, {
    ...completionMeta,
    caller_session_id: 'lead-b',
    routing_session_id: 'lead-b',
  });

  assert.equal(delivered, true);
  assert.equal(deliveries.a.length, 1);
  assert.equal(deliveries.b.length, 0);
  assert.equal(deliveries.a[0].meta.caller_session_id, 'lead-a');
  assert.equal(Object.hasOwn(deliveries.a[0].meta, 'routing_session_id'), false);
  assert.equal(enqueued.length, 0);
  busA.clearRuntimeNotifications();
  busB.clearRuntimeNotifications();
  busB.notifySessionCompletion('lead-a', completionText, {
    ...completionMeta,
    execution_id: 'task-agent-after-close',
  });
  assert.equal(deliveries.a.length, 1);
  assert.equal(deliveries.b.length, 0);
});

test('session-id authority queues an unobserved completion only for its owner', () => {
  const enqueued = [];
  const secondText = completionText.replaceAll('task-agent-1', 'task-agent-2');
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr: {
      enqueuePendingMessage(sessionId, message) {
        enqueued.push({ sessionId, message });
        return 1;
      },
    },
  });

  const delivered = bus.notifyFnForSession('lead-owner')(secondText, {
    ...completionMeta,
    execution_id: 'task-agent-2',
    caller_session_id: 'wrong-session',
    routing_session_id: 'wrong-session',
  });

  assert.equal(delivered, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sessionId, 'lead-owner');
  assert.match(String(enqueued[0].message?.content || enqueued[0].message), /worker handoff/);
  assert.equal(enqueued[0].message.content, secondText);
  assert.equal(enqueued[0].message.mode, 'task-notification');
  assert.equal(enqueued[0].message.execution.id, 'task-agent-2');
});

test('runtime notifications stay live before session materialization and bind on reservation', () => {
  const received = [];
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr: {
      enqueuePendingMessage() {
        return 1;
      },
    },
  });
  const unsubscribe = bus.subscribeRuntimeNotification('', (event) => {
    received.push(event.content);
    event.modelVisibleDelivered = true;
    return true;
  });

  assert.equal(bus.emitRuntimeNotification('channel-before-first-chat').handled, true);
  assert.deepEqual(received, ['channel-before-first-chat']);

  assert.equal(bus.bindRuntimeNotificationSession('lead-reserved'), true);
  assert.equal(bus.notifySession('lead-reserved', 'channel-targeted'), true);
  assert.equal(
    bus.notifySessionCompletion('lead-reserved', completionText, {
      ...completionMeta,
      execution_id: 'task-agent-reserved',
    }),
    true
  );
  assert.equal(received.length, 3);
  unsubscribe();
});

test('unobserved completion fallback queues and wakes exactly once', () => {
  const enqueued = [];
  const wakeups = [];
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr: {
      enqueuePendingMessage(sessionId, message) {
        enqueued.push({ sessionId, message });
        return 1;
      },
    },
    onCompletionQueued(info) {
      wakeups.push(info);
    },
  });
  const meta = {
    ...completionMeta,
    execution_id: 'task-agent-idempotent',
  };
  const uniqueCompletionText = completionText.replaceAll('task-agent-1', 'task-agent-idempotent');
  assert.equal(bus.notifySessionCompletion('lead-idempotent', uniqueCompletionText, meta), true);
  assert.equal(bus.notifySessionCompletion('lead-idempotent', uniqueCompletionText, meta), true);
  assert.equal(enqueued.length, 1);
  assert.equal(wakeups.length, 1);
  assert.equal(wakeups[0].sessionId, 'lead-idempotent');
  assert.match(enqueued[0].message.id, /^completion_[a-f0-9]{24}$/);
});

test('a throwing wake hook keeps the queued completion delivered; an unsubscribed listener leaves its session', () => {
  const enqueued = [];
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr: {
      enqueuePendingMessage(sessionId, message) {
        enqueued.push({ sessionId, message });
        return 1;
      },
    },
    onCompletionQueued() {
      throw new Error('wake failed');
    },
  });
  const text = completionText.replaceAll('task-agent-1', 'task-agent-wake-throws');
  const meta = { ...completionMeta, execution_id: 'task-agent-wake-throws' };
  assert.equal(bus.notifySessionCompletion('lead-wake-throws', text, meta), true);
  assert.equal(enqueued.length, 1);

  const received = [];
  const unsubscribe = bus.subscribeRuntimeNotification('lead-unsub', (event) => {
    received.push(event.content);
    return true;
  });
  assert.equal(bus.notifySessionUi('lead-unsub', 'first'), true);
  unsubscribe();
  assert.equal(bus.notifySessionUi('lead-unsub', 'second'), false);
  assert.deepEqual(received, ['first']);
});

function wakeFixture({ currentSessionId = 'lead-wake', turnApi = undefined } = {}) {
  const asks = [];
  const api =
    turnApi === undefined
      ? {
          ask: async (prompt, options) => {
            asks.push({ prompt, options });
          },
        }
      : turnApi;
  const wake = createCompletionWakeScheduler({
    getCurrentSessionId: () => currentSessionId,
    getTurnApi: () => api,
  });
  return { wake, asks };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a queued completion wakes its owner session with an empty turn', async () => {
  const { wake, asks } = wakeFixture();

  assert.equal(wake({ sessionId: 'lead-wake', executionId: 'exec-1', enqueuedAt: 4242 }), true);
  await settled();

  assert.deepEqual(asks, [{ prompt: '', options: { submittedAt: 4242, continueTurn: true } }]);
});

test('one wake per session is in flight, and a suppressed wake replays afterwards', async () => {
  const { wake, asks } = wakeFixture();

  assert.equal(wake({ sessionId: 'lead-wake', enqueuedAt: 30 }), true);
  assert.equal(wake({ sessionId: 'lead-wake', enqueuedAt: 20 }), false);
  assert.equal(wake({ sessionId: '   ' }), false);
  await settled();
  assert.deepEqual(asks, [{ prompt: '', options: { submittedAt: 30, continueTurn: true } }]);

  // The suppressed completion may have landed after the woken turn took its
  // last look at the queue, so it gets its own wake — oldest wait first.
  await settled();
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[1], { prompt: '', options: { submittedAt: 20, continueTurn: true } });

  await settled();
  assert.equal(asks.length, 2, 'a replay that suppressed nothing ends the chain');

  assert.equal(wake({ sessionId: 'lead-wake' }), true);
  await settled();
  assert.equal(asks.length, 3);
});

test('beforeWake hook runs before the wake turn and a failing hook never blocks it', async () => {
  const order = [];
  const make = (beforeWake) =>
    createCompletionWakeScheduler({
      getCurrentSessionId: () => 'lead-wake',
      getTurnApi: () => ({ ask: async () => order.push('ask') }),
      beforeWake,
    });
  const slow = make(async () => {
    await settled();
    order.push('hook');
  });
  slow({ sessionId: 'lead-wake' });
  await settled();
  await settled();
  assert.deepEqual(order, ['hook', 'ask']);

  order.length = 0;
  const failing = make(async () => {
    throw new Error('compact failed');
  });
  failing({ sessionId: 'lead-wake' });
  await settled();
  await settled();
  assert.deepEqual(order, ['ask']);
});

test('a completion whose owner is no longer the live session never starts a turn', async () => {
  const { wake, asks } = wakeFixture({ currentSessionId: 'lead-other' });

  assert.equal(wake({ sessionId: 'lead-wake' }), true);
  await settled();

  assert.deepEqual(asks, []);
});

test('a wake before the turn api exists is dropped instead of throwing', async () => {
  const { wake } = wakeFixture({ turnApi: null });

  assert.equal(wake({ sessionId: 'lead-wake' }), true);
  await settled();
});
