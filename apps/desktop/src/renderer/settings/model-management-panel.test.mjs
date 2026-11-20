import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'Node', 'Element'],
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { ModelManagementPanel } = await import('./model-management-panel.tsx');
const { readModelManagementCatalog } = await import('../model-catalog-cache.ts');

const option = (provider, model, extra = {}) => ({
  provider,
  model,
  display: model,
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
  ...extra,
});

const data = {
  providerSetup: {
    oauth: [
      { id: 'openai-oauth', name: 'OpenAI', group: 'oauth', authenticated: true },
      { id: 'anthropic-oauth', name: 'Anthropic', group: 'oauth', authenticated: false },
    ],
    api: [],
    local: [],
  },
  models: [
    option('openai-oauth', 'gpt-5.5'),
    option('openai-oauth', 'gpt-5.4', { savedHidden: true }),
    option('anthropic-oauth', 'claude-opus-5'),
  ],
  __loadedSections: ['providerSetup', 'models'],
};

async function mount(t, run) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      React.createElement(ModelManagementPanel, {
        api: {},
        data,
        snapshot: { provider: 'openai-oauth', model: 'gpt-5.5' },
        pending: '',
        run,
        confirm: () => {},
      })
    )
  );
}

const card = () => document.querySelector('[data-model-card]');
const button = (label, scope = document) =>
  [...scope.querySelectorAll('button')].find((node) => node.textContent === label);
const checkbox = (model) => card().querySelector(`[data-model-row="${model}"] input[type="checkbox"]`);
const click = (node) => act(async () => node.click());

test('only connected providers are listed, with their shown count', async (t) => {
  await mount(t, async () => undefined);
  const rows = [...document.querySelectorAll('[data-model-provider]')];
  assert.deepEqual(
    rows.map((row) => row.dataset.modelProvider),
    ['openai-oauth']
  );
  assert.match(rows[0].textContent, /OAuth/);
  assert.match(rows[0].textContent, /1 \/ 2 shown/);
});

test('Cancel and X discard the pending edits; nothing is saved', async (t) => {
  const calls = [];
  await mount(t, async (...args) => calls.push(args));
  await click(document.querySelector('[data-model-provider="openai-oauth"]'));
  assert.equal(button('Save', card()).disabled, true);
  assert.equal(card().textContent.includes('changed'), false);
  assert.match(card().querySelector('[data-model-row="gpt-5.5"]').textContent, /In use/);
  await click(checkbox('gpt-5.5'));
  assert.equal(checkbox('gpt-5.5').checked, false);
  assert.match(card().textContent, /1 changed/);
  assert.equal(button('Save', card()).disabled, false);
  await click(button('Cancel', card()));
  assert.equal(card(), null);
  await click(document.querySelector('[data-model-provider="openai-oauth"]'));
  assert.equal(checkbox('gpt-5.5').checked, true);
  await click(card().querySelector('[data-model-row="gpt-5.5"] .model-mgmt-star'));
  await click(card().querySelector('[data-settings-nested-close]'));
  assert.equal(card(), null);
  assert.deepEqual(calls, []);
});

test('Save sends every changed model at once and closes the card', async (t) => {
  const calls = [];
  await mount(t, async (...args) => calls.push(args));
  await click(document.querySelector('[data-model-provider="openai-oauth"]'));
  await click(checkbox('gpt-5.4'));
  await click(card().querySelector('[data-model-row="gpt-5.5"] .model-mgmt-star'));
  assert.match(card().textContent, /2 changed/);
  await click(button('Save', card()));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [
    'setModelPreferences',
    [
      'openai-oauth',
      [
        { model: 'gpt-5.5', favorite: true },
        { model: 'gpt-5.4', hidden: false },
      ],
    ],
  ]);
  assert.equal(card(), null);
});

test('bulk select applies to the current filter only', async (t) => {
  const calls = [];
  await mount(t, async (...args) => calls.push(args));
  await click(document.querySelector('[data-model-provider="openai-oauth"]'));
  await click(button('Hidden', card()));
  assert.deepEqual(
    [...card().querySelectorAll('[data-model-row]')].map((row) => row.dataset.modelRow),
    ['gpt-5.4']
  );
  await click(button('Select all', card()));
  await click(button('All', card()));
  assert.equal(checkbox('gpt-5.4').checked, true);
  assert.equal(checkbox('gpt-5.5').checked, true);
  assert.match(card().textContent, /1 changed/);
});

