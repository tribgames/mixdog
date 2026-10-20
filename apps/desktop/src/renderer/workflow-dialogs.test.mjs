import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// React DOM detects input-event support at import time; initialize the DOM first.
const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement'],
});
const { createRoot } = await import('react-dom/client');
const { AgentEditorDialog, RouteEditorDialog, WorkflowEditorDialog, agentBodyFromBrief } = await import(
  './workflow-dialogs.tsx'
);
test.after(() => dom.window.close());

test('the default AGENT.md of a new agent is conversational, not a worker contract', () => {
  const body = agentBodyFromBrief(' GitHub 감시 ', ' 새 이슈를 요약합니다 ');
  assert.match(body, /^# GitHub 감시\n\n새 이슈를 요약합니다\n\n/);
  assert.match(body, /natural, friendly conversation, in the language they write in/);
  assert.doesNotMatch(body, /English|Status|preamble|report/i);
  assert.match(agentBodyFromBrief('Bench', ''), /^# Bench\n\n- Help the user in a natural/);
});

const route = { provider: 'openai', model: 'test-model' };
const models = [
  {
    ...route,
    display: 'Test model',
    effortOptions: [],
  },
];

test('fallback rows add empty, block saving, reorder with tuning, and remove', async (t) => {
  const render = harness(t);
  const secondary = { provider: 'anthropic', model: 'second', effort: 'low' };
  const saved = [];
  await render(
    React.createElement(RouteEditorDialog, {
      target: {
        id: 'worker',
        label: 'Worker',
        modelKind: 'agent',
        readOnlyDefinition: true,
        route: { ...route, effort: 'high', fallbacks: [secondary] },
      },
      models: [
        ...models,
        { ...secondary, display: 'Second', effortOptions: ['low'] },
        { provider: 'gemini', model: 'third', display: 'Third', effortOptions: [] },
      ],
      busy: false,
      onCancel() {},
      onSave: (value) => saved.push(value),
    })
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelectorAll('.route-chain-row').length, 2);
  assert.equal(dialog.querySelector('.route-chain-number'), null);
  assert.ok(dialog.querySelector('.route-chain-heading [aria-label="Add fallback model"]'));
  assert.doesNotMatch(dialog.textContent, /Try models from top to bottom/);
  assert.equal(dialog.querySelector('.route-chain-hint'), null);
  assert.equal(dialog.querySelector('.route-chain-unavailable'), null);
  const handles = dialog.querySelectorAll('.route-chain-handle');
  await act(async () =>
    handles[1].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowUp',
        altKey: true,
        bubbles: true,
      })
    )
  );
  await act(async () =>
    dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.equal(saved[0].provider, 'anthropic');
  assert.equal(saved[0].effort, 'low');
  assert.equal(saved[0].fallbacks[0].effort, 'high');
  await act(async () => dialog.querySelector('[aria-label="Add fallback model"]').click());
  assert.equal(dialog.querySelectorAll('.route-chain-row').length, 3);
  assert.match(dialog.querySelector('.route-chain-hint').textContent, /Fallback models must use different providers/);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
  assert.equal(dialog.querySelector('[aria-label="Add fallback model"]').disabled, true);
  await act(async () => dialog.querySelector('[aria-label="Remove model 3"]').click());
  assert.equal(dialog.querySelectorAll('.route-chain-row').length, 2);
  assert.equal(dialog.querySelector('.route-chain-hint'), null);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, false);
});

function harness(t) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return async (element) => act(async () => root.render(element));
}

const editors = [
  {
    name: 'custom agent',
    component: AgentEditorDialog,
    props: (disabled) => ({
      agent: { id: 'reviewer', name: 'Reviewer', body: 'Review changes.', route, disabled },
      deletable: true,
      onDelete() {},
    }),
  },
  {
    name: 'built-in agent',
    component: RouteEditorDialog,
    props: (disabled) => ({
      target: {
        id: 'reviewer',
        label: 'Reviewer',
        route,
        capability: 'setAgentRoute',
        modelKind: 'agent',
        description: 'Review changes.',
        readOnlyDefinition: true,
        disabled,
      },
    }),
  },
];

