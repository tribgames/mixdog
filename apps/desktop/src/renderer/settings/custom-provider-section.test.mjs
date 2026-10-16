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
  // The backend row (provider-admin customProviderRow): v2 fields plus effective rows.
  schemaVersion: 2,
  auth: 'key',
  discovery: { newModelsHidden: false },
  modelOverrides: { 'acme-1': { manual: true } },
  models: [{ id: 'acme-1', manual: true, hidden: false }],
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

const button = (label) =>
  [...document.querySelectorAll('button')].find(
    (el) => (el.getAttribute('aria-label') || el.textContent.trim()) === label
  );
const click = (el) => act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
async function type(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const field = (label) =>
  document.getElementById(
    document.querySelector(`label`) &&
      [...document.querySelectorAll('label')].find((l) => l.textContent === label).htmlFor
  );
const customForm = () => document.querySelector('form.settings-custom-provider-form');
const submit = () =>
  act(async () => customForm().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));

test('custom section ends the list with a registration row, a popup and separate saved-provider cards', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls, api: [BUILTIN, CUSTOM, { ...CUSTOM, id: 'custom:second', name: 'Second' }] });
  await render();
  const headings = [...document.querySelectorAll('section h3')].map((h) => h.textContent);
  assert.equal(headings.at(-1), 'Custom providers');
  const apiGroup = [...document.querySelectorAll('section')].find(
    (s) => s.querySelector('h3')?.textContent === 'API-key providers'
  );
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
  assert.deepEqual(
    cards.map((card) => card.querySelector('.settings-resource-title b').textContent),
    ['Add custom provider', 'Acme', 'Second']
  );
  await click(add);
  assert.ok(add.disabled);
  assert.ok(customForm());
  const dialog = document.querySelector('[role=dialog]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.contains(customForm()));
  assert.equal(
    cards.some((card) => card.contains(customForm())),
    false
  );
  await click(button('Cancel'));
  assert.equal(add.disabled, false);
  assert.equal(customForm(), null);
  assert.equal(document.querySelector('[role=dialog]'), null);
});

test('form offers the three formats and masks the API key', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls, handlers: { testCustomProvider: () => ({ ok: true }) } });
  await render();
  await click(button('Add custom provider'));
  const format = button('API format');
  await click(format);
  const options = [...document.querySelectorAll('[role=option]')].map((o) => o.textContent);
  assert.deepEqual(options, ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages']);
  assert.equal(document.querySelector('[role=option][aria-selected=true]').textContent, 'OpenAI Chat Completions');
  await click(button('OpenAI Responses'));
  assert.equal(format.textContent, 'OpenAI Responses');
  assert.equal(document.querySelector('[role=listbox]'), null);
  await click(format);
  await act(async () =>
    document
      .querySelector('[role=listbox]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  );
  await act(async () =>
    document
      .querySelector('[role=listbox]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  assert.equal(format.textContent, 'Anthropic Messages');
  await type(field('Display name'), 'Manual');
  await type(field('Base URL'), 'https://manual.test/v1');
  await type(field('API key'), 'test-key');
  await click(button('Test connection'));
  assert.equal(calls.at(-1).args[0].protocol, 'anthropic');
  assert.equal(field('API key').type, 'password');
  assert.equal(field('API key').required, true);
  assert.equal(customForm().querySelector('textarea'), null);
  assert.equal(button('Discover models'), undefined);
  const footer = document.querySelector('[role=dialog] > footer');
  assert.deepEqual(
    [...footer.querySelectorAll('button')].map((el) => el.textContent),
    ['Test connection', 'Cancel', 'Save']
  );
  assert.equal(footer.querySelector('[type=submit]').form, customForm());
});

test('registration saves without model IDs and relies on the shared catalog refresh', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      discoverCustomProviderModels: () => ({ models: [{ id: 'found-1' }] }),
      saveCustomProvider: (input) => ({ ...input, id: 'custom:new' }),
    },
  });
  await render();
  await click(button('Add custom provider'));
  assert.equal(document.querySelector('details').open, false);
  await type(field('Display name'), 'New');
  await type(field('Base URL'), 'https://new.test/v1');
  await type(field('API key'), 'sk-secret');
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider');
  assert.deepEqual(save.args[0], {
    schemaVersion: 2,
    name: 'New',
    protocol: 'openai-chat',
    baseURL: 'https://new.test/v1',
    apiKey: 'sk-secret',
    auth: 'key',
    modelOverrides: {},
  });
  assert.equal(calls.filter((call) => call.capability === 'discoverCustomProviderModels').length, 1);
  assert.equal(customForm(), null);
});