async function mountLive(t, initial, api = {}) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  const render = (next) =>
    act(async () =>
      root.render(
        next
          ? React.createElement(ModelManagementPanel, {
              api,
              data: next,
              snapshot: { provider: 'openai-oauth', model: 'gpt-5.5' },
              pending: '',
              run: async () => undefined,
              confirm: () => {},
            })
          : null
      )
    );
  await render(initial);
  return render;
}
const providerIds = () =>
  [...document.querySelectorAll('[data-model-provider]')].map((row) => row.dataset.modelProvider);

test('opening a hidden custom model shows its saved favorite even outside the live catalog', async (t) => {
  await mountLive(t, {
    ...data,
    providerSetup: {
      api: [
        {
          id: 'custom-team',
          name: 'Team',
          custom: true,
          authenticated: true,
          modelOverrides: { 'family/model': { hidden: true } },
          hiddenFavoriteModels: ['family/model'],
        },
      ],
    },
    models: [],
  });
  await click(document.querySelector('[data-model-provider="custom-team"]'));
  const star = card().querySelector('[data-model-row="family/model"] .model-mgmt-star');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(button('Save', card()).disabled, true);
  await click(star);
  assert.equal(button('Save', card()).disabled, false);
});

test('an open card keeps its edits through catalog updates and a missing provider', async (t) => {
  const render = await mountLive(t, data);
  await click(document.querySelector('[data-model-provider="openai-oauth"]'));
  await click(checkbox('gpt-5.4'));
  assert.match(card().textContent, /1 changed/);
  // New catalog with an extra model: rows update in place, the edit stays.
  await render({ ...data, models: [...data.models, option('openai-oauth', 'gpt-5.6')] });
  assert.ok(card());
  assert.equal(checkbox('gpt-5.4').checked, true);
  assert.ok(card().querySelector('[data-model-row="gpt-5.6"]'));
  // Data reloading (sections not loaded) and the provider missing from setup.
  await render({ __loadedSections: [] });
  assert.ok(card());
  await render({ ...data, providerSetup: { oauth: [], api: [], local: [] }, models: [] });
  assert.ok(card());
  assert.equal(checkbox('gpt-5.4').checked, true);
  assert.match(card().textContent, /Not connected/);
  assert.match(card().textContent, /1 changed/);
});

test('an incomplete catalog keeps rows and drafts until that provider actually returns an empty list', async (t) => {
  let reply;
  const api = { invokeCapability: async () => ({ value: reply }) };
  const read = (models, completeProviders) => {
    reply = { models: models.map(({ model: id, ...row }) => ({ id, ...row })), completeProviders };
    return act(async () => {
      await readModelManagementCatalog(api, true);
    });
  };
  const setup = {
    ...data.providerSetup,
    oauth: data.providerSetup.oauth.map((provider) => ({ ...provider, authenticated: true })),
  };
  const settings = { providerSetup: setup };
  const render = await mountLive(t, settings, api);
  await read(data.models, ['openai-oauth', 'anthropic-oauth']);
  const provider = () => document.querySelector('[data-model-provider="openai-oauth"]');
  await click(provider());
  await click(checkbox('gpt-5.4'));
  await read([option('openai-oauth', 'gpt-5.6')], []);
  assert.ok(checkbox('gpt-5.6'));
  assert.equal(checkbox('gpt-5.4').checked, true);
  assert.match(card().textContent, /1 changed/);
  await read([], []);
  await render({
    providerSetup: {
      ...setup,
      oauth: [{ ...setup.oauth[0], catalogError: { message: 'models 403' } }, setup.oauth[1]],
    },
  });
  assert.match(provider().textContent, /2 \/ 3 shown/);
  assert.match(provider().textContent, /403/);
  await render(null);
  await render(settings);
  assert.match(provider().textContent, /2 \/ 3 shown/);
  await render(null);
  await read([], ['openai-oauth']);
  await read([], []);
  await render(settings);
  await click(provider());
  assert.match(card().textContent, /0 \/ 0 shown/);
  assert.equal(button('Save', card()).disabled, true);
  assert.match(document.querySelector('[data-model-provider="anthropic-oauth"]').textContent, /1 \/ 1 shown/);
});

test('providers are listed in the Providers page order', async (t) => {
  const connected = (id, extra = {}) => ({ id, name: id, authenticated: true, ...extra });
  const setup = {
    oauth: [connected('a-oauth'), connected('b-oauth')],
    api: [connected('custom-z', { custom: true }), connected('zeta-api'), connected('alpha-api')],
    local: [],
  };
  await mountLive(t, {
    providerSetup: setup,
    models: ['a-oauth', 'b-oauth', 'custom-z', 'zeta-api', 'alpha-api'].map((id) => option(id, 'm1')),
    __loadedSections: ['providerSetup', 'models'],
  });
  assert.deepEqual(providerIds(), ['a-oauth', 'b-oauth', 'zeta-api', 'alpha-api', 'custom-z']);
});
