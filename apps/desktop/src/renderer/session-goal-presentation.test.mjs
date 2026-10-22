import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';
import { PaneGoalIsland } from './app-snapshot-views.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { goalDisplayStatus, goalElapsedLabel, goalStateKind, goalTaskProgress } from './session-goal-presentation.ts';
import { t } from './i18n.ts';

installTestDom(null, {
  html: '<!doctype html><body></body>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node'],
});

test('a paused Goal shows reply activity without inventing approval or elapsed work', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const goal = Object.freeze({
    id: 'goal',
    status: 'paused',
    title: 'Approved work',
    timeUsedMs: 12_000,
    snapshotAt: 100_000,
    tasks: [{ id: 'review', text: 'Review pending approval', status: 'awaiting_approval' }],
  });
  const render = (busy, toolApproval = null, currentGoal = goal) =>
    act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'one', goal: currentGoal, busy, toolApproval },
        })
      );
    });
  const activity = () => host.querySelector('[role="img"]').getAttribute('aria-label');
  try {
    await render(false);
    assert.equal(activity(), t('Paused'));
    await render(true);
    assert.equal(activity(), t('Responding'));
    assert.match(host.textContent, /0\/1/);
    assert.match(host.textContent, /0m elapsed/);
    assert.equal(goalElapsedLabel(goal, 200_000), '0:12');
    await render(true, { id: 'approval', name: 'apply_patch' });
    assert.equal(activity(), t('Paused'), 'a live approval prompt is not running work');
    await render(false);
    assert.equal(activity(), t('Paused'), 'a question-only turn returns to its original wait');
    assert.equal(goal.status, 'paused');
    await render(true, null, { ...goal, status: 'active' });
    assert.equal(activity(), t('Goal state: In progress'), 'a durable resume replaces the reply-only state');
    await render(false, null, goal);
    assert.equal(activity(), t('Paused'), 'settled cancellation restores the pause affordance');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('background shell execution stays visible without resuming a paused Goal', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const goal = Object.freeze({
    id: 'shell-goal',
    status: 'paused',
    title: 'Background work',
    timeUsedMs: 12_000,
  });
  const render = (shellJobs, toolApproval = null, currentGoal = goal) =>
    act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'shell-session', busy: false, goal: currentGoal, shellJobs, toolApproval },
        })
      );
    });
  const activity = () => host.querySelector('[role="img"]').getAttribute('aria-label');
  try {
    await render({ count: 1 });
    assert.equal(activity(), t('Responding'));
    assert.match(host.textContent, /0m elapsed/);
    await render({ jobs: [{ taskId: 'running-shell' }] }, { id: 'other-approval' });
    assert.equal(activity(), t('Responding'));
    await render({ count: 1 }, { id: 'other-approval' }, { ...goal, status: 'active' });
    assert.equal(activity(), t('Goal state: In progress'));
    await render({ count: 0, jobs: [] });
    assert.equal(activity(), t('Paused'));
    assert.equal(goal.status, 'paused');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('collapsed trigger shows minute-format time and finished glyphs', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (goal) =>
    act(async () => {
      root.render(React.createElement(SessionGoalIsland, { snapshot: { sessionId: 'fin', goal } }));
    });
  const trigger = () => host.querySelector('.session-goal-trigger');
  try {
    await render({ id: 'g', status: 'paused', timeUsedMs: 59_000 });
    assert.equal(trigger().querySelector('.session-goal-trigger-time'), null, 'no "0m" in the first minute');
    await render({ id: 'g', status: 'paused', timeUsedMs: 12 * 60_000 + 40_000 });
    assert.equal(trigger().querySelector('.session-goal-trigger-time').textContent, '12m');
    const paused = trigger().querySelector('.session-goal-state');
    assert.equal(paused.dataset.state, 'paused');
    assert.ok(paused.querySelector('svg'));
    assert.equal(trigger().firstElementChild, paused, 'the state icon leads the segment');
    await render({ id: 'g', status: 'complete', timeUsedMs: 65 * 60_000 + 30_000 });
    assert.equal(trigger().querySelector('.session-goal-trigger-time').textContent, '1h 5m');
    const done = trigger().querySelector('.session-goal-state');
    assert.equal(done.dataset.state, 'complete');
    assert.ok(done.querySelector('svg'));
    assert.equal(trigger().querySelector('.session-goal-objective'), null, 'the segment carries numbers only');
    await render({ id: 'g', status: 'stopped', timeUsedMs: 5 * 60_000 });
    const stopped = trigger().querySelector('.session-goal-state');
    assert.equal(stopped.dataset.state, 'stopped');
    assert.equal(trigger().querySelector('.session-goal-trigger-time').textContent, '5m');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('task progress is five fixed cells: the finished share, then the work in hand', async () => {
  const task = (status, index) => ({ id: `t${index}`, text: `Task ${index}`, status });
  const few = [task('completed', 1), task('in_progress', 2), task('dropped', 3), task('awaiting_approval', 4)];
  // Dropped work is not counted, and the answer the user owes outranks work in hand.
  assert.deepEqual(goalTaskProgress({ tasks: few, tasksTotal: 4 }), {
    completed: 1,
    total: 3,
    pips: ['completed', 'awaiting_approval', 'pending', 'pending', 'pending'],
  });
  const twenty = Array.from({ length: 20 }, (_, index) => task(index < 13 ? 'completed' : 'pending', index));
  twenty[13].status = 'in_progress';
  assert.deepEqual(goalTaskProgress({ tasks: twenty, tasksTotal: 20 }).pips, [
    'completed',
    'completed',
    'completed',
    'in_progress',
    'pending',
  ]);
  // Only a finished list fills every cell: 19 of 20 rounds down to four.
  for (const row of twenty.slice(13, 19)) row.status = 'completed';
  assert.deepEqual(goalTaskProgress({ tasks: twenty, tasksTotal: 20 }).pips, [
    'completed',
    'completed',
    'completed',
    'completed',
    'pending',
  ]);
  twenty[19].status = 'completed';
  assert.deepEqual(goalTaskProgress({ tasks: twenty, tasksTotal: 20 }).pips, Array(5).fill('completed'));
  // A summary count alone still fills its share; no tasks fill nothing.
  assert.deepEqual(goalTaskProgress({ tasks: [], tasksTotal: 4, tasksCompleted: 2 }), {
    completed: 2,
    total: 4,
    pips: ['completed', 'completed', 'pending', 'pending', 'pending'],
  });
  assert.deepEqual(goalTaskProgress({ tasks: [] }).pips, Array(5).fill('pending'));
  assert.equal(goalStateKind({ status: 'paused', pauseReason: 'waiting' }, 'paused'), 'waiting');
  assert.equal(goalStateKind({ status: 'usage_limited' }, 'usage_limited'), 'blocked');

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'pips',
            goal: { id: 'g', status: 'blocked', objective: 'Ship it', tasks: few, tasksTotal: 4, blocker: 'No token' },
          },
        })
      );
    });
    const trigger = host.querySelector('.session-goal-trigger');
    assert.equal(
      trigger.getAttribute('aria-label'),
      t('Goal: {{objective}}, {{status}}, {{completed}} of {{total}} tasks done', {
        objective: 'Ship it',
        status: t('Blocked'),
        completed: 1,
        total: 3,
      })
    );
    assert.equal(trigger.querySelector('.session-goal-objective'), null, 'no title in the segment');
    assert.equal(trigger.querySelector('.session-goal-pips'), null, 'the ring replaces the pips');
    assert.equal(host.querySelector('.session-goal-badge'), null, 'rows carry no text badges');
    assert.equal(host.querySelector('li[data-stalled="true"] svg')?.dataset.glyph, 'stalled');
    assert.equal(host.querySelector('li[data-status="awaiting_approval"] svg')?.dataset.glyph, 'awaiting');
    assert.doesNotMatch(host.textContent, /Needs your answer/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('stalled and awaiting task rows carry accessible status text', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const tasks = [
    { id: 'a', text: 'Run migration', status: 'in_progress' },
    { id: 'b', text: 'Ship it', status: 'awaiting_approval' },
    { id: 'c', text: 'Write docs', status: 'pending' },
  ];
  try {
    await act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'a11y', goal: { id: 'g', status: 'blocked', objective: 'Ship', tasks, blocker: 'x' } },
        })
      );
    });
    const rowText = (selector) => host.querySelector(selector).textContent;
    assert.equal(rowText('li[data-stalled="true"]'), `${t('Blocked')}: Run migration`);
    assert.equal(rowText('li[data-status="awaiting_approval"]'), `${t('Waiting for your answer')}: Ship it`);
    assert.equal(rowText('li[data-status="pending"]'), 'Write docs');
    assert.ok(host.querySelector('li[data-stalled="true"] .sr-only'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('closing the drawer drops an armed Stop confirmation', async () => {
  const calls = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: { ok: true } };
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const click = (element) =>
    act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  const confirmGroup = () => host.querySelector('.session-goal-confirm');
  const stopButton = () => host.querySelector('button[aria-label="Stop goal"]');
  const dismissers = {
    Escape: () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    'outside pointerdown': () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })),
    'Close button': () => host.querySelector('.composer-island-close').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true })
    ),
  };
  try {
    await act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'stop-close', goal: { id: 'g', status: 'active', objective: 'Ship', tasks: [] } },
        })
      );
    });
    for (const [name, dismiss] of Object.entries(dismissers)) {
      await click(host.querySelector('.session-goal-trigger'));
      assert.equal(host.querySelector('.session-goal-island').dataset.open, 'true', name);
      await click(stopButton());
      assert.ok(confirmGroup(), `${name}: Stop arms the confirmation`);
      await act(async () => dismiss());
      assert.equal(host.querySelector('.session-goal-island').dataset.open, 'false', name);
      await click(host.querySelector('.session-goal-trigger'));
      assert.equal(confirmGroup(), null, `${name}: reopening shows ordinary controls`);
      assert.ok(stopButton(), name);
      await act(async () => dismissers.Escape());
    }
    assert.equal(calls.length, 0, 'no stop call was made');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  }
});