const fillNew = async () => {
  await click(button('Add custom provider'));
  await type(field('Display name'), 'New');
  await type(field('Base URL'), 'https://new.test/v1');
  await type(field('API key'), 'sk-secret');
};
const alerts = () => [...document.querySelectorAll('[role=alert]')].map((el) => el.textContent).join('\n');

test('discovery failure on save blocks save, opens manual entry and categorizes guidance', async (t) => {
  let error;
  const calls = [];
  const { render } = mount(t, { calls, handlers: { discoverCustomProviderModels: () => ({ models: [], error }) } });
  await render();
  await fillNew();
  for (const [next, pattern, open] of [
    [{ kind: 'authentication', status: 401, message: 'x' }, /Check the API key/, false],
    [{ kind: 'request', message: 'timeout' }, /Model discovery failed: timeout.*retry/, false],
    [
      { kind: 'unavailable', status: 404, message: 'x' },
      /could not be loaded \(HTTP 404\).*add model IDs manually/,
      true,
    ],
  ]) {
    error = next;
    await submit();
    assert.match(alerts(), pattern);
    assert.equal(document.querySelector('details').open, open);
    assert.equal(
      calls.some((c) => c.capability === 'saveCustomProvider'),
      false
    );
  }
});

test('empty discovery on save asks for manual models; manual models are saved without discovery', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: { discoverCustomProviderModels: () => ({ models: [] }), saveCustomProvider: (i) => i },
  });
  await render();
  await fillNew();
  await submit();
  assert.match(alerts(), /returned no models/);
  assert.equal(document.querySelector('details').open, true);
  await type(document.querySelector('details input'), 'm-1');
  await click(button('Add model'));
  await type(document.querySelector('details input'), 'm-2');
  await click(button('Add model'));
  await click(button('Remove m-2'));
  calls.length = 0;
  await submit();
  assert.equal(
    calls.some((c) => c.capability === 'discoverCustomProviderModels'),
    false
  );
  const saved = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal(saved.schemaVersion, 2);
  assert.equal('models' in saved, false);
  assert.deepEqual(saved.modelOverrides, { 'm-1': { manual: true } });
});

test('connection test passes manual models and expands manual entry on discovery failure', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      testCustomProvider: (input) =>
        Object.keys(input.modelOverrides).length
          ? { ok: true }
          : { ok: false, phase: 'discovery', error: { kind: 'unavailable', status: 405, message: 'x' } },
    },
  });
  await render();
  await fillNew();
  await click(button('Test connection'));
  assert.match(alerts(), /could not be loaded \(HTTP 405\)/);
  assert.doesNotMatch(alerts(), /key/i);
  assert.equal(document.querySelector('details').open, true);
  await type(document.querySelector('details input'), 'manual-1');
  await click(button('Test connection'));
  assert.deepEqual(calls.at(-1).args[0].modelOverrides, { 'manual-1': { manual: true } });
  assert.equal(document.querySelector('[role=status]').textContent, 'Connection successful.');
});

test('editing shows manual models expanded; add/remove go through v2 overrides and keep their settings', async (t) => {
  const calls = [];
  const overrides = {
    'acme-1': { manual: true, name: 'Acme One', contextWindow: 1000 },
    'acme-2': { manual: true, reasoning: { levels: ['low'] } },
    discovered: { hidden: true },
  };
  const { render } = mount(t, {
    calls,
    api: [
      {
        ...CUSTOM,
        modelOverrides: overrides,
        models: [
          { id: 'acme-1', manual: true },
          { id: 'acme-2', manual: true },
        ],
      },
    ],
    handlers: { saveCustomProvider: (i) => i },
  });
  await render();
  await click(button('Edit'));
  assert.equal(document.querySelector('details').open, true);
  await type(document.querySelector('details input'), 'extra');
  await click(button('Add model'));
  await click(button('Remove acme-2'));
  await submit();
  const saved = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal('models' in saved, false);
  assert.deepEqual(saved.modelOverrides, {
    'acme-1': { name: 'Acme One', contextWindow: 1000, manual: true },
    // Removing a manual model drops only `manual`; its own settings stay.
    'acme-2': { reasoning: { levels: ['low'] } },
    discovered: { hidden: true },
    extra: { manual: true },
  });
  assert.equal(
    calls.some((c) => c.capability === 'discoverCustomProviderModels'),
    false
  );
});

