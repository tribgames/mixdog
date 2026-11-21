import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';
import { ComposerGoalDialog } from './ComposerGoalDialog.tsx';
import { t } from './i18n.ts';

installTestDom(null, {
  html: '<!doctype html><body></body>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { createRoot } = await import('react-dom/client');

const button = (host, text) =>
  [...host.querySelectorAll('button')].find(
    (node) => (node.getAttribute('aria-label') || node.textContent) === t(text)
  );
const click = (node) =>
  act(async () => {
    assert.ok(node);
    node.click();
  });

const goal = {
  id: 'goal-controls',
  objective: 'Approved objective',
  status: 'active',
  timeLimitMs: 3_600_000,
  timeUsedMs: 5_000,
  remainingMs: 3_595_000,
};
const todo = {
  phases: [{ name: 'Plan', tasks: [{ content: 'Current work', status: 'in_progress' }] }],
  completed: 0,
  abandoned: 0,
  total: 1,
};

function mountGoal(ctx) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: { ok: true } };
    },
  };
  ctx.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = (current, currentTodo) =>
    act(async () =>
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'own-pane', goal: current, todo: currentTodo },
        })
      )
    );
  return { host, calls, render };
}

test('Goal tab controls belong to the expanded tab, under its task drawer', async (ctx) => {
  const { host, render } = mountGoal(ctx);
  await render(goal, todo);
  const trigger = host.querySelector('[aria-expanded]');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.ok(button(host, 'Pause').closest('[inert]'), 'closed segment keeps its controls inert');
  await click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  for (const label of ['Pause', 'Edit goal', 'Stop goal']) {
    const control = button(host, label);
    assert.ok(control);
    assert.equal(control.title, t(label));
    assert.equal(
      control.closest('[inert], [aria-hidden="true"], button[aria-expanded]'),
      null,
      `${label} is available in the open Goal tab`
    );
  }
});

test('Pause and Resume address the pane that owns the goal and leave the tab open', async (ctx) => {
  const { host, calls, render } = mountGoal(ctx);
  await render(goal, todo);
  const trigger = host.querySelector('[aria-expanded]');
  await click(trigger);
  await click(button(host, 'Pause'));
  assert.deepEqual(calls.at(-1), {
    capability: 'goalControl',
    sessionId: 'own-pane',
    args: [{ action: 'pause', expectedGoalId: goal.id }],
  });
  await render({ ...goal, status: 'paused' }, todo);
  await click(button(host, 'Resume'));
  assert.equal(calls.at(-1).args[0].action, 'resume');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});

test('Edit goal opens the approved objective and time limit and saves them from the open tab', async (ctx) => {
  const { host, calls, render } = mountGoal(ctx);
  await render(goal, todo);
  const trigger = host.querySelector('[aria-expanded]');
  await click(trigger);
  await click(button(host, 'Edit goal'));
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector('textarea').value, goal.objective);
  assert.equal(dialog.querySelector('[role="combobox"]'), null, 'no duration or mode choice');
  assert.equal(dialog.querySelector('input[type="number"]').value, '60');
  await click(button(dialog, 'Save'));
  assert.deepEqual(calls.at(-1).args[0], {
    action: 'edit',
    expectedGoalId: goal.id,
    objective: goal.objective,
    time_limit_minutes: 60,
  });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});

test('Stop goal asks for confirmation inside the open tab before it stops the work', async (ctx) => {
  const { host, calls, render } = mountGoal(ctx);
  await render(goal, todo);
  const trigger = host.querySelector('[aria-expanded]');
  await click(trigger);
  await click(button(host, 'Stop goal'));
  assert.equal(calls.length, 0, 'asking for confirmation must not stop work');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'stop confirms inside the open Goal tab');
  assert.equal(button(host, 'Confirm stop').closest('[inert], [aria-hidden="true"]'), null);
  await click(button(host, 'Confirm stop'));
  assert.equal(calls.at(-1).args[0].action, 'stop');
  await render({ ...goal, status: 'stopped' }, todo);
  assert.equal(button(host, 'Resume'), undefined);
  assert.equal(button(host, 'Edit goal'), undefined);
  assert.equal(button(host, 'Stop goal'), undefined);
  assert.ok(host.textContent.includes('Current work'), 'unfinished work remains visible');
});
test('closing the Goal edit dialog returns focus to the visible Edit control, not the hidden trigger', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  window.mixdogDesktop = { invokeCapability: async () => ({ value: { ok: true } }) };
  try {
    await act(async () =>
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'focus-return',
            goal: { id: 'goal-focus', objective: 'Return focus', status: 'active' },
          },
        })
      )
    );
    await click(host.querySelector('.session-goal-trigger'));
    const edit = button(host, 'Edit goal');
    await click(edit);
    await click(button(document.querySelector('[role="dialog"]'), 'Cancel'));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, edit, 'focus lands on the Edit control in the open Goal tab');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

async function mountGoalDialog(ctx, props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  ctx.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(ComposerGoalDialog, {
        anchor: { current: host },
        disabled: false,
        onClose() {},
        returnFocus() {},
        ...props,
      })
    )
  );
  return document.querySelector('[role="dialog"]');
}