test('active child work remains visible while a separate approval is waiting', () => {
  assert.equal(goalDisplayStatus({ status: 'paused' }, { busy: false }, true), 'responding');
  assert.equal(goalDisplayStatus({ status: 'active' }, { busy: true, toolApproval: { id: 'approval' } }), 'paused');
  assert.equal(
    goalDisplayStatus({ status: 'active' }, { busy: true, toolApproval: { id: 'approval' } }, true),
    'active'
  );
  assert.equal(
    goalDisplayStatus({ status: 'paused' }, { busy: true, toolApproval: { id: 'approval' } }, true),
    'responding'
  );
});

test('Goal icon follows approval release and command execution through the live session lane', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = 'goal-icon-sync';
  const goal = Object.freeze({ id: 'sync-goal', status: 'paused', timeUsedMs: 12_000 });
  const base = { sessionId, goal, busy: true, commandBusy: false };
  const publish = (execution) =>
    act(async () => {
      defaultSessionLaneStore.apply({ sessionId, snapshot: { ...base, ...execution } });
    });
  const activity = () => host.querySelector('[role="img"]').getAttribute('aria-label');
  try {
    await publish({ toolApproval: { id: 'approval', name: 'apply_patch' } });
    await act(async () => {
      root.render(React.createElement(PaneGoalIsland, { sessionId, hidden: false }));
    });
    assert.equal(activity(), t('Paused'));
    await publish({ toolApproval: null });
    assert.equal(activity(), t('Responding'), 'approval release alone refreshes the icon');
    await publish({ busy: false, commandBusy: true, toolApproval: null });
    assert.equal(activity(), t('Responding'), 'command execution keeps the icon running');
    await publish({ busy: false, commandBusy: false, toolApproval: null });
    assert.equal(activity(), t('Paused'), 'settled execution restores the paused icon');
  } finally {
    await act(async () => root.unmount());
    defaultSessionLaneStore.clear();
    host.remove();
  }
});

test('terminal Goal states do not become reply activity merely because the session is busy', () => {
  for (const status of ['complete', 'blocked', 'usage_limited', 'duration_reached']) {
    assert.equal(goalDisplayStatus({ status }, { busy: true, shellJobs: { count: 1 } }, true), status);
  }
});
