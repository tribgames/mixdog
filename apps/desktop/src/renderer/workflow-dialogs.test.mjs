import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

// React DOM detects input-event support at import time; initialize the DOM first.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { AgentEditorDialog, RouteEditorDialog, WorkflowEditorDialog } = await import('./workflow-dialogs.tsx');
test.after(() => dom.window.close());

const route = { provider: 'openai', model: 'test-model' };
const models = [
  {
    ...route,
    display: 'Test model',
    effortOptions: [],
  },
];

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

for (const editor of editors) {
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