test('goal creation offers only an objective and a time limit and preserves input after a rejected start', async (ctx) => {
  const commands = [];
  const dialog = await mountGoalDialog(ctx, {
    onStart: async (command) => {
      commands.push(command);
      return false;
    },
  });
  assert.equal(dialog.querySelector('[role="combobox"]'), null);
  await act(async () => {
    const input = dialog.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'Deliver result');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await click(button(dialog, 'Start goal'));
  assert.equal(commands.at(-1), '/goal Deliver result --time 60m');
  assert.equal(dialog.querySelector('textarea').value, 'Deliver result');
  assert.ok(dialog.textContent.includes(t('Goal could not be started. Your input has been kept.')));
});

test('goal editing preserves input after a rejected save', async (ctx) => {
  const commands = [];
  const initialGoal = { objective: 'Existing limit', timeLimitMs: 1_800_000 };
  const edit = await mountGoalDialog(ctx, {
    initialGoal,
    onSave: async (value) => {
      commands.push(value);
      return false;
    },
  });
  await click(button(edit, 'Save'));
  assert.deepEqual(commands.at(-1), {
    objective: initialGoal.objective,
    timeLimitMinutes: 30,
  });
  assert.equal(edit.querySelector('textarea').value, initialGoal.objective);
  assert.ok(edit.textContent.includes(t('Goal could not be started. Your input has been kept.')));
});
test('a stalled Goal is dismissed from its segment in one click, with no overshoot in its time', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: { ok: true } };
    },
  };
  const spent = {
    id: 'goal-spent',
    objective: 'Verify the markets',
    status: 'duration_reached',
    timeLimitMs: 21 * 3_600_000 + 23 * 60_000,
    timeUsedMs: 23 * 3_600_000 + 26 * 60_000,
    remainingMs: 0,
  };
  const render = (current) =>
    act(async () =>
      root.render(React.createElement(SessionGoalIsland, { snapshot: { sessionId: 'own-pane', goal: current } }))
    );
  try {
    for (const status of ['duration_reached', 'blocked', 'paused', 'usage_limited']) {
      calls.length = 0;
      await render({ ...spent, id: `goal-${status}`, status });
      const dismiss = host.querySelector('.session-goal-dismiss');
      assert.ok(dismiss, `${status} Goal offers the segment dismiss`);
      assert.equal(dismiss.closest('[inert]'), null);
      await click(dismiss);
      assert.deepEqual(calls.at(-1).args, [{ action: 'dismiss', expectedGoalId: `goal-${status}` }]);
    }
    await render(spent);
    assert.ok(host.textContent.includes(`${t('{{hours}}h {{minutes}}m', { hours: 21, minutes: 23 })} / `));
    assert.equal(host.textContent.includes(t('{{hours}}h {{minutes}}m', { hours: 23, minutes: 26 })), false);
    await render({ ...spent, id: 'goal-running', status: 'active' });
    assert.equal(host.querySelector('.session-goal-dismiss'), null, 'running work is stopped, never dismissed');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

const finishedGoal = {
  id: 'goal-done',
  objective: 'Ship it',
  status: 'complete',
  timeUsedMs: 60_000,
};

test('a finished Goal is dismissed from its closed segment in one click', async (ctx) => {
  const { host, calls, render } = mountGoal(ctx);
  await render(finishedGoal);
  const segmentDismiss = host.querySelector('.session-goal-dismiss');
  assert.equal(segmentDismiss.getAttribute('aria-label'), t('Dismiss goal'));
  assert.equal(segmentDismiss.title, t('Dismiss goal'));
  assert.equal(segmentDismiss.closest('[inert]'), null, 'the closed segment dismisses in one click');
  await click(segmentDismiss);
  assert.deepEqual(calls.at(-1), {
    capability: 'goalControl',
    sessionId: 'own-pane',
    args: [{ action: 'dismiss', expectedGoalId: finishedGoal.id }],
  });
});

test('a finished Goal is dismissed from its tab', async (ctx) => {
  const { host, calls, render } = mountGoal(ctx);
  await render(finishedGoal);
  await click(host.querySelector('.session-goal-trigger'));
  const tabDismiss = host.querySelector('.session-goal-controls .session-goal-control');
  assert.equal(tabDismiss.textContent, t('Dismiss goal'));
  assert.equal(tabDismiss.closest('[inert], [aria-hidden="true"]'), null);
  await click(tabDismiss);
  assert.deepEqual(calls.at(-1).args, [{ action: 'dismiss', expectedGoalId: finishedGoal.id }]);
});

test('a Goal the model stopped is dismissed the same way; a running one offers no dismiss', async (ctx) => {
  const { host, render } = mountGoal(ctx);
  await render({ ...finishedGoal, id: 'goal-stopped', status: 'stopped' });
  assert.ok(host.querySelector('.session-goal-dismiss'), 'a Goal the model stopped is dismissed the same way');
  await render({ ...finishedGoal, id: 'goal-running', status: 'active' });
  assert.equal(host.querySelector('.session-goal-dismiss'), null);
  assert.equal(button(host, 'Dismiss goal'), undefined);
});
