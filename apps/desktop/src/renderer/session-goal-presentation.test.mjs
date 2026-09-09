import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';
import { PaneGoalIsland } from './app-snapshot-views.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { goalDisplayStatus, goalElapsedLabel } from './session-goal-presentation.ts';
import { t } from './i18n.ts';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('a paused Goal shows reply activity without inventing approval or elapsed work', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const goal = Object.freeze({
    id: 'goal', status: 'paused', title: 'Approved work', timeUsedMs: 12_000, snapshotAt: 100_000,
    tasks: [{ id: 'review', text: 'Review pending approval', status: 'awaiting_approval', kind: 'verification' }],
  });
  const render = (busy, toolApproval = null, currentGoal = goal) => act(async () => {
    root.render(React.createElement(SessionGoalIsland, {
      snapshot: { sessionId: 'one', goal: currentGoal, busy, toolApproval },
    }));
  });
  const activity = () => host.querySelector('[role="img"]').getAttribute('aria-label');
  try {
    await render(false);
    assert.equal(activity(), t('Paused'));
    await render(true);
    assert.equal(activity(), t('Responding'));
    assert.match(host.textContent, /0\/1/);
    assert.match(host.textContent, /0:12/);
    assert.equal(goalElapsedLabel(goal, 200_000), '0:12');
    await render(true, { id: 'approval', name: 'apply_patch' });
    assert.equal(activity(), t('Paused'), 'a live approval prompt is not running work');
    await render(false);
    assert.equal(activity(), t('Paused'), 'a question-only turn returns to its original wait');
    assert.equal(goal.status, 'paused');
    await render(true, null, { ...goal, status: 'active' });
    assert.equal(activity(), t('Working'), 'a durable resume replaces the reply-only state');
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
    id: 'shell-goal', status: 'paused', title: 'Background work', timeUsedMs: 12_000,
  });
  const render = (shellJobs, toolApproval = null, currentGoal = goal) => act(async () => {
    root.render(React.createElement(SessionGoalIsland, {
      snapshot: { sessionId: 'shell-session', busy: false, goal: currentGoal, shellJobs, toolApproval },
    }));
  });
  const activity = () => host.querySelector('[role="img"]').getAttribute('aria-label');
  try {
    await render({ count: 1 });
    assert.equal(activity(), t('Responding'));
    assert.match(host.textContent, /0:12/);
    await render({ jobs: [{ taskId: 'running-shell' }] }, { id: 'other-approval' });
    assert.equal(activity(), t('Responding'));
    await render({ count: 1 }, { id: 'other-approval' }, { ...goal, status: 'active' });
    assert.equal(activity(), t('Working'));
    await render({ count: 0, jobs: [] });
    assert.equal(activity(), t('Paused'));
    assert.equal(goal.status, 'paused');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('active child work remains visible while a separate approval is waiting', () => {
  assert.equal(goalDisplayStatus({ status: 'paused' }, { busy: false }, true), 'responding');
  assert.equal(goalDisplayStatus({ status: 'active' }, { busy: true, toolApproval: { id: 'approval' } }), 'paused');
  assert.equal(goalDisplayStatus({ status: 'active' }, { busy: true, toolApproval: { id: 'approval' } }, true), 'active');
  assert.equal(goalDisplayStatus({ status: 'paused' }, { busy: true, toolApproval: { id: 'approval' } }, true), 'responding');
});

test('Goal icon follows approval release and command execution through the live session lane', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = 'goal-icon-sync';
  const goal = Object.freeze({ id: 'sync-goal', status: 'paused', timeUsedMs: 12_000 });
  const base = { sessionId, goal, busy: true, commandBusy: false };
  const publish = (execution) => act(async () => {
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
