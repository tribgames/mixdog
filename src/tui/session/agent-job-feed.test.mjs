// Characterization of the agent-job feed: pending-resume kick merging and
// tombstones, the agent-job card patch, and runtime.onNotification routing
// (UI-only kinds, plain enqueue, execution completions with dedup + ack,
// status-only refresh, image FIFO ordering, unsubscribe cleanup).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentJobFeed } from './agent-job-feed.mjs';
import { notificationQueueKey, resolveTuiRuntimeNotificationDelivery } from './notification-plan.mjs';
import { parseAgentJob } from './agent-envelope.mjs';
import { sleep } from '../../runtime/shared/sleep.mjs';
import { _clearDeliveredCompletions } from '../../runtime/agent/orchestrator/session/manager/delivered-completions.mjs';
import { renderAgentCompletionEnvelope } from '../../runtime/shared/task-notification-envelope.mjs';

function makeHarness({ busy = false } = {}) {
  const calls = [];
  const sets = [];
  const pending = [];
  const state = { busy, items: [], provider: '' };
  const displayedExecutionNotificationKeys = new Set();
  const itemIndexById = new Map();
  let handler = null;
  let nextId = 0;
  const h = {
    calls,
    sets,
    pending,
    state,
    displayedExecutionNotificationKeys,
    itemIndexById,
    clock: 1_000_000,
    disposed: false,
    enqueueResult: true,
    named: (name) => calls.filter((entry) => entry[0] === name),
    notify: (event) => handler(event),
  };
  h.feed = createAgentJobFeed({
    runtime: {
      onNotification: (fn) => {
        handler = fn;
        return () => calls.push(['unsubscribe']);
      },
    },
    getState: () => state,
    set: (patch) => {
      sets.push(patch);
      Object.assign(state, patch);
    },
    nextId: () => `item-${++nextId}`,
    getDisposed: () => h.disposed,
    patchItem: (id, patch) => calls.push(['patchItem', id, patch]),
    enqueue: (content, opts) => {
      calls.push(['enqueue', content, opts]);
      return h.enqueueResult;
    },
    drain: () => calls.push(['drain']),
    pushUserOrSyntheticItem: (...args) => calls.push(['pushUser', ...args]),
    pushAsyncAgentResponse: (text, id, kind, meta) => calls.push(['pushResponse', text, id, kind, meta]),
    makeQueueEntry: (body, opts) => ({ body, ...opts }),
    getPending: () => pending,
    agentStatusState: (opts) => ({ agentStatus: opts?.force ? 'forced' : 'refreshed' }),
    displayedExecutionNotificationKeys,
    itemIndexById,
    pushNotice: (text, tone, opts) => calls.push(['notice', text, tone, opts]),
    now: () => h.clock,
  });
  h.unsubscribe = h.feed.subscribeRuntimeNotifications();
  return h;
}

function completionEvent(executionId, body, status = 'completed') {
  const text = body
    ? renderAgentCompletionEnvelope({ id: executionId, status, result: body })
    : `agent task: ${executionId}\nstatus: ${status}`;
  return {
    text,
    event: { content: text, meta: { execution_id: executionId, status, execution_surface: 'agent' } },
  };
}

test.beforeEach(() => _clearDeliveredCompletions());

test('kickExecutionPendingResume queues one merged pending-resume turn when idle and defers while busy', () => {
  const h = makeHarness();
  h.feed.kickExecutionPendingResume('body A', 'exec-a');
  assert.deepEqual(h.pending, [
    {
      body: 'body A',
      mode: 'pending-resume',
      priority: 'next',
      abortDiscardOnAbort: true,
      resumeCompletionKeys: ['execution:exec-a'],
    },
  ]);
  assert.equal(h.named('drain').length, 1);

  h.pending.length = 0;
  h.state.busy = true;
  h.feed.kickExecutionPendingResume('body B', 'exec-b');
  h.feed.kickExecutionPendingResume('body C', { executionId: 'exec-c' });
  h.feed.flushDeferredExecutionPendingResumeKick();
  assert.deepEqual(h.pending, [], 'busy: bodies accumulate, nothing is queued');

  h.state.busy = false;
  h.feed.flushDeferredExecutionPendingResumeKick();
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].body, 'body B\n\nbody C');
  assert.deepEqual(h.pending[0].resumeCompletionKeys, ['execution:exec-b', 'execution:exec-c']);
  assert.equal(h.named('drain').length, 2);

  h.feed.kickExecutionPendingResume('body D', 'exec-d');
  assert.equal(h.pending.length, 1, 'an already-queued pending-resume entry defers the next kick');
});

