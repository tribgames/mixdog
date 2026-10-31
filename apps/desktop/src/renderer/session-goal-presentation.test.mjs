import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';
import { PaneGoalIsland } from './app-snapshot-views.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import {
  goalDisplayStatus,
  goalElapsedLabel,
  goalStateKind,
  todoProgress,
  todoStateKind,
} from './session-goal-presentation.ts';
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
    assert.equal(host.querySelector('.session-goal-progress'), null, 'no list, no count');
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

const todoOf = (tasks, extra = {}) => {
  const abandoned = tasks.filter((task) => task.status === 'abandoned').length;
  return {
    phases: [{ name: 'Plan', tasks }],
    completed: tasks.filter((task) => task.status === 'completed').length,
    abandoned,
    total: tasks.length,
    ...extra,
  };
};

test('todo progress counts finished steps of the counted ones; abandoned work is never accomplished', () => {
  const tasks = [
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'abandoned' },
    { content: 'd', status: 'blocked', blocker: 'No token' },
  ];
  assert.deepEqual(todoProgress(todoOf(tasks)), {
    completed: 1,
    total: 3,
    abandoned: 1,
    blocked: true,
    inProgress: true,
  });
  assert.equal(todoStateKind(todoProgress(todoOf(tasks))), 'blocked');
  assert.equal(todoStateKind(todoProgress(todoOf([{ content: 'a', status: 'in_progress' }]))), 'active');
  assert.equal(todoStateKind(todoProgress(todoOf([{ content: 'a', status: 'completed' }]))), 'complete');
  assert.equal(
    todoStateKind(todoProgress(todoOf([{ content: 'a', status: 'abandoned' }]))),
    'active',
    'a list of only dropped work is not an accomplishment'
  );
  assert.equal(goalStateKind({ status: 'paused', pauseReason: 'waiting' }, 'paused'), 'waiting');
  assert.equal(goalStateKind({ status: 'usage_limited' }, 'usage_limited'), 'blocked');
});

test('a Goal segment carries the ring, n/m and a label from the step list', async () => {
  const tasks = [
    { content: 'Write code', status: 'completed', note: 'merged' },
    { content: 'Run migration', status: 'in_progress' },
    { content: 'Ship it', status: 'blocked', blocker: 'No token' },
    { content: 'Old idea', status: 'abandoned', note: 'out of scope' },
    { content: 'Write docs', status: 'pending' },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'pips',
            goal: { id: 'g', status: 'blocked', objective: 'Ship it', blocker: 'No token' },
            todo: todoOf(tasks),
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
        total: 4,
      })
    );
    assert.equal(trigger.querySelector('.session-goal-progress').textContent, '1/4');
    assert.equal(host.querySelector('li[data-status="blocked"] svg')?.dataset.glyph, 'stalled');
    assert.equal(host.querySelector('li[data-status="blocked"] .session-goal-task-blocker').textContent, 'No token');
    assert.equal(host.querySelector('li[data-status="completed"] .session-goal-task-note').textContent, 'merged');
    assert.equal(host.querySelector('li[data-status="abandoned"] .session-goal-task-note').textContent, 'out of scope');
    assert.ok(host.querySelector('.session-goal-controls'), 'a Goal keeps its controls');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a list without a Goal shows a To-do segment and panel with no time or controls', async () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({ content: `Step ${index}`, status: 'pending' }));
  tasks.push(
    { content: 'Done step', status: 'completed', note: 'ok' },
    { content: 'Dropped step', status: 'abandoned' }
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (snapshot) =>
    act(async () => {
      root.render(React.createElement(SessionGoalIsland, { snapshot: { sessionId: 'todo-only', ...snapshot } }));
    });
  try {
    await render({});
    assert.equal(host.querySelector('.session-goal-island'), null, 'no list and no Goal: no segment');
    await render({ todo: todoOf([]) });
    assert.equal(host.querySelector('.session-goal-island'), null, 'an empty list is no segment');
    await render({ todo: todoOf(tasks) });
    const trigger = host.querySelector('.session-goal-trigger');
    assert.equal(trigger.querySelector('.session-goal-progress').textContent, '1/8', 'dropped work leaves the total');
    assert.equal(trigger.querySelector('.session-goal-trigger-time'), null);
    assert.equal(
      trigger.getAttribute('aria-label'),
      t('To-do {{completed}} of {{total}} done', { completed: 1, total: 8 })
    );
    assert.equal(host.querySelector('.session-goal-panel').getAttribute('aria-label'), t('To-do'));
    assert.equal(host.querySelector('.session-goal-controls'), null);
    assert.equal(host.querySelector('.session-goal-title'), null);
    assert.equal(host.querySelector('.session-goal-time'), null);
    assert.equal(host.querySelector('.session-goal-dismiss'), null);
    const remaining = host.querySelectorAll('ul[aria-label="' + t('To-do') + '"] li');
    assert.equal(remaining.length, 5, 'the first five remaining steps show');
    const rest = host.querySelector('[data-fold="rest"]');
    assert.equal(rest.textContent, t('Rest {{n}}', { n: 2 }));
    assert.equal(rest.getAttribute('aria-expanded'), 'false');
    const done = host.querySelector('[data-fold="done"]');
    assert.equal(done.textContent, `${t('Done {{n}}', { n: 1 })} · ${t('{{n}} dropped', { n: 1 })}`);
    assert.equal(done.getAttribute('aria-expanded'), 'false');
    await render({ todo: todoOf([{ content: 'Only', status: 'completed' }]) });
    const finished = host.querySelector('.session-goal-island');
    assert.equal(finished.dataset.state, 'complete');
    assert.equal(
      host.querySelector('[data-fold="done"]').getAttribute('aria-expanded'),
      'false',
      'a finished list without a Goal keeps its done rows folded'
    );
    await render({ todo: todoOf([{ content: 'Gone', status: 'abandoned' }]) });
    assert.equal(
      host.querySelector('.session-goal-trigger .session-goal-progress').textContent,
      '0/0',
      'a list whose steps were all dropped still shows its count'
    );
    await render({
      todo: todoOf([{ content: 'Ship it', status: 'blocked', blocker: 'No token', note: 'asked owner' }]),
    });
    assert.equal(host.querySelector('.session-goal-task-note').textContent, 'asked owner', 'a note shows on any step');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('step rows carry accessible status text', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const tasks = [
    { content: 'Run migration', status: 'in_progress' },
    { content: 'Ship it', status: 'blocked', blocker: 'No token' },
    { content: 'Write docs', status: 'pending' },
    { content: 'Old idea', status: 'abandoned' },
  ];
  try {
    await act(async () => {
      root.render(React.createElement(SessionGoalIsland, { snapshot: { sessionId: 'a11y', todo: todoOf(tasks) } }));
    });
    const rowText = (selector) => host.querySelector(selector).textContent;
    assert.equal(rowText('li[data-status="in_progress"]'), `${t('In progress')}: Run migration`);
    assert.equal(rowText('li[data-status="blocked"]'), `${t('Blocked')}: Ship itNo token`);
    assert.equal(rowText('li[data-status="pending"]'), 'Write docs');
    assert.equal(rowText('li[data-status="abandoned"]'), `${t('Dropped')}: Old idea`);
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
    'Close button': () =>
      host.querySelector('.composer-island-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
  };
  try {
    await act(async () => {
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'stop-close', goal: { id: 'g', status: 'active', objective: 'Ship' } },
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
