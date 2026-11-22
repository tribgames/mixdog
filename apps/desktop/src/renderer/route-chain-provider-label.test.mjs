// #340: one model saved on an API key and on a subscription sign-in gave two
// identical chain rows. Each chain row now names its sign-in beside the model,
// derived from the provider id; the model chip elsewhere keeps its text.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement'],
});
const { createRoot } = await import('react-dom/client');
const { RouteChainEditor } = await import('./RouteChainEditor.tsx');
const { ModelRouteEditor } = await import('./ModelRouteEditor.tsx');
const { modelDisplayName } = await import('./provider-display.tsx');
test.after(() => dom.window.close());

const option = (provider, model) => ({ provider, model, effortOptions: [] });
const models = [
  option('openai', 'gpt-5.1-codex'),
  option('openai-oauth', 'gpt-5.1-codex'),
  option('anthropic-oauth', 'claude-sonnet-4-5'),
];
const codex = modelDisplayName('gpt-5.1-codex');
const sonnet = modelDisplayName('claude-sonnet-4-5');

async function render(t, element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => root.render(element));
  return host;
}

const chips = (host) =>
  [...host.querySelectorAll('.model-trigger .model-route-label')].map((label) => ({
    model: label.querySelector('.model-route-label-model')?.textContent,
    provider: label.querySelector('.model-route-label-provider')?.textContent ?? null,
  }));

test('each route chain row names how its route signs in beside the model', async (t) => {
  const host = await render(
    t,
    React.createElement(RouteChainEditor, {
      route: {
        provider: 'openai',
        model: 'gpt-5.1-codex',
        fallbacks: [
          { provider: 'openai-oauth', model: 'gpt-5.1-codex' },
          { provider: 'anthropic-oauth', model: 'claude-sonnet-4-5' },
        ],
      },
      models,
      disabled: false,
      composerParity: false,
      label: 'Model',
      onChange() {},
    })
  );
  assert.deepEqual(chips(host), [
    { model: codex, provider: 'OpenAI API' },
    { model: codex, provider: 'OpenAI OAuth' },
    { model: sonnet, provider: 'Anthropic OAuth' },
  ]);
  // The sign-in reads last, after the model and how it runs.
  for (const label of host.querySelectorAll('.model-trigger .model-route-label')) {
    assert.equal(label.lastElementChild.className, 'model-route-label-provider');
  }
  // aria-label replaces the visible text, so the name itself must tell the rows apart.
  const names = [...host.querySelectorAll('.model-trigger')].map((button) => button.getAttribute('aria-label'));
  assert.deepEqual(names, [
    `Model 1, ${codex}, OpenAI API`,
    `Model 2, ${codex}, OpenAI OAuth`,
    `Model 3, ${sonnet}, Anthropic OAuth`,
  ]);
});

test('the model chip outside a route chain keeps its model-only text', async (t) => {
  const host = await render(
    t,
    React.createElement(ModelRouteEditor, {
      models,
      value: { provider: 'openai-oauth', model: 'gpt-5.1-codex' },
      onChange() {},
    })
  );
  assert.deepEqual(chips(host), [{ model: codex, provider: null }]);
});