test('visible explicit models are still submitted after the URL changes, and editing the draft clears errors', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      saveCustomProvider: (i) => i,
      testCustomProvider: () => ({ ok: false, phase: 'discovery', error: { kind: 'empty' } }),
    },
  });
  await render();
  await click(button('Edit'));
  await type(field('Base URL'), 'https://other.test/v1');
  await click(button('Test connection'));
  assert.deepEqual(calls.at(-1).args[0].modelOverrides, CUSTOM.modelOverrides);
  await click(button('Test connection'));
  assert.match(alerts(), /returned no models/);
  await type(document.querySelector('details input'), 'z');
  assert.equal(alerts(), '');
  await submit();
  assert.deepEqual(calls.find((c) => c.capability === 'saveCustomProvider').args[0].modelOverrides, {
    ...CUSTOM.modelOverrides,
    z: { manual: true },
  });
});

test('failed connection test and save show errors without reporting success', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      discoverCustomProviderModels: () => ({ models: [{ id: 'm' }] }),
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
  assert.equal(save.auth, 'key');
  assert.equal(save.schemaVersion, 2);
  assert.deepEqual(save.modelOverrides, CUSTOM.modelOverrides);

  await click(button('Delete'));
  assert.equal(
    calls.some((c) => c.capability === 'removeCustomProvider'),
    false
  );
  assert.equal(confirms.length, 1);
  await confirms[0].onConfirm();
  assert.deepEqual(calls.at(-1), { capability: 'removeCustomProvider', args: ['custom:acme'] });
});

test('custom providers invalidate caches and feed model selection', () => {
  assert.deepEqual(
    sidebarReferenceKeysForMutation('saveCustomProvider'),
    sidebarReferenceKeysForMutation('forgetProviderAuth')
  );
  assert.deepEqual(
    sidebarReferenceKeysForMutation('removeCustomProvider'),
    sidebarReferenceKeysForMutation('forgetProviderAuth')
  );
  assert.deepEqual(
    sidebarReferenceKeysForMutation('updateCustomProviderModel'),
    sidebarReferenceKeysForMutation('saveCustomProvider')
  );
  const models = [
    { provider: 'custom:acme', model: 'acme-1' },
    { provider: 'custom:off', model: 'x' },
  ];
  const setup = { api: [CUSTOM, { ...CUSTOM, id: 'custom:off', enabled: false }] };
  assert.deepEqual(filterConfiguredModels(models, setup), [models[0]]);
});

const editorBtn = (label) =>
  [...document.querySelectorAll('.settings-model-editor footer button')].find((el) => el.textContent === label);
const ROWS = [
  {
    id: 'acme-1',
    manual: false,
    hidden: false,
    supportsReasoning: true,
    reasoningLevels: ['low', 'high'],
    customReasoning: {},
  },
  { id: 'acme-2', manual: false, hidden: true, customReasoning: {} },
];
const withRows = (extra = {}) => ({ ...CUSTOM, models: ROWS, ...extra });
const OVERRIDDEN = { 'acme-1': { maxOutputTokens: 9, reasoning: { levels: [] } } };
const modelCheckbox = (text) =>
  [...document.querySelectorAll('label')].find((l) => l.textContent === text).querySelector('input');

test('keyless provider disables the key field and saves auth none without a key', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: { discoverCustomProviderModels: () => ({ models: [{ id: 'm' }] }), saveCustomProvider: (i) => i },
  });
  await render();
  await click(button('Add custom provider'));
  await type(field('Display name'), 'Local');
  await type(field('Base URL'), 'http://localhost:11434/v1');
  await submit();
  assert.match(alerts(), /No API key/);
  await act(async () => document.querySelector('input[aria-label="No authentication (local server)"]').click());
  assert.equal(field('API key').disabled, true);
  assert.equal(field('API key').required, false);
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal(save.auth, 'none');
  assert.equal('apiKey' in save, false);
});

