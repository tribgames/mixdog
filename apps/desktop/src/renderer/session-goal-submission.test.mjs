import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { GoalSubmissionContext, useGoalAfterSubmission } from './session-goal-submission.ts';

installTestDom(null, { html: '<!doctype html><body></body>', jsdom: { url: 'https://mixdog.test/' } });

function mountGoal(t) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  function Goal({ goal, session }) {
    const visible = useGoalAfterSubmission(goal, session);
    return visible ? React.createElement('p', null, visible.title) : null;
  }
  const render = (submission, goal = oldGoal, session = 'one') =>
    act(async () => {
      root.render(
        React.createElement(
          GoalSubmissionContext.Provider,
          { value: submission },
          React.createElement(Goal, { goal, session })
        )
      );
    });
  return { host, render };
}

const oldGoal = { id: 'old', status: 'complete', title: 'Previous work' };

test('a rejected submission restores the previous goal', async (t) => {
  const { host, render } = mountGoal(t);
  await render('');
  await render('rejected');
  await render('');
  assert.equal(host.textContent, 'Previous work', 'rejection restores the previous goal');
});

test('an accepted submission hides clock-only snapshots but admits an explicit resume of the same goal', async (t) => {
  const { host, render } = mountGoal(t);
  await render('');
  await render('accepted');
  await render('accepted', { ...oldGoal, snapshotAt: 100, timeUsedMs: 100 });
  assert.equal(host.textContent, '', 'clock-only snapshots cannot resurrect old chrome');
  await render('accepted', { ...oldGoal, status: 'active', title: 'Resumed work' });
  assert.equal(host.textContent, 'Resumed work', 'the same goal can explicitly resume');
});

test('a new goal is never masked by an old submission', async (t) => {
  const { host, render } = mountGoal(t);
  await render('second');
  await render('second', { id: 'new', status: 'active', title: 'New work' });
  assert.equal(host.textContent, 'New work', 'a new goal is never masked by an old submission');
});

test("navigation does not inherit another session's mask", async (t) => {
  const { host, render } = mountGoal(t);
  await render('third');
  await render('', oldGoal, 'two');
  assert.equal(host.textContent, 'Previous work', "navigation does not inherit another session's mask");
});

test('a goal first published after submit is visible', async (t) => {
  const { host, render } = mountGoal(t);
  await render('', null);
  await render('empty', null);
  await render('empty', oldGoal);
  assert.equal(host.textContent, 'Previous work', 'a goal first published after submit is visible');
});

test('active, paused and blocked work survives the next prompt', async (t) => {
  const { host, render } = mountGoal(t);
  for (const status of ['active', 'paused', 'blocked', 'usage_limited', 'duration_reached']) {
    const continuing = { ...oldGoal, status, title: `Continuing ${status}` };
    await render('', continuing);
    await render(`continue-${status}`, continuing);
    assert.equal(host.textContent, continuing.title, `${status} work survives the next prompt`);
  }
});
