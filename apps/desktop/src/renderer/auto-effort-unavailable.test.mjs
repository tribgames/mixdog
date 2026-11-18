import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event', 'CustomEvent'],
  actEnvironment: false,
});
globalThis.React = React;

const { cachedAutoEffortCapable } = await import('./auto-effort-store.ts');
const { routeEffortPane } = await import('./route-editor-panes.tsx');

const pane = (autoEffort) =>
  renderToStaticMarkup(
    routeEffortPane({
      effort: 'low',
      effortOptions: [{ value: 'low', label: 'Low' }],
      autoEffort,
      autoEffortOn: autoEffort?.enabled === true,
      tuningDisabled: false,
      onChangeEffort() {},
      onOptionKeyDown() {},
    })
  );

test('a model the catalog does not list is never Auto-capable: the card shows the saved level', () => {
  assert.equal(cachedAutoEffortCapable('openai-oauth', 'gpt-6.2-astra'), false);
});

test('the effort sheet says Auto is unavailable and keeps the level in force checked', () => {
  const html = pane({ enabled: false, pending: false, unavailable: true });
  assert.match(html, /data-effort-option="auto-unavailable"/);
  assert.match(html, /Auto is not available for this model/);
  assert.match(html, /aria-checked="true"[^>]*>\s*<span>Low/);
});

test('a capable model offers a live Auto choice and no unavailable note', () => {
  const html = pane({ enabled: true, pending: false });
  assert.match(html, /data-effort-option="auto"/);
  assert.doesNotMatch(html, /not available/);
});
