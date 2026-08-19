import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotificationBus } from './notification-bus.mjs';

const completionText = [
  'background task',
  'task_id: task-agent-1',
  'surface: agent',
  'status: completed',
  '',
  'agent result tag=review agent=worker',
  'worker handoff',
].join('\n');

const completionMeta = {
  type: 'agent_task_result',
  execution_surface: 'agent',
  execution_id: 'task-agent-1',
  status: 'completed',
  instruction: 'Async agent task task-agent-1 (completed) finished.',
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

  const delivered = bus.notifyFnForSession('lead-owner')(
    secondText,
    {
      ...completionMeta,
      execution_id: 'task-agent-2',
      caller_session_id: 'wrong-session',
      routing_session_id: 'wrong-session',
    },
  );

  assert.equal(delivered, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sessionId, 'lead-owner');
  assert.match(String(enqueued[0].message?.content || enqueued[0].message), /worker handoff/);
});

test('runtime notifications stay live before session materialization and bind on reservation', () => {
  const received = [];
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr: { enqueuePendingMessage() { return 1; } },
  });
  const unsubscribe = bus.subscribeRuntimeNotification('', (event) => {
    received.push(event.content);
    event.modelVisibleDelivered = true;
    return true;
  });

  assert.equal(bus.emitRuntimeNotification('discord-before-first-chat').handled, true);
  assert.deepEqual(received, ['discord-before-first-chat']);

  assert.equal(bus.bindRuntimeNotificationSession('lead-reserved'), true);
  assert.equal(bus.notifySession('lead-reserved', 'discord-targeted'), true);
  assert.equal(bus.notifySessionCompletion('lead-reserved', completionText, {
    ...completionMeta,
    execution_id: 'task-agent-reserved',
  }), true);
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
