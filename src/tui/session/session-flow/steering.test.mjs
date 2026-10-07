import assert from 'node:assert/strict';
import test from 'node:test';
import { createSteeringDrain } from '../../../runtime/agent/orchestrator/session/loop/steering.mjs';
import { STEERING_SUPPRESSED_DISPLAY } from '../queue-helpers.mjs';
import { createQueueOps, createSubmissionMemory } from './queue.mjs';
import { createSteeringOps } from './steering.mjs';
import { createSubmissionIntake } from '../session-api/intake/submission.mjs';
import {
  beginInterruptibleTaskWait,
  interruptTaskWaitForSession,
  registerTaskWaitSteeringCheck,
} from '../../../runtime/agent/orchestrator/session/task-wait-control.mjs';
import {
  acknowledgeBackgroundTaskCompletion,
  cleanupBackgroundTasks,
  completeBackgroundTask,
  registerBackgroundTask,
} from '../../../runtime/shared/background-tasks.mjs';

test('a prompt submitted before task wait releases it and drains exactly once', () => {
  const sessionId = 'prewait-steering';
  const pending = [];
  const state = { busy: true, commandBusy: false, queued: [] };
  let nextId = 0;
  const bag = {
    runtime: {
      id: sessionId,
      interruptTaskWait: (reason) => interruptTaskWaitForSession(sessionId, reason),
    },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `prewait-${++nextId}`,
    autoClearBeforeSubmit: async () => {},
  };
  const queue = createQueueOps(bag, { kickDrain() {} });
  bag.enqueue = (text, options) => {
    const entry = queue.makeQueueEntry(text, { ...options, steeringPersistRestored: true });
    pending.push(entry);
    state.queued.push(entry);
    return true;
  };
  const steering = createSteeringOps(bag, { queue, submissions: createSubmissionMemory() });
  const intake = createSubmissionIntake(bag);
  const stop = registerTaskWaitSteeringCheck(
    (id) => id === sessionId && steering.hasPendingSteering()
  );
  const waits = [];
  const begin = () => {
    const wait = beginInterruptibleTaskWait(sessionId);
    waits.push(wait);
    return wait;
  };
  try {
    assert.equal(intake.submit('새 지시'), true);
    assert.equal(begin().signal.aborted, true);
    assert.equal(pending.length, 1, 'checking wait entry must not consume steering');
    const messages = steering.drainPendingSteering();
    assert.deepEqual(messages.map((message) => message.content), ['새 지시']);
    assert.deepEqual(state.queued, []);
    assert.deepEqual(steering.drainPendingSteering(), []);
    assert.equal(begin().signal.aborted, false, 'delivered steering must not interrupt a later wait');

    assert.equal(intake.submit('회수할 지시'), true);
    queue.restoreQueued();
    assert.equal(begin().signal.aborted, false, 'reclaimed steering must not interrupt a later wait');

    for (const [text, options] of [
      ['/help', {}],
      ['나중에', { priority: 'later' }],
      ['notification', { mode: 'task-notification' }],
      ['goal', { mode: 'goal-closeout' }],
    ]) {
      assert.equal(intake.submit(text, options), true);
      assert.equal(steering.hasPendingSteering(), false, 'only deliverable steering should skip wait');
    }
    assert.equal(begin().signal.aborted, false);
  } finally {
    stop();
    for (const wait of waits) wait.dispose();
  }
});

for (const status of ['done', 'failed', 'cancelled']) {
  test(`a steered submitAndWait receives its owning turn's ${status} result exactly once`, async () => {
    const pending = [];
    const state = { busy: true, commandBusy: false, queued: [] };
    const bag = {
      runtime: { id: '' },
      flags: {},
      pending,
      pendingNotificationKeys: new Set(),
      getState: () => state,
      set: (patch) => Object.assign(state, patch),
      nextId: () => 'followup',
      autoClearBeforeSubmit: async () => {},
    };
    const queue = createQueueOps(bag, { kickDrain() {} });
    bag.enqueue = (text, options) => {
      pending.push(queue.makeQueueEntry(text, options));
      return true;
    };
    const steering = createSteeringOps(bag, { queue, submissions: createSubmissionMemory() });
    const intake = createSubmissionIntake(bag);
    let settled = 0;
    const result = intake.submitAndWait('continue', {
      priority: 'next',
      onSettled: () => {
        settled += 1;
      },
    });
    const messages = steering.drainPendingSteering({ turnEpoch: 7 });
    assert.equal(messages[0].content, 'continue');
    assert.equal(pending.length, 0);
    const detail = { status, result: { content: 'turn result' } };
    steering.settleSteeredSubmissions(8, detail);
    assert.equal(settled, 0, 'another turn cannot settle this submission');
    steering.settleSteeredSubmissions(7, detail);
    assert.equal(await result, detail);
    steering.settleSteeredSubmissions(7, detail);
    assert.equal(settled, 1);
  });
}

