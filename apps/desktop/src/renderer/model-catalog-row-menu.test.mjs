import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element'],
});
test.after(restore);
window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { ModelCatalog } = await import('./model-catalog.tsx');
const {
  applyModelPreferenceToModels,
  applyModelPreferenceToSetup,
  takeRequestedModelManagementProvider,
  requestModelManagementProvider,
} = await import('./model-visibility.ts');

const option = (provider, model, extra = {}) => ({
  provider,
  model,
  display: model,
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
  ...extra,
});

const calls = [];
const opened = [];
function Harness() {
  const [models, setModels] = useState([
    option('openai-oauth', 'gpt-5.5'),
    option('openai-oauth', 'gpt-5.4'),
    option('anthropic-oauth', 'claude-opus-5'),
  ]);
  return React.createElement(ModelCatalog, {
    models: models.filter((entry) => entry.savedHidden !== true),
    provider: 'openai-oauth',
    model: 'gpt-5.4',
    onSelect: () => true,
    onClose: () => {},
    onOpenModelManagement: (provider) => opened.push(provider),
    onSetModelPreference: (target, change) => {
      calls.push([target.provider, target.model, change]);
      setModels((current) =>
        applyModelPreferenceToModels(current, target.provider, { model: target.model, ...change })
      );
    },
  });
}

async function mount(t) {
  calls.length = 0;
  opened.length = 0;
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(React.createElement(Harness)));
}

const row = (model) => document.querySelector(`[role="option"][data-row-key$=":${model}"]`);
const menu = () => document.querySelector('[role="menu"]');
const item = (id) => menu()?.querySelector(`[data-action-id="${id}"]`);
const groups = () =>
  [...document.querySelectorAll('.model-group')].map((section) => [
    section.querySelector('h3').textContent,
    [...section.querySelectorAll('[role="option"]')].map((node) => node.textContent),
  ]);
const rightClick = (node) =>
  act(async () => {
    node.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
    );
  });
const key = (node, init) =>
  act(async () => {
    node.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });

test('right-click opens the menu; favouriting moves the row into Favorites and back', async (t) => {
  await mount(t);
  await rightClick(row('gpt-5.5'));
  assert.deepEqual(
    [...menu().querySelectorAll('[role="menuitem"]')].map((node) => node.textContent),
    ['Favorite model', 'Hide from list', 'Open model management']
  );
  await act(async () => item('favorite').click());
  assert.equal(menu(), null);
  assert.deepEqual(calls, [['openai-oauth', 'gpt-5.5', { favorite: true }]]);
  assert.equal(groups()[0][0], 'Favorites');
  assert.match(groups()[0][1][0].toLowerCase(), /^gpt-5\.5/);

  await rightClick(groups()[0][1].length ? document.querySelector('.model-group--favorites [role="option"]') : null);
  assert.equal(item('favorite').textContent, 'Unfavorite model');
  await act(async () => item('favorite').click());
  assert.deepEqual(calls[1], ['openai-oauth', 'gpt-5.5', { favorite: false }]);
  assert.equal(document.querySelector('.model-group--favorites'), null);
});

test('hiding removes the row; the model in use cannot be hidden', async (t) => {
  await mount(t);
  await rightClick(row('gpt-5.4'));
  assert.equal(item('hide').disabled, true);
  await act(async () => item('hide').click());
  assert.deepEqual(calls, []);
  await key(menu(), { key: 'Escape' });

  await rightClick(row('claude-opus-5'));
  assert.equal(item('hide').disabled, false);
  await act(async () => item('hide').click());
  assert.deepEqual(calls, [['anthropic-oauth', 'claude-opus-5', { hidden: true }]]);
  assert.equal(row('claude-opus-5'), null);
});

test('Open model management names the row provider', async (t) => {
  await mount(t);
  await rightClick(row('claude-opus-5'));
  await act(async () => item('manage').click());
  assert.deepEqual(opened, ['anthropic-oauth']);
});

test('ContextMenu key and Shift+F10 open the menu on the focused row; Escape returns focus to it', async (t) => {
  await mount(t);
  const target = row('gpt-5.5');
  target.focus();
  await key(target, { key: 'ContextMenu' });
  assert.notEqual(menu(), null);
  await key(menu(), { key: 'Escape' });
  assert.equal(menu(), null);
  assert.equal(document.activeElement, target);

  await key(target, { key: 'F10', shiftKey: true });
  assert.notEqual(menu(), null);
  await key(menu(), { key: 'Escape' });
  assert.equal(document.activeElement, target);
});

test('preference patches match what Model management saves', () => {
  const models = [option('p', 'a'), option('p', 'b')];
  assert.deepEqual(
    applyModelPreferenceToModels(models, 'p', { model: 'a', hidden: true, favorite: true }).map((m) => [
      m.savedHidden,
      m.favorite,
    ]),
    [
      [true, true],
      [undefined, undefined],
    ]
  );
  const setup = {
    api: [{ id: 'custom-x', custom: true, models: [{ id: 'm' }], modelOverrides: {} }],
    oauth: [],
    local: [],
  };
  const next = applyModelPreferenceToSetup(setup, 'custom-x', { model: 'm', hidden: true });
  assert.equal(next.api[0].modelOverrides.m.hidden, true);
  assert.equal(next.api[0].models[0].hidden, true);
  assert.equal(setup.api[0].models[0].hidden, undefined);
  requestModelManagementProvider('p');
  assert.equal(takeRequestedModelManagementProvider(), 'p');
  assert.equal(takeRequestedModelManagementProvider(), '');
});