test('the agent editor keeps an existing AGENT.md and fills an emptied one from the name and description', async (t) => {
  const render = harness(t);
  const priorFormData = globalThis.FormData;
  globalThis.FormData = dom.window.FormData;
  t.after(() => {
    globalThis.FormData = priorFormData;
  });
  const saved = [];
  const agent = { id: 'reviewer', name: 'Reviewer', description: 'Reviews PRs', body: 'Review changes.', route };
  const submit = async () =>
    act(async () =>
      document
        .querySelector('.workflows-dialog form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    );
  await render(
    React.createElement(AgentEditorDialog, {
      agent,
      models: [],
      busy: false,
      onCancel() {},
      onSave: (value) => saved.push(value),
    })
  );
  const body = document.querySelector('textarea[aria-label="AGENT.md"]');
  assert.equal(body.value, 'Review changes.', 'editing shows the real AGENT.md');
  await submit();
  assert.equal(saved[0].body, 'Review changes.');

  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setter.call(body, '');
    body.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await submit();
  assert.equal(saved[1].body, agentBodyFromBrief('Reviewer', 'Reviews PRs'));
  assert.match(saved[1].body, /^# Reviewer\n\nReviews PRs\n\n/);
});

test('workflow editor contains only instructions and metadata, not delegation controls', async (t) => {
  const render = harness(t);
  await render(
    React.createElement(WorkflowEditorDialog, {
      pack: null,
      deletable: false,
      busy: false,
      onCancel() {},
      onSave() {},
      onDelete() {},
    })
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector('input[type="checkbox"]'), null);
  assert.doesNotMatch(dialog.textContent, /Allow agents|Use no agents|Whether this workflow can delegate/);
  assert.doesNotMatch(dialog.querySelector('textarea').value, /delegate to agents/);
  assert.match(dialog.querySelector('textarea').value, /reviewed and verified/);
});

test('registration explains why no further provider can be added', async (t) => {
  const render = harness(t);
  await render(
    React.createElement(RouteEditorDialog, {
      target: { id: 'worker', label: 'Worker', modelKind: 'agent', readOnlyDefinition: true, route },
      models,
      busy: false,
      onCancel() {},
      onSave() {},
    })
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector('[aria-label="Add fallback model"]').disabled, true);
  assert.equal(dialog.querySelector('.route-chain-hint'), null);
  assert.match(dialog.querySelector('[role="status"]').textContent, /No other providers are available to add/);
});

test('Web Search adds from its own catalog and excludes the occupied provider', async (t) => {
  const render = harness(t);
  await render(
    React.createElement(RouteEditorDialog, {
      target: { id: 'web-search', label: 'Web Search', modelKind: 'webSearch', readOnlyDefinition: true, route },
      models: [...models, { provider: 'gemini', model: 'search-second', display: 'Search second', effortOptions: [] }],
      busy: false,
      onCancel() {},
      onSave() {},
    })
  );
  const dialog = document.querySelector('[role="dialog"]');
  await act(async () => dialog.querySelector('[aria-label="Add fallback model"]').click());
  assert.match(dialog.querySelector('.route-chain-hint').textContent, /Fallback models must use different providers/);
  await act(async () => dialog.querySelectorAll('.model-trigger')[1].click());
  await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve)));
  const sheet = document.querySelector('.route-sheet');
  assert.ok(sheet, 'uses the existing model picker');
  await act(async () => sheet.querySelector('.route-sheet-row').click());
  const catalog = document.querySelector('.route-sheet-flyout');
  assert.ok(catalog);
  assert.match(catalog.textContent, /Search second/);
  assert.doesNotMatch(catalog.textContent, /Test model/);
});

for (const editor of editors) {
  test(`${editor.name} with no model waits for one before switching on or saving`, async (t) => {
    const render = harness(t);
    const toggles = [];
    const base = editor.props(true);
    const props = {
      ...base,
      ...(base.agent ? { agent: { ...base.agent, route: {} } } : { target: { ...base.target, route: {} } }),
      models,
      busy: false,
      onCancel() {},
      onSave() {},
      onToggle(enabled) {
        toggles.push(enabled);
      },
    };
    await render(React.createElement(editor.component, props));
    const dialog = document.querySelector('[role="dialog"]');
    const save = [...dialog.querySelectorAll('button[type="submit"]')].at(-1);
    // Off with no model: nothing to hold back.
    assert.equal(save.disabled, false);
    assert.equal(dialog.querySelector('.workflows-route-required'), null);
    await act(async () => dialog.querySelector('input[type="checkbox"]').click());
    // On with an empty model: no "on" write yet, and Save stays blocked.
    assert.deepEqual(toggles, []);
    assert.equal(save.disabled, true);
    assert.equal(dialog.querySelector('.workflows-route-required'), null);
    assert.doesNotMatch(dialog.textContent, /Pick a model to turn this agent on/);
    // Switching back off is written right away.
    await act(async () => dialog.querySelector('input[type="checkbox"]').click());
    assert.deepEqual(toggles, [false]);
    assert.equal(save.disabled, false);
  });

  for (const initiallyDisabled of [false, true]) {
    test(`${editor.name} keeps its model visible across toggles when initially ${initiallyDisabled ? 'off' : 'on'}`, async (t) => {
      const render = harness(t);
      const toggles = [];
      const props = {
        ...editor.props(initiallyDisabled),
        models,
        busy: false,
        onCancel() {},
        onSave() {},
        onToggle(enabled, selection) {
          toggles.push({ enabled, selection });
        },
      };
      await render(React.createElement(editor.component, props));

      const assertModelVisible = (busy = false) => {
        const trigger = document.querySelector('[role="dialog"] .model-trigger');
        assert.ok(trigger, 'model controls remain rendered regardless of agent status');
        assert.match(trigger.textContent, /Test model/);
        assert.equal(trigger.disabled, busy, 'only an in-flight operation disables model controls');
      };
      const toggle = document.querySelector('[role="dialog"] input[type="checkbox"]');
      assert.equal(toggle.checked, !initiallyDisabled);
      assertModelVisible();

      await act(async () => toggle.click());
      assert.equal(toggle.checked, initiallyDisabled);
      assertModelVisible();
      await act(async () => toggle.click());
      assert.equal(toggle.checked, !initiallyDisabled);
      assertModelVisible();
      assert.deepEqual(toggles, [
        { enabled: initiallyDisabled, selection: route },
        { enabled: !initiallyDisabled, selection: route },
      ]);

      await render(React.createElement(editor.component, { ...props, busy: true }));
      assertModelVisible(true);
    });
  }
}