const settle = (ms = 400) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const hint = () => document.querySelector('.settings-custom-provider-hint');

test('environment variable mode: control, hints, contract-shaped input and invalid name', async (t) => {
  const calls = [];
  let found = true;
  const { render } = mount(t, {
    calls,
    handlers: {
      checkCustomProviderKeyEnv: () => ({ found }),
      discoverCustomProviderModels: () => ({ models: [{ id: 'm' }] }),
      saveCustomProvider: (i) => i,
      testCustomProvider: () => ({ ok: true }),
    },
  });
  await render();
  await click(button('Add custom provider'));
  const group = document.querySelector('[role=group][aria-label="API key source"]');
  assert.ok(group.classList.contains('mx-segmented-compact'));
  assert.equal(group.closest('.settings-custom-provider-key-row').querySelector('label').textContent, 'API key');
  assert.equal(button('Direct input').getAttribute('aria-pressed'), 'true');
  await type(field('Display name'), 'Env');
  await type(field('Base URL'), 'https://env.test/v1');
  await click(button('Environment variable'));
  assert.equal(field('API key environment variable').type, 'text');
  assert.equal(hint(), null);

  await type(field('API key environment variable'), '1BAD');
  await settle();
  assert.equal(hint(), null);
  await submit();
  assert.match(alerts(), /valid environment variable name/);
  assert.equal(
    calls.some((c) => c.capability === 'saveCustomProvider'),
    false
  );

  await type(field('API key environment variable'), 'GROQ_API_KEY');
  await settle();
  assert.deepEqual(calls.filter((c) => c.capability === 'checkCustomProviderKeyEnv').at(-1).args, ['GROQ_API_KEY']);
  assert.equal(hint().textContent, 'Environment variable found. The key is read each time and is not stored.');
  assert.ok(hint().classList.contains('ok'));

  found = false;
  await type(field('API key environment variable'), 'GROQ_KEY');
  await settle();
  assert.equal(hint().textContent, 'GROQ_KEY was not found yet. If you just set it, restart Mixdog to apply it.');
  assert.ok(hint().classList.contains('warn'));

  await click(button('Test connection'));
  const tested = calls.find((c) => c.capability === 'testCustomProvider').args[0];
  assert.equal(tested.apiKeyEnv, 'GROQ_KEY');
  assert.equal('apiKey' in tested, false);
  // Not found is a warning only: save still goes through.
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal(save.apiKeyEnv, 'GROQ_KEY');
  assert.equal('apiKey' in save, false);
  assert.equal(customForm(), null);
});

test('env mode with an unset variable still saves when discovery fails; direct mode stays blocked', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: {
      checkCustomProviderKeyEnv: () => ({ found: false }),
      discoverCustomProviderModels: () => ({
        models: [],
        error: { kind: 'authentication', status: 401, message: 'x' },
      }),
      saveCustomProvider: (i) => i,
    },
  });
  await render();
  await click(button('Add custom provider'));
  await type(field('Display name'), 'Env');
  await type(field('Base URL'), 'https://env.test/v1');
  await type(field('API key'), 'sk-x');
  await submit();
  assert.equal(
    calls.some((c) => c.capability === 'saveCustomProvider'),
    false
  );
  await click(button('Environment variable'));
  await type(field('API key environment variable'), 'UNSET_KEY');
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal(save.apiKeyEnv, 'UNSET_KEY');
  assert.equal(customForm(), null);
});

test('keyless disables the key source control', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls });
  await render();
  await click(button('Add custom provider'));
  assert.equal(button('Direct input').disabled, false);
  await act(async () => document.querySelector('input[aria-label="No authentication (local server)"]').click());
  assert.equal(button('Direct input').disabled, true);
  assert.equal(button('Environment variable').disabled, true);
});

