import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'Node', 'Element'],
});
test.after(restore);
// jsdom has no layout: the picker centers its selected row on open.
window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { ModelCatalog } = await import('./model-catalog.tsx');

const option = (provider, model, extra = {}) => ({
  provider,
  model,
  display: model,
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
  ...extra,
});

async function mount(t, props) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      React.createElement(ModelCatalog, {
        provider: 'openai-oauth',
        model: 'gpt-5.4',
        onSelect: () => true,
        onClose: () => {},
        ...props,
      })
    )
  );
}

const sections = () =>
  [...document.querySelectorAll('.model-group')].map((section) => ({
    title: section.querySelector('h3').textContent,
    rows: [...section.querySelectorAll('[role="option"] strong')].map((row) => row.firstChild.textContent),
  }));

test('/model lists Favorites, then Recent, then providers without their favorites', async (t) => {
  window.localStorage.setItem('mixdog.desktop-recent-models', JSON.stringify(['model:openai-oauth:gpt-5.5']));
  t.after(() => window.localStorage.clear());
  await mount(t, {
    models: [
      option('openai-oauth', 'gpt-5.5', { favorite: true }),
      option('openai-oauth', 'gpt-5.4'),
      option('anthropic-oauth', 'claude-opus-5', { favorite: true }),
      option('anthropic-oauth', 'claude-sonnet-5'),
    ],
  });
  const listed = sections();
  assert.deepEqual(
    listed.map((section) => section.title),
    ['Favorites', 'Recent', 'OpenAI OAuth', 'Anthropic OAuth']
  );
  assert.equal(listed[0].rows.length, 2);
  // A favorite may also be recent, but leaves its provider section.
  assert.equal(listed[1].rows.length, 1);
  assert.equal(listed[2].rows.length, 1);
  assert.equal(listed[3].rows.length, 1);
  assert.equal(document.querySelector('.model-group--provider [aria-selected="true"]') !== null, true);
});

test('the picker has no star; its "i" sits left of "+" and opens Model management', async (t) => {
  const opened = [];
  await mount(t, {
    models: [option('openai-oauth', 'gpt-5.4', { favorite: true })],
    onOpenProviders: () => opened.push('providers'),
    onOpenModelManagement: () => opened.push('models'),
  });
  assert.equal(document.querySelector('.lucide-star'), null);
  assert.equal(document.querySelector('[aria-label*="avorite"]'), null);
  const buttons = [...document.querySelectorAll('.model-search-wrapper > button')];
  assert.deepEqual(
    buttons.map((button) => button.getAttribute('aria-label')),
    ['Open model management', 'Add provider']
  );
  await act(async () => buttons[0].click());
  assert.deepEqual(opened, ['models']);
});