test('discardExecutionPendingResume drops queued bodies and tombstones their keys for the TTL', () => {
  const h = makeHarness({ busy: true });
  h.feed.kickExecutionPendingResume('body X', 'exec-x');
  h.feed.discardExecutionPendingResume(['exec-x']);
  h.state.busy = false;
  h.feed.flushDeferredExecutionPendingResumeKick();
  assert.deepEqual(h.pending, [], 'the discarded body never reaches the queue');

  h.feed.kickExecutionPendingResume('body X again', 'exec-x');
  assert.deepEqual(h.pending, [], 'a late duplicate of a discarded completion is ignored');

  h.clock += 31_000;
  h.feed.kickExecutionPendingResume('body X later', 'exec-x');
  assert.equal(h.pending.length, 1, 'the tombstone expires after its TTL');
  assert.equal(h.pending[0].body, 'body X later');
});

test('scheduleExecutionPendingResumeKick kicks on a microtask', async () => {
  const h = makeHarness();
  h.feed.scheduleExecutionPendingResumeKick('scheduled', 'exec-s');
  assert.deepEqual(h.pending, []);
  await Promise.resolve();
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].body, 'scheduled');
});

test('buildAgentJobCardPatch merges the parsed envelope into the card args and formats errors', () => {
  const h = makeHarness();
  h.state.items = [{ id: 'card-1', args: { type: 'spawn', agent: 'Reviewer' } }];
  h.itemIndexById.set('card-1', 0);
  const text = 'agent task: task-9\nstatus: completed\ntype: spawn\nagent: Reviewer\n\nAll good.';
  assert.deepEqual(h.feed.buildAgentJobCardPatch('card-1', text), {
    result: 'All good.',
    text: 'All good.',
    isError: false,
    errorCount: 0,
    args: { type: 'spawn', agent: 'Reviewer', jobType: 'spawn', status: 'completed', task_id: 'task-9' },
  });
  h.feed.updateAgentJobCard('card-1', text);
  assert.equal(h.named('patchItem').length, 1);
  assert.equal(h.named('patchItem')[0][1], 'card-1');

  assert.deepEqual(h.feed.buildAgentJobCardPatch('card-1', 'boom', true), {
    result: 'Error: boom',
    text: 'Error: boom',
    isError: true,
    errorCount: 1,
  });
});

test('UI-only notification kinds update the store or raise a notice without touching the queue', () => {
  const h = makeHarness();
  assert.equal(h.notify({ content: 'open', meta: { kind: 'setup-ui', id: 'providers' } }), true);
  assert.equal(h.sets.at(-1).setupUiRequest.id, 'providers');

  h.notify({ content: 'open', meta: { kind: 'ui-open', command: '/Settings' } });
  h.notify({ content: 'open', meta: { kind: 'ui-open', command: 'settings' } });
  const opens = h.sets.filter((patch) => patch.uiOpenRequest).map((patch) => patch.uiOpenRequest);
  assert.deepEqual(
    opens.map(({ command, seq }) => ({ command, seq })),
    [
      { command: 'settings', seq: 1 },
      { command: 'settings', seq: 2 },
    ]
  );

  h.notify({ content: 'update', meta: { kind: 'update-notice', version: '1.2.3' } });
  assert.deepEqual(h.named('notice'), [
    ['notice', 'mixdog v1.2.3 ready — restart to apply.', 'info', { transcript: false }],
  ]);
  assert.deepEqual(h.named('enqueue'), []);
  assert.equal(h.notify({ content: '   ' }), undefined, 'blank notifications are ignored');
});

test('a plain notification is enqueued as a later task notification; a disposed feed ignores it', () => {
  const h = makeHarness();
  assert.equal(h.notify({ content: 'Reminder: standup' }), true);
  assert.deepEqual(h.named('enqueue'), [
    [
      'enqueue',
      'Reminder: standup',
      { mode: 'task-notification', priority: 'later', key: undefined, displayText: 'Reminder: standup' },
    ],
  ]);
  h.disposed = true;
  h.notify({ content: 'Reminder: retro' });
  assert.equal(h.named('enqueue').length, 1);
});