test('editing an env-key provider opens in env mode; switching to direct clears it', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    api: [{ ...CUSTOM, apiKeyEnv: 'ACME_KEY' }],
    handlers: { checkCustomProviderKeyEnv: () => ({ found: true }), saveCustomProvider: (i) => i },
  });
  await render();
  await click(button('Edit'));
  assert.equal(field('API key environment variable').value, 'ACME_KEY');
  assert.equal(button('Environment variable').getAttribute('aria-pressed'), 'true');
  await settle();
  assert.ok(hint().classList.contains('ok'));
  await submit();
  assert.equal(calls.find((c) => c.capability === 'saveCustomProvider').args[0].apiKeyEnv, 'ACME_KEY');

  await click(button('Edit'));
  await click(button('Direct input'));
  assert.equal(field('API key').required, true);
  await submit();
  assert.match(alerts(), /No API key/);
  await type(field('API key'), 'sk-new');
  calls.length = 0;
  await submit();
  const save = calls.find((c) => c.capability === 'saveCustomProvider').args[0];
  assert.equal(save.apiKey, 'sk-new');
  assert.equal(save.apiKeyEnv, null);
});

test('edit lists hidden rows marked; refresh surfaces the discovery error with its rows', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    api: [withRows()],
    handlers: {
      discoverCustomProviderModels: () => ({
        models: [...ROWS, { id: 'acme-3', manual: false, hidden: false }],
        error: { kind: 'authentication', status: 401, message: 'x' },
      }),
    },
  });
  await render();
  await click(button('Edit'));
  let items = [...document.querySelectorAll('.settings-custom-models li')];
  assert.equal(items.length, 2);
  assert.ok(items[1].classList.contains('settings-model-hidden'));
  assert.match(items[1].textContent, /Hidden/);
  assert.equal(alerts(), '');
  await click(button('Refresh models'));
  items = [...document.querySelectorAll('.settings-custom-models li')];
  assert.equal(items.length, 3);
  assert.match(alerts(), /Check the API key/);
  assert.equal(calls.at(-1).args[0].id, 'custom:acme');
});

test('a provider whose stored config is invalid shows Failed with the configuration error', async (t) => {
  const { render } = mount(t, {
    api: [
      { ...CUSTOM, authenticated: true, configError: 'modelOverrides[x].contextWindow must be a positive integer' },
    ],
  });
  await render();
  const row = [...document.querySelectorAll('.settings-custom-providers .settings-resource')].find(
    (el) => el.querySelector('b')?.textContent === 'Acme'
  );
  assert.equal(row.querySelector('.settings-status').textContent, 'Failed');
  assert.equal(row.querySelector('.settings-status').className.includes('danger'), true);
  assert.match(row.querySelector('.settings-resource-meta').textContent, /contextWindow must be a positive integer/);
});

test('the editor offers exactly the runtime reasoning levels', async () => {
  const { REASONING_LEVELS } = await import('./custom-model-editor.tsx');
  const { CUSTOM_REASONING_LEVELS } = await import(
    '../../../../../src/runtime/agent/orchestrator/providers/custom-provider-config.mjs'
  );
  assert.deepEqual([...REASONING_LEVELS], [...CUSTOM_REASONING_LEVELS]);
});

test('model editor sends only touched fields: chips, explicit [], reset null', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    api: [withRows({ modelOverrides: OVERRIDDEN })],
    handlers: { updateCustomProviderModel: () => ({}) },
  });
  await render();
  await click(button('Edit'));
  await click(button('Edit model acme-1'));
  const chip = (name) => [...document.querySelectorAll('.settings-model-chip')].find((c) => c.textContent === name);
  assert.equal(chip('low').getAttribute('aria-pressed'), 'true');
  assert.equal(chip('medium').getAttribute('aria-pressed'), 'false');
  await click(chip('medium'));
  assert.equal(chip('medium').getAttribute('aria-pressed'), 'true');
  await click(chip('none'));
  await click(editorBtn('Save'));
  const args = () => calls.filter((c) => c.capability === 'updateCustomProviderModel').at(-1).args;
  assert.deepEqual(args(), ['custom:acme', 'acme-1', { reasoning: { levels: ['none', 'low', 'medium', 'high'] } }]);

  await click(button('Edit model acme-1'));
  for (const name of ['low', 'high']) await click(chip(name));
  await click(editorBtn('Save'));
  assert.deepEqual(args()[2], { reasoning: { levels: [] } });

  await click(button('Edit model acme-1'));
  await click(button('Reset Reasoning levels to inherited'));
  await type(field('Context window'), '5000');
  await click(button('Reset Max output tokens to inherited'));
  await click(editorBtn('Save'));
  assert.deepEqual(args()[2], { reasoning: { levels: null }, contextWindow: 5000, maxOutputTokens: null });
});

