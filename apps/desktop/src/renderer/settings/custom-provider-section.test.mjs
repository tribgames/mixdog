import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

// react-dom reads the DOM at load time (input-event support), so the window must exist first.
const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { ProvidersPanel } = await import('./provider-panel.tsx');
const { filterConfiguredModels } = await import('../model-catalog.tsx');
const { sidebarReferenceKeysForMutation } = await import('../sidebar-reference-cache.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CUSTOM = {
  id: 'custom:acme',
  name: 'Acme',
  custom: true,
  protocol: 'openai-chat',
  baseURL: 'https://acme.test/v1',
  models: [{ id: 'acme-1' }],
  authenticated: true,
  enabled: true,
};
const BUILTIN = { id: 'deepseek', name: 'DeepSeek', authenticated: false };

function mount(t, { calls, handlers = {}, api = [BUILTIN, CUSTOM] } = {}) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  const confirms = [];
  const run = async (capability, args) => {
    calls.push({ capability, args });
    const handler = handlers[capability];
    return handler ? handler(...args) : undefined;
  };
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(ProvidersPanel, {
          api: {},
          data: { providerSetup: { api, oauth: [] }, __loadedSections: ['providerSetup'] },
          pending: '',
          run,
          confirm: (options) => confirms.push(options),
        })
      )
    );
  return { render, confirms };
}

const button = (label) => [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || el.textContent.trim()) === label);
const click = (el) => act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
async function type(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const field = (label) => document.getElementById(document.querySelector(`label`) && [...document.querySelectorAll('label')].find((l) => l.textContent === label).htmlFor);
const customForm = () => document.querySelector('form.settings-custom-provider-form');
const submit = () =>
  act(async () => customForm().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));

test('custom section ends the list with a registration row, a popup and separate saved-provider cards', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls, api: [BUILTIN, CUSTOM, { ...CUSTOM, id: 'custom:second', name: 'Second' }] });
  await render();
  const headings = [...document.querySelectorAll('section h3')].map((h) => h.textContent);
  assert.equal(headings.at(-1), 'Custom providers');
  const apiGroup = [...document.querySelectorAll('section')].find((s) => s.querySelector('h3')?.textContent === 'API-key providers');
  assert.ok(!apiGroup.textContent.includes('Acme'));
  const section = [...document.querySelectorAll('section')].at(-1);
  assert.ok(section.textContent.includes('Acme'));
  const add = button('Add custom provider');
  assert.equal(section.querySelector('header button'), null);
  assert.equal(add.closest('.settings-resource').querySelector('b').textContent, 'Add custom provider');
  assert.equal(add.textContent, '');
  assert.ok(add.querySelector('svg'));
  assert.equal([...section.querySelectorAll('button')][0], add);
  const cards = [...section.querySelectorAll(':scope > .settings-group-body')];
  assert.deepEqual(cards.map(card => card.querySelector('.settings-resource-title b').textContent), ['Add custom provider', 'Acme', 'Second']);
  await click(add);
  assert.ok(add.disabled);
  assert.ok(customForm());
  const dialog = document.querySelector('[role=dialog]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.contains(customForm()));
  assert.equal(cards.some(card => card.contains(customForm())), false);
  await click(button('Cancel'));
  assert.equal(add.disabled, false);
  assert.equal(customForm(), null);
  assert.equal(document.querySelector('[role=dialog]'), null);
});

test('form offers the three formats and masks the API key', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls });
  await render();
  await click(button('Add custom provider'));
  const options = [...field('API format').options].map((o) => [o.value, o.textContent]);
  assert.deepEqual(options, [
    ['openai-chat', 'OpenAI Chat Completions'],
    ['openai-responses', 'OpenAI Responses'],
    ['anthropic', 'Anthropic Messages'],
  ]);
  assert.equal(field('API key').type, 'password');
  assert.equal(field('API key').required, true);
  assert.equal(customForm().querySelector('textarea'), null);
  assert.equal(button('Discover models'), undefined);
  const footer = document.querySelector('[role=dialog] > footer');
  assert.deepEqual([...footer.querySelectorAll('button')].map(el => el.textContent), ['Test connection', 'Cancel', 'Save']);
  assert.equal(footer.querySelector('[type=submit]').form, customForm());
});

