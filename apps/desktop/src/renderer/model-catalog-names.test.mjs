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

const { customProviderDisplayNames } = await import('./model-catalog.tsx');

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
