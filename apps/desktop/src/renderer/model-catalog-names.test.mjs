import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['HTMLElement', 'Node'],
  actEnvironment: false,
});

globalThis.HTMLElement.prototype.scrollIntoView = () => {};

const { catalogProviderNames, customProviderDisplayNames, filterConfiguredModels, resolveProviderDisplayName } =
  await import('./model-catalog.tsx');

test('a server window keeps the desktop hidden custom models out of its picker', () => {
  const custom = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';
  const models = [
    { provider: custom, model: 'visible' },
    { provider: custom, model: 'hidden-on-desktop' },
    { provider: 'openai-oauth', model: 'gpt-test' },
  ];
  const setup = {
    managedByClient: true,
    api: [{ id: custom, custom: true, usable: true, modelOverrides: { 'hidden-on-desktop': { hidden: true } } }],
    oauth: [{ id: 'openai-oauth', usable: true }],
    local: [],
  };
  assert.deepEqual(filterConfiguredModels(models, setup), [models[0], models[2]]);
  setup.oauth[0].usable = false;
  assert.deepEqual(filterConfiguredModels(models, setup), [models[0]]);
});

test('built-in providers keep curated labels; custom ones use setup names', () => {
  const custom = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';
  const names = { openai: 'My OpenAI', [custom]: '내 AI' };
  assert.notEqual(resolveProviderDisplayName('openai', names), 'My OpenAI');
  assert.equal(resolveProviderDisplayName(custom, names), '내 AI');
  assert.equal(resolveProviderDisplayName(custom, {}), custom);
});

test('catalog rows name a custom provider while setup is null or failed', () => {
  const custom = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';
  const models = [
    { provider: custom, model: 'm', providerName: 'Gateway' },
    { provider: 'openai', model: 'g', providerName: 'Spoof' },
  ];
  // setup null (not loaded) and setup failed both yield no setup names.
  for (const setup of [null, undefined]) {
    const names = catalogProviderNames(models, customProviderDisplayNames(setup));
    assert.equal(resolveProviderDisplayName(custom, names), 'Gateway');
    assert.notEqual(resolveProviderDisplayName('openai', names), 'Spoof');
  }
  assert.equal(resolveProviderDisplayName(custom, catalogProviderNames([{ provider: custom, model: 'm' }])), custom);
  assert.equal(
    resolveProviderDisplayName(custom, catalogProviderNames(models, { [custom]: 'Setup name' })),
    'Setup name'
  );
});

test('a failed setup load still lists custom rows under their row name', () => {
  const custom = 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7';
  const models = [{ provider: custom, model: 'm', providerName: 'Gateway' }];
  const listed = filterConfiguredModels(models, null, 'setup failed');
  assert.deepEqual(listed, models);
  const names = catalogProviderNames(listed, customProviderDisplayNames(null));
  assert.deepEqual(names, { [custom]: 'Gateway' });
  assert.equal(resolveProviderDisplayName(custom, names), 'Gateway');
});

test('setup rows resolve provider ids to their chosen names', () => {
  const setup = {
    api: [
      { id: 'openai', name: 'OpenAI API', authenticated: true },
      {
        id: 'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7',
        name: '내 AI',
        custom: true,
        authenticated: true,
      },
      { id: 'custom-noname', custom: true },
    ],
    oauth: [{ id: 'openai-oauth', name: 'OpenAI OAuth' }],
    local: [],
  };
  assert.deepEqual(customProviderDisplayNames(setup), {
    openai: 'OpenAI API',
    'custom-a92e4651-dab8-45a1-aa63-70b7be71c1f7': '내 AI',
    'openai-oauth': 'OpenAI OAuth',
  });
});

test('missing or empty setup resolves to no names', () => {
  assert.deepEqual(customProviderDisplayNames(null), {});
  assert.deepEqual(customProviderDisplayNames(undefined), {});
  assert.deepEqual(customProviderDisplayNames({}), {});
});