test('changing levels sends wire values pruned to the new levels (null when none remain)', async (t) => {
  const calls = [];
  const rows = [{ ...ROWS[0], customReasoning: { wireValues: { low: 'L', high: 'H' } } }, ROWS[1]];
  const overrides = { 'acme-1': { reasoning: { levels: ['low', 'high'], wireValues: { low: 'L', high: 'H' } } } };
  const { render } = mount(t, {
    calls,
    api: [withRows({ models: rows, modelOverrides: overrides })],
    handlers: { updateCustomProviderModel: () => ({}) },
  });
  await render();
  await click(button('Edit'));
  const chip = (name) => [...document.querySelectorAll('.settings-model-chip')].find((c) => c.textContent === name);
  const args = () => calls.filter((c) => c.capability === 'updateCustomProviderModel').at(-1).args;
  await click(button('Edit model acme-1'));
  await click(chip('high'));
  await click(editorBtn('Save'));
  assert.deepEqual(args()[2], { reasoning: { levels: ['low'], wireValues: { low: 'L' } } });
  await click(button('Edit model acme-1'));
  for (const name of ['low', 'high']) await click(chip(name));
  await click(editorBtn('Save'));
  assert.deepEqual(args()[2], { reasoning: { levels: [], wireValues: null } });
});

test("the model editor shows a discovered row's maxOutputTokens", async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    api: [withRows()],
    handlers: {
      discoverCustomProviderModels: () => ({
        models: [{ ...ROWS[0], contextWindow: 64000, maxOutputTokens: 8192 }, ROWS[1]],
      }),
    },
  });
  await render();
  await click(button('Edit'));
  await click(button('Refresh models'));
  await click(button('Edit model acme-1'));
  const editor = [...document.querySelectorAll('.settings-model-editor')].at(-1);
  assert.equal(editor.querySelector('input[id$="-contextWindow"]').value, '64000');
  assert.equal(editor.querySelector('input[id$="-maxOutputTokens"]').value, '8192');
});

for (const [protocol, expected] of [
  ['openai-chat', ['Standard', 'DeepSeek format']],
  ['anthropic', ['Standard']],
]) {
  test(`model editor wire format gates deepseek by protocol (${protocol})`, async (t) => {
    const calls = [];
    const { render } = mount(t, {
      calls,
      api: [withRows({ protocol })],
      handlers: { updateCustomProviderModel: () => ({}) },
    });
    await render();
    await click(button('Edit'));
    await click(button('Edit model acme-1'));
    await click(button('Wire format'));
    assert.deepEqual(
      [...document.querySelectorAll('[role=option]')].map((o) => o.textContent),
      expected
    );
    await click(button('Standard'));
    await type(field('Wire value for low'), 'LOW');
    await click(editorBtn('Save'));
    assert.deepEqual(calls.at(-1).args[2], {
      reasoning: { wireFormat: 'standard', wireValues: { low: 'LOW' } },
    });
  });
}

test('picker hides hidden custom models and accepts keyless providers', () => {
  const models = [
    { provider: 'custom:acme', model: 'acme-1' },
    { provider: 'custom:acme', model: 'acme-2' },
    { provider: 'custom:local', model: 'l' },
    { provider: 'custom:local', model: 'hidden-by-override' },
  ];
  const local = {
    ...CUSTOM,
    id: 'custom:local',
    auth: 'none',
    authenticated: false,
    models: [],
    modelOverrides: { 'hidden-by-override': { hidden: true } },
  };
  const setup = { api: [withRows(), local] };
  assert.deepEqual(filterConfiguredModels(models, setup), [models[0], models[2]]);
  // A provider whose stored config is invalid offers nothing, keyless included.
  const broken = { ...local, usable: false, configError: 'bad', authenticated: false };
  assert.deepEqual(filterConfiguredModels(models, { api: [withRows(), broken] }), [models[0]]);
});