test('a completion the model already consumed through task read/wait is not steered again', () => {
  const task = registerBackgroundTask({ surface: 'shell', operation: 'shell', label: 'npm test' });
  try {
    completeBackgroundTask(task.taskId, { status: 'completed', resultText: 'ok', notify: false });
    const pending = [];
    const state = { queued: [] };
    const bag = {
      runtime: { id: 'ack-steering' },
      pending,
      pendingNotificationKeys: new Set(),
      getState: () => state,
      set: (patch) => Object.assign(state, patch),
      nextId: () => 'completion-ack',
    };
    const queue = createQueueOps(bag, { kickDrain() {} });
    const steering = createSteeringOps(bag, { queue, submissions: createSubmissionMemory() });
    const queueCompletion = () =>
      pending.push(
        queue.makeQueueEntry(`<task-notification><task-id>${task.taskId}</task-id></task-notification>`, {
          mode: 'task-notification',
          execution: { surface: 'shell', id: task.taskId, status: 'completed' },
          priority: 'next',
        })
      );
    queueCompletion();
    assert.equal(steering.drainPendingSteering().length, 1, 'unread completions still reach the model');
    queueCompletion();
    acknowledgeBackgroundTaskCompletion(task.taskId);
    assert.deepEqual(steering.drainPendingSteering(), []);
    assert.deepEqual(pending, [], 'the acknowledged twin leaves the queue');
  } finally {
    cleanupBackgroundTasks({ force: true });
  }
});

for (const suppressDisplay of [false, true]) {
  for (const structured of [false, true]) {
    test(`completion provenance survives the queue and steering drain (suppressed=${suppressDisplay}, structured=${structured})`, () => {
      const text = 'Async agent task task_agent_1 (failed) finished.\n\nResult:\n> Worker failed.';
      const content = structured ? [{ type: 'text', text }] : text;
      const execution = { surface: 'agent', id: 'task_agent_1', status: 'failed', resultType: 'agent_task_result' };
      const pending = [];
      const state = { queued: [] };
      const bag = {
        runtime: { id: 'notification-steering' },
        pending,
        pendingNotificationKeys: new Set(),
        getState: () => state,
        set: (patch) => Object.assign(state, patch),
        nextId: () => 'completion-1',
      };
      const queue = createQueueOps(bag, { kickDrain() {} });
      const steering = createSteeringOps(bag, { queue, submissions: createSubmissionMemory() });
      const entry = queue.makeQueueEntry(content, {
        mode: 'task-notification',
        execution,
        priority: 'next',
        submittedAt: 100,
        displayText: text,
        suppressDisplay,
      });
      assert.equal(entry.mode, 'task-notification');
      assert.deepEqual(entry.execution, execution);
      pending.push(entry);

      const drained = steering.drainPendingSteering();
      assert.deepEqual(pending, []);
      assert.equal(drained.length, 1);
      assert.equal(drained[0].mode, 'task-notification');
      assert.deepEqual(drained[0].execution, execution);
      assert.deepEqual(drained[0].content, content);
      assert.equal(drained[0].text, suppressDisplay ? STEERING_SUPPRESSED_DISPLAY : text);

      const messages = [];
      const skillPrompts = [];
      const displayed = [];
      const prompt = 'Continue the actual task.';
      const drain = createSteeringDrain({
        messages,
        onSkillPrompt: (value) => skillPrompts.push(value),
        opts: {
          drainSteering: () => [...drained, { mode: 'prompt', content: prompt }],
          onSteerMessage: (value, meta) => displayed.push({ value, meta }),
        },
      });
      assert.equal(drain(), true);
      assert.equal(messages.length, 2);
      assert.deepEqual(messages[0], {
        role: 'user',
        content,
        meta: { source: 'task-notification', execution, submissionIds: ['completion-1'] },
      });
      assert.equal(messages[1].meta.source, 'steering');
      assert.deepEqual(skillPrompts, [prompt], 'only typed input reaches onSkillPrompt');
      assert.equal(displayed[0].value, suppressDisplay ? STEERING_SUPPRESSED_DISPLAY : text);
      assert.equal(displayed[0].meta.mode, 'task-notification');
      assert.deepEqual(displayed[0].meta.execution, execution);
    });
  }
}
