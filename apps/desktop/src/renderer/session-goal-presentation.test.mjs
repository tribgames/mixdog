import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';
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

test('active child work remains visible while a separate approval is waiting', () => {
  assert.equal(goalDisplayStatus({ status: 'paused' }, { busy: false }, true), 'responding');
  assert.equal(goalDisplayStatus({ status: 'active' }, { busy: true, toolApproval: { id: 'approval' } }), 'paused');
  assert.equal(goalDisplayStatus({ status: 'active' }, { busy: true, toolApproval: { id: 'approval' } }, true), 'active');
  assert.equal(goalDisplayStatus({ status: 'paused' }, { busy: true, toolApproval: { id: 'approval' } }, true), 'responding');
});

test('terminal Goal states do not become reply activity merely because the session is busy', () => {
  for (const status of ['complete', 'blocked', 'usage_limited', 'duration_reached']) {
    assert.equal(goalDisplayStatus({ status }, { busy: true }, true), status);
  }
});