test('reopening a model editor after a save shows the saved values and keeps unsaved provider fields', async (t) => {
  const calls = [];
  const api = [withRows()];
  const { render } = mount(t, {
    calls,
    api,
    handlers: {
      updateCustomProviderModel: () => {
        // The panel reloads the provider after a refreshing capability.
        api[0] = withRows({ models: [{ ...ROWS[0], contextWindow: 12345 }, ROWS[1]] });
        return {};
      },
    },
  });
  await render();
  await click(button('Edit'));
  await type(field('Display name'), 'Draft name');
  await click(button('Edit model acme-1'));
  await type(document.querySelector('.settings-model-editor input[id$="-contextWindow"]'), '12345');
  await click(editorBtn('Save'));
  await render();
  await click(button('Edit model acme-1'));
  assert.equal(document.querySelector('.settings-model-editor input[id$="-contextWindow"]').value, '12345');
  await click(editorBtn('Cancel'));
  assert.equal(field('Display name').value, 'Draft name');
});

test('refresh with an empty model list shows the empty-result message', async (t) => {
  const calls = [];
  const { render } = mount(t, { calls, handlers: { discoverCustomProviderModels: () => ({ models: [] }) } });
  await render();
  await click(button('Edit'));
  await click(button('Refresh models'));
  assert.match(alerts(), /Automatic discovery returned no models|자동 검색에서 모델이 반환되지 않았습니다/);
});

test('IPC envelopes are stripped and known failures are localized', async (t) => {
  const calls = [];
  let message = '';
  const { render } = mount(t, {
    calls,
    handlers: {
      testCustomProvider: () => {
        throw new Error(`Error invoking remote method 'mixdog:invoke-capability': Error: ${message}`);
      },
      saveCustomProvider: () => {
        throw new Error(
          "Error invoking remote method 'mixdog:invoke-capability': TypeError: custom provider name is invalid."
        );
      },
      discoverCustomProviderModels: () => ({ models: [{ id: 'm' }] }),
    },
  });
  await render();
  await click(button('Add custom provider'));
  await type(field('Display name'), 'X');
  await type(field('Base URL'), 'https://x.test');
  await type(field('API key'), 'k');
  message = 'Connection error.';
  await click(button('Test connection'));
  assert.doesNotMatch(alerts(), /Error invoking|Connection error/);
  assert.match(alerts(), /Could not connect|연결/);
  message = 'custom-test first byte timed out after 60000ms';
  await click(button('Test connection'));
  assert.doesNotMatch(alerts(), /Error invoking|custom-test/);
  assert.match(alerts(), /60/);
  message = 'connection test timed out after 20s';
  await click(button('Test connection'));
  assert.doesNotMatch(alerts(), /connection test timed out/);
  assert.match(alerts(), /20/);
  await submit();
  assert.doesNotMatch(alerts(), /Error invoking|TypeError/);
  assert.match(alerts(), /display name|표시 이름/i);
});

test('name is trimmed, bounded and validated inline before saving', async (t) => {
  const calls = [];
  const { render } = mount(t, {
    calls,
    handlers: { saveCustomProvider: (i) => i, discoverCustomProviderModels: () => ({ models: [{ id: 'm' }] }) },
  });
  await render();
  await click(button('Add custom provider'));
  const name = field('Display name');
  assert.equal(name.maxLength, 200);
  await type(field('Base URL'), 'https://x.test');
  await type(field('API key'), 'k');
  await type(name, '   ');
  await submit();
  assert.ok(name.getAttribute('aria-invalid') === 'true');
  assert.equal(calls.length, 0);
  await type(name, 'a'.repeat(201));
  await submit();
  assert.equal(calls.length, 0);
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  await type(name, '  Ok  ');
  await submit();
  assert.equal(calls.find((c) => c.capability === 'saveCustomProvider').args[0].name, 'Ok');
});

test('a refresh HTTP failure shows a generic status message without internal ids', async (t) => {
  const { render } = mount(t, {
    calls: [],
    handlers: {
      discoverCustomProviderModels: () => ({
        models: [],
        error: { kind: 'other', message: 'custom-6223a6ea-1111 models 500' },
      }),
    },
  });
  await render();
  await click(button('Edit'));
  await click(button('Refresh models'));
  assert.doesNotMatch(alerts(), /custom-6223/);
  assert.match(alerts(), /500/);
});