test('an execution completion pushes one response card, enqueues the model-visible twin once and acks delivery', async () => {
  const h = makeHarness();
  const { text, event } = completionEvent('exec-100', 'Done: reviewed 3 files.');
  event.meta.type = 'agent_task_result';
  const delivery = resolveTuiRuntimeNotificationDelivery(event, text);
  assert.equal(delivery.action, 'execution-ui');
  assert.ok(delivery.modelContent);

  assert.equal(h.notify(event), true);
  assert.deepEqual(h.named('pushResponse'), [
    [
      'pushResponse',
      text,
      'item-1',
      'injected',
      { responseKey: 'exec-100', executionSurface: 'agent', executionStatus: 'completed' },
    ],
  ]);
  assert.deepEqual(h.named('enqueue'), [
    [
      'enqueue',
      delivery.modelContent,
      {
        mode: 'task-notification',
        execution: { surface: 'agent', id: 'exec-100', status: 'completed', resultType: 'agent_task_result' },
        priority: 'next',
        key: notificationQueueKey(event, text, parseAgentJob(text)),
        abortDiscardOnAbort: true,
        resumeCompletionKeys: ['execution:exec-100'],
        displayText: text,
        suppressDisplay: true,
      },
    ],
  ]);
  assert.equal(event.modelVisibleDelivered, true);

  const again = { ...event, meta: { ...event.meta } };
  assert.equal(h.notify(again), true);
  assert.equal(h.named('pushResponse').length, 1, 'the same card is not pushed twice');
  assert.equal(h.named('enqueue').length, 1, 'the delivered completion is not enqueued twice');
  assert.equal(again.modelVisibleDelivered, true, 'the duplicate is still acked so the runtime does not mirror it');

  await sleep(40);
  assert.deepEqual(h.sets.at(-1), { agentStatus: 'forced' }, 'a terminal status forces one coalesced refresh');
});

test('a running preview and its later body-carrying completion each get a card', () => {
  const h = makeHarness();
  const preview = completionEvent('exec-200', '', 'running');
  h.notify(preview.event);
  assert.equal(h.named('pushResponse').length, 1);
  const done = completionEvent('exec-200', 'Finished.');
  h.notify(done.event);
  assert.equal(h.named('pushResponse').length, 2);
  assert.equal(h.named('pushResponse')[1][1], done.text);
  assert.equal(h.named('enqueue').length, 1);
  assert.equal(h.named('enqueue')[0][2].resumeCompletionKeys[0], 'execution:exec-200');
});

test('a status-only completion only refreshes the agent status', async () => {
  const h = makeHarness();
  const { event } = completionEvent('exec-300', '');
  assert.equal(h.notify(event), true);
  assert.deepEqual(h.named('pushResponse'), []);
  assert.deepEqual(h.named('enqueue'), []);
  await sleep(40);
  assert.deepEqual(h.sets, [{ agentStatus: 'forced' }]);
});

test('image notifications resolve before enqueue and later text notifications queue behind them in order', async () => {
  const h = makeHarness();
  const first = {
    content: 'first',
    meta: { image_paths: JSON.stringify(['C:/definitely/missing/one.png']) },
  };
  assert.equal(h.notify(first), true);
  assert.equal(h.notify({ content: 'second' }), true);
  assert.deepEqual(h.named('enqueue'), [], 'both wait on the FIFO chain');
  await sleep(20);
  assert.deepEqual(
    h.named('enqueue').map((entry) => entry[1]),
    ['first', 'second']
  );
  assert.equal(h.notify({ content: 'third' }), true);
  assert.equal(h.named('enqueue').at(-1)[1], 'third', 'an idle chain enqueues synchronously');
  assert.equal(h.notify({ content: 'fourth', meta: { image_paths: 'not-json' } }), true);
  assert.equal(h.named('enqueue').at(-1)[1], 'fourth', 'malformed image meta degrades to the text body');
  assert.equal(h.named('enqueue').length, 4);
});

test('unsubscribe releases the runtime subscription and clears the execution dedup state', () => {
  const h = makeHarness();
  h.notify(completionEvent('exec-400', 'Body.').event);
  assert.ok(h.displayedExecutionNotificationKeys.size > 0);
  h.unsubscribe();
  assert.deepEqual(h.named('unsubscribe'), [['unsubscribe']]);
  assert.equal(h.displayedExecutionNotificationKeys.size, 0);
});
