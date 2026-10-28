// The custom provider dialog's "Additional keys" list: masked rows below the
// API key field, saved in order, kept by blank rows, never shown back.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { ProvidersPanel } = await import('./provider-panel.tsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const KEY_A = '0d6f3d4e-8c55-4a43-9b3e-6a8f6c3f1b10';
const KEY_B = '1e7a4e5f-9d66-4b54-8c4f-7b9a7d4a2c21';
const CUSTOM = {
  id: 'custom:acme',
  name: 'Acme',
  custom: true,
  protocol: 'openai-chat',
  baseURL: 'https://acme.test/v1',
  schemaVersion: 2,
  auth: 'key',
  discovery: { newModelsHidden: false },
  modelOverrides: { 'acme-1': { manual: true } },
  models: [{ id: 'acme-1', manual: true, hidden: false }],
  authenticated: true,
  enabled: true,
};

function mount(t, { calls, api }) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  const run = async (capability, args) => {
    calls.push({ capability, args });
    if (capability === 'saveCustomProvider') return args[0];
    if (capability === 'discoverCustomProviderModels') return { models: [{ id: 'found' }] };
    return undefined;
  };
  return () =>
    act(async () =>
      root.render(
        React.createElement(ProvidersPanel, {
          api: {},
          data: { providerSetup: { api, oauth: [] }, __loadedSections: ['providerSetup'] },
          pending: '',
          run,
          confirm: () => {},
        })
      )
    );
}

const button = (label) =>
  [...document.querySelectorAll('button')].find(
    (el) => (el.getAttribute('aria-label') || el.textContent.trim()) === label
  );
const click = (el) => act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
async function type(el, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const field = (label) =>
  document.getElementById([...document.querySelectorAll('label')].find((l) => l.textContent === label).htmlFor);
const form = () => document.querySelector('form.settings-custom-provider-form');
const submit = () =>
  act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
const keyRows = () => [...form().querySelectorAll('.extensions-mcp-list-row:not(.extensions-mcp-pair-row) input')];
const lastSave = (calls) => calls.filter((c) => c.capability === 'saveCustomProvider').at(-1).args[0];

test('a new provider adds and removes masked additional keys below the API key and saves them in order', async (t) => {
  const calls = [];
  await mount(t, { calls, api: [CUSTOM] })();
  await click(button('Add custom provider'));
  await type(field('Display name'), 'New');
  await type(field('Base URL'), 'https://new.test/v1');
  await type(field('API key'), 'sk-primary');
  // Right below the API key field, before the authentication switch.
  const title = [...form().querySelectorAll('label')].find((label) => label.textContent === 'Additional keys');
  const following = (a, b) => Boolean(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(following(field('API key'), title));
  assert.ok(following(title, form().querySelector('.settings-model-check')));
  assert.ok(form().textContent.includes('Additional keys are used in order when one hits its usage limit.'));
  assert.deepEqual(keyRows(), []);
  await click(button('+ Add key'));
  await click(button('+ Add key'));
  await click(button('+ Add key'));
  assert.ok(keyRows().every((input) => input.type === 'password'));
  await type(keyRows()[0], 'sk-second');
  await type(keyRows()[1], 'sk-dropped');
  await type(keyRows()[2], 'sk-third');
  await click(button('Remove additional key 2'));
  assert.deepEqual(
    keyRows().map((input) => input.value),
    ['sk-second', 'sk-third']
  );
  // A blank new row is not sent.
  await click(button('+ Add key'));
  await submit();
  assert.deepEqual(lastSave(calls).extraApiKeys, [{ apiKey: 'sk-second' }, { apiKey: 'sk-third' }]);
  assert.equal(lastSave(calls).apiKey, 'sk-primary');
});

test('an existing provider shows its saved keys blank, keeps them, and saves removals and replacements', async (t) => {
  const calls = [];
  await mount(t, { calls, api: [{ ...CUSTOM, extraApiKeys: [{ id: KEY_A }, { id: KEY_B }] }] })();
  const open = async () => {
    await click(button('Edit'));
    assert.equal(keyRows().length, 2);
    for (const input of keyRows()) {
      assert.equal(input.type, 'password');
      assert.equal(input.value, '');
      assert.equal(input.placeholder, 'Leave blank to keep the saved key');
    }
  };
  // Untouched: every saved key is kept.
  await open();
  await submit();
  assert.deepEqual(lastSave(calls).extraApiKeys, [{ id: KEY_A }, { id: KEY_B }]);
  // Replace the second, drop the first, add one.
  await open();
  await type(keyRows()[1], 'sk-new-b');
  await click(button('Remove additional key 1'));
  await click(button('+ Add key'));
  await type(keyRows()[1], 'sk-added');
  await submit();
  assert.deepEqual(lastSave(calls).extraApiKeys, [{ id: KEY_B, apiKey: 'sk-new-b' }, { apiKey: 'sk-added' }]);
  // Removing every row clears them.
  await open();
  await click(button('Remove additional key 2'));
  await click(button('Remove additional key 1'));
  await submit();
  assert.deepEqual(lastSave(calls).extraApiKeys, []);
});

test('a single-key provider saves no additional key list', async (t) => {
  const calls = [];
  await mount(t, { calls, api: [CUSTOM] })();
  await click(button('Edit'));
  assert.deepEqual(keyRows(), []);
  await submit();
  assert.equal('extraApiKeys' in lastSave(calls), false);
});
