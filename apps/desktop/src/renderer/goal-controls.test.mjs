import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { SessionGoalIsland } from './SessionGoalIsland.tsx';
import { ComposerGoalDialog } from './ComposerGoalDialog.tsx';
import { t } from './i18n.ts';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

test('collapsed goal controls address their own session, confirm stop, and preserve the edit draft', async () => {
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
  const goal = {
    id: 'goal-controls',
    revision: 3,
    objective: 'Approved objective',
    status: 'active',
    timeLimitMs: 3_600_000,
    timeUsedMs: 5_000,
    remainingMs: 3_595_000,
    timeMode: 'max',
    tasks: [{ id: 'one', text: 'Current work', status: 'in_progress', kind: 'work' }],
  };
  const render = (current) =>
    act(async () =>
      root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'own-pane', goal: current },
        })
      )
    );
  try {
    await render(goal);
    const trigger = host.querySelector('[aria-expanded]');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    for (const label of ['Pause', 'Edit goal', 'Stop goal']) {
      const control = button(host, label);
      assert.ok(control);
      assert.equal(control.title, t(label));
      assert.equal(
        control.closest('[inert], [aria-hidden="true"], button[aria-expanded]'),
        null,
        `${label} is available without opening the drawer`
      );
    }
    await click(button(host, 'Pause'));
    assert.deepEqual(calls.at(-1), {
      capability: 'goalControl',
      sessionId: 'own-pane',
      args: [{ action: 'pause', expectedGoalId: goal.id }],
    });
    await render({ ...goal, status: 'paused' });
    await click(button(host, 'Resume'));
    assert.equal(calls.at(-1).args[0].action, 'resume');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(button(host, 'Edit goal'));
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.querySelector('textarea').value, goal.objective);
    const mode = dialog.querySelector('[role="combobox"]');
    assert.equal(mode.getAttribute('aria-label'), t('Time budget mode'));
    assert.equal(mode.textContent, t('Maximum time — finish early when verified'));
    await click(mode);
    const options = document.querySelector('[role="listbox"]');
    assert.equal(
      options.querySelector('[aria-selected="true"]').textContent,
      t('Maximum time — finish early when verified')
    );
    await click(button(options, 'Sustained work — continue for the full duration'));
    assert.equal(mode.textContent, t('Sustained work — continue for the full duration'));
    assert.equal(mode.getAttribute('aria-expanded'), 'false');
    await click(button(dialog, 'Save'));
    assert.deepEqual(calls.at(-1).args[0], {
      action: 'edit',
      expectedGoalId: goal.id,
      objective: goal.objective,
      timeLimitMs: goal.timeLimitMs,
      timeMode: 'duration',
      revision: 3,
    });
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    await click(button(host, 'Stop goal'));
    assert.notEqual(calls.at(-1).args[0].action, 'stop', 'asking for confirmation must not stop work');
    assert.equal(
      trigger.getAttribute('aria-expanded'),
      'true',
      'stop reveals its confirmation from the collapsed island'
    );
    assert.equal(button(host, 'Confirm stop').closest('[inert], [aria-hidden="true"]'), null);
    await click(button(host, 'Confirm stop'));
    assert.equal(calls.at(-1).args[0].action, 'stop');
    await render({ ...goal, status: 'stopped' });
    assert.equal(button(host, 'Resume'), undefined);
    assert.equal(button(host, 'Edit goal'), undefined);
    assert.equal(button(host, 'Stop goal'), undefined);
    assert.ok(host.textContent.includes('Current work'), 'unfinished work remains visible');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('goal creation defaults to maximum time and preserves input after a rejected start', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const commands = [];
  const anchor = { current: host };
  const initialGoal = { objective: 'Existing duration', timeMode: 'duration', timeLimitMs: 1_800_000 };
  try {
    await act(async () =>
      root.render(
        React.createElement(ComposerGoalDialog, {
          anchor,
          disabled: false,
          onStart: async (command) => {
            commands.push(command);
            return false;
          },
          onClose() {},
          returnFocus() {},
        })
      )
    );
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.querySelector('[role="combobox"]').textContent, t('Maximum time — finish early when verified'));
    await act(async () => {
      const input = dialog.querySelector('textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'Deliver result');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await click(button(dialog, 'Start goal'));
    assert.equal(commands.at(-1), '/goal Deliver result --time 60m --time-mode max');
    assert.equal(dialog.querySelector('textarea').value, 'Deliver result');
    assert.ok(dialog.textContent.includes(t('Goal could not be started. Your input has been kept.')));
    await act(async () =>
      root.render(
        React.createElement(ComposerGoalDialog, {
          key: 'edit',
          anchor,
          disabled: false,
          initialGoal,
          onSave: async (value) => {
            commands.push(value);
            return false;
          },
          onClose() {},
          returnFocus() {},
        })
      )
    );
    const edit = document.querySelector('[role="dialog"]');
    await click(button(edit, 'Save'));
    assert.deepEqual(commands.at(-1), {
      objective: initialGoal.objective,
      timeLimitMs: 1_800_000,
      timeMode: 'duration',
    });
    assert.equal(edit.querySelector('textarea').value, initialGoal.objective);
    assert.equal(
      edit.querySelector('[role="combobox"]').textContent,
      t('Sustained work — continue for the full duration')
    );
    assert.ok(edit.textContent.includes(t('Goal could not be started. Your input has been kept.')));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
