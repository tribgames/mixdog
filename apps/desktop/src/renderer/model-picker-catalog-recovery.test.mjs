import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// #205 (audit): the bot/Mixy profile model picker reads the same 24 h sidebar
// snapshot as the Workflows panel. A boot-time partial catalog (a slow provider
// timed out) must be read again at its retry time and reach the open picker.

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'CustomEvent'],
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { AgentProfilePane } = await import('./AgentProfilePane.tsx');
const { resetSidebarReferenceCache } = await import('./sidebar-reference-cache.ts');
const { invalidateSharedModelCatalogRequest } = await import('./model-catalog-cache.ts');
test.after(() => dom.window.close());

const row = (provider, model, display, extra = {}) => ({ provider, model, display, effortOptions: [], ...extra });
const OPENAI = [row('openai-oauth', 'gpt-6-luna', 'GPT-6-Luna')];
const OPENCODE = [row('opencode-go-oauth', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash')];
const SETUP = {
  api: [],
  oauth: [
    { id: 'openai-oauth', name: 'OpenAI OAuth', authenticated: true },
    { id: 'opencode-go-oauth', name: 'OpenCode Go OAuth', authenticated: true },
  ],
  local: [],
};
const WATCHER = {
  id: 'github-watcher',
  name: 'GitHub 감시',
  description: '',
  body: 'Work.',
  avatar: { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' },
  route: { provider: 'openai-oauth', model: 'gpt-6-luna' },
  persona: '',
  disabled: false,
};

const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

async function pickerText() {
  await act(async () => document.querySelector('.agent-profile .model-trigger').click());
  await act(async () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve)));
  await act(async () => document.querySelector('.route-sheet .route-sheet-row').click());
  return document.querySelector('.route-sheet[data-drilled]').textContent;
}

test('the profile model picker recovers from a partial boot catalog once its retry time passes', async (t) => {
  resetSidebarReferenceCache();
  invalidateSharedModelCatalogRequest();
  let reads = 0;
  const api = {
    // The daemon answers with the OpenAI rows only until the slow provider has been refilled.
    listProviderModels: async () =>
      ++reads === 1
        ? OPENAI.map((entry) => ({ ...entry, catalogPartial: true, catalogRetryAt: Date.now() + 1_000 }))
        : [...OPENAI, ...OPENCODE],
    invokeCapability: async ({ capability }) => {
      if (capability === 'getAgentDefinition') return { value: WATCHER };
      if (capability === 'getProviderSetup') return { value: SETUP };
      if (capability === 'getChannelSetup') return { value: { schedules: [], webhooks: [] } };
      return { value: true };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(React.createElement(AgentProfilePane, { sessionId: 'sess_home_github-watcher', active: true, api }))
  );
  await settle(50);
  assert.equal(reads, 1);

  // The picker is not touched until after the retry time: nothing reopened the panel.
  await settle(1_300);
  assert.equal(reads, 2, 'the partial snapshot was read again');
  const catalog = await pickerText();
  assert.match(catalog, /GPT-6-Luna/);
  assert.match(catalog, /DeepSeek V4\.1 Flash/);
});