test('registration saves without model IDs and relies on the shared catalog refresh', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      saveCustomProvider: (input) => ({ ...input, id: 'custom:new' }),
    },
  });
  await render();
  await click(button('Add custom provider'));
  await type(field('Display name'), 'New');
  await type(field('Base URL'), 'https://new.test/v1');
  await type(field('API key'), 'sk-secret');
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider');
  assert.deepEqual(save.args[0], {
    name: 'New',
    protocol: 'openai-chat',
    baseURL: 'https://new.test/v1',
    apiKey: 'sk-secret',
    models: [],
  });
  assert.equal(calls.some(call => call.capability === 'discoverCustomProviderModels'), false);
  assert.equal(customForm(), null);
});

test('failed connection test and save show errors without reporting success', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      testCustomProvider: () => {
        throw new Error('bad key');
      },
      saveCustomProvider: () => {
        throw new Error('disk full');
      },
    },
  });
  await render();
  await click(button('Add custom provider'));
  await type(field('Display name'), 'X');
  await type(field('Base URL'), 'https://x.test');
  await type(field('API key'), 'test-key');
  await click(button('Test connection'));
  assert.ok([...document.querySelectorAll('[role=alert]')].some((el) => /bad key/.test(el.textContent)));
  assert.equal(document.querySelector('[role=status]'), null);
  await submit();
  assert.ok([...document.querySelectorAll('[role=alert]')].some((el) => /disk full/.test(el.textContent)));
  assert.ok(customForm());
});

test('non-local HTTP base URLs are rejected before any backend call', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls, handlers: { testCustomProvider: () => ({ ok: true }) } });
  await render();
  await click(button('Add custom provider'));
  await type(field('Base URL'), 'http://remote.test/v1');
  await click(button('Test connection'));
  assert.match(document.querySelector('[role=alert]').textContent, /HTTPS/);
  assert.equal(calls.length, 0);
  await type(field('Base URL'), 'http://localhost:11434/v1');
  await click(button('Test connection'));
  assert.equal(calls.length, 1);
});

test('successful test reports success', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls, handlers: { testCustomProvider: () => ({ ok: true }) } });
  await render();
  await click(button('Add custom provider'));
  await type(field('Base URL'), 'https://x.test');
  await click(button('Test connection'));
  assert.equal(document.querySelector('[role=status]').textContent, 'Connection successful.');
});

test('edit keeps secret blank, sends id; delete is confirmed', async (t) => {
  const calls = [];
  const { render, confirms } = mount(t, { calls, handlers: { saveCustomProvider: (i) => i } });
  await render();
  await click(button('Edit'));
  assert.ok(document.querySelector('[role=dialog]').contains(customForm()));
  assert.equal(field('API key').value, '');
  assert.equal(field('API key').required, false);
  assert.equal(field('Display name').value, 'Acme');
  assert.equal(customForm().querySelector('textarea'), null);
  await type(field('Display name'), 'Acme 2');
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal(save.id, 'custom:acme');
  assert.equal('apiKey' in save, false);
  assert.deepEqual(save.models, CUSTOM.models);

  await click(button('Delete'));
  assert.equal(calls.some((c) => c.capability === 'removeCustomProvider'), false);
  assert.equal(confirms.length, 1);
  await confirms[0].onConfirm();
  assert.deepEqual(calls.at(-1), { capability: 'removeCustomProvider', args: ['custom:acme'] });
});

test('custom providers invalidate caches and feed model selection', () => {
  assert.deepEqual(sidebarReferenceKeysForMutation('saveCustomProvider'), sidebarReferenceKeysForMutation('forgetProviderAuth'));
  assert.deepEqual(sidebarReferenceKeysForMutation('removeCustomProvider'), sidebarReferenceKeysForMutation('forgetProviderAuth'));
  const models = [
    { provider: 'custom:acme', model: 'acme-1' },
    { provider: 'custom:off', model: 'x' },
  ];
  const setup = { api: [CUSTOM, { ...CUSTOM, id: 'custom:off', enabled: false }] };
  assert.deepEqual(filterConfiguredModels(models, setup), [models[0]]);
});
