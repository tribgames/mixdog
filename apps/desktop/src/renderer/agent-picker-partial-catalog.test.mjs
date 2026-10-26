import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// Issue #205: Settings → Model management lists every connected provider's
// models, but an agent's model picker said "No connected provider models.".
// The Workflows panel's list comes from a day-long sidebar cache that can hold
// a boot-time partial (or empty) catalog. Opening an editor now reads the
// catalog the way Settings does, and keeps asking while the answer is partial
// or the provider setup is still provisional.

const storage = new Map();
const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement'],
});
dom.window.localStorage.getItem = (key) => (storage.has(key) ? storage.get(key) : null);
dom.window.localStorage.setItem = (key, value) => storage.set(key, String(value));
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { WorkflowEditorDialogs } = await import('./workflows-editors.tsx');
const { invalidateSharedModelCatalogRequest } = await import('./model-catalog-cache.ts');
test.after(() => dom.window.close());

const CUSTOM = 'custom-0a1b2c3d-0000-4000-8000-000000000001';
const row = (provider, model, display, extra = {}) => ({
  provider,
  model,
  display,
  effortOptions: [],
  fastCapable: false,
  fastPreferred: false,
  ...extra,
});
const OPENAI = [row('openai-oauth', 'gpt-6-luna', 'GPT-6-Luna')];
const OPENCODE = [row('opencode-go-oauth', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash')];
const OPENROUTER = [row(CUSTOM, 'meta/muse-spark', 'Muse Spark 1.3', { providerName: 'OpenRouter' })];
const ALL = [...OPENAI, ...OPENCODE, ...OPENROUTER];
const SETUP = {
  api: [{ id: CUSTOM, name: 'OpenRouter', custom: true, authenticated: true, enabled: true }],
  oauth: [
    { id: 'openai-oauth', name: 'OpenAI OAuth', authenticated: true },
    { id: 'opencode-go-oauth', name: 'OpenCode Go OAuth', authenticated: true },
  ],
  local: [],
};
const withAuth = (setup, authenticated) => ({
  ...setup,
  api: setup.api.map((entry) => ({ ...entry, authenticated })),
  oauth: setup.oauth.map((entry) => ({ ...entry, authenticated })),
});
// The no-secrets snapshot served while the keychain loads: nothing reads as connected.
const PENDING = { ...withAuth(SETUP, false), pendingSecrets: true };

const next = (answers, index) => {
  const answer = answers[Math.min(index, answers.length - 1)];
  return typeof answer === 'function' ? answer() : answer;
};

async function openAgentPicker(t, { cached, answers, setups = [SETUP], panelSetup = SETUP }) {
  invalidateSharedModelCatalogRequest();
  const calls = { models: 0, setup: 0 };
  const api = {
    // The daemon serves its old partial catalog while it refills.
    listProviderModels: async () => next(answers, calls.models++),
    invokeCapability: async () => ({ value: await next(setups, calls.setup++) }),
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const noop = () => {};
  const render = (open) =>
    act(async () =>
      root.render(
        React.createElement(WorkflowEditorDialogs, {
          api,
          editors: {
            editor: null,
            routeEditor: null,
            loadingEditor: null,
            agentEditor: open
              ? {
                  agent: {
                    id: 'worker',
                    name: 'Worker',
                    body: 'Work.',
                    route: { provider: 'openai-oauth', model: 'gpt-6-luna' },
                  },
                  deletable: false,
                }
              : null,
            cancelAgentEditor: noop,
            saveAgent: noop,
            setAgentEnabled: noop,
            deleteAgent: noop,
          },
          // What the sidebar cache holds: the partial boot list, or nothing.
          models: cached,
          providerSetup: panelSetup,
          webSearchModels: [],
          busy: false,
          error: '',
        })
      )
    );
  const settle = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const openPicker = async () => {
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    await act(async () => dialog.querySelector('.model-trigger').click());
    const modelRow = [...document.querySelectorAll('.route-sheet-row[role="menuitem"]')].find((node) =>
      node.textContent.includes('Model')
    );
    await act(async () => modelRow.click());
  };
  const options = () => [...document.querySelectorAll('.model-option-row')].map((node) => node.textContent).join('|');
  await render(true);
  await openPicker();
  return { calls, options, render, openPicker, settle };
}

test('the agent picker lists OpenCode Go and OpenRouter once the daemon refills a partial catalog', async (t) => {
  const partial = () =>
    OPENAI.map((entry) => ({
      ...entry,
      catalogPartial: true,
      catalogMissing: [CUSTOM, 'opencode-go-oauth'],
      catalogRetryAt: Date.now() + 1_000,
    }));
  const { calls, options, settle } = await openAgentPicker(t, { cached: OPENAI, answers: [partial, ALL] });
  assert.equal(calls.models, 1);
  assert.match(options(), /GPT-6-Luna/);
  assert.doesNotMatch(options(), /DeepSeek|Muse/);

  // The picker is still open when the retry time passes.
  await settle(1_200);
  assert.equal(calls.models, 2);
  assert.match(options(), /DeepSeek V4\.1 Flash/);
  assert.match(options(), /Muse Spark/);
  assert.equal(document.querySelector('.model-empty'), null);
});

test('an empty cached catalog does not leave the agent picker empty when the fresh read has models', async (t) => {
  const { options } = await openAgentPicker(t, { cached: [], answers: [ALL] });
  assert.match(options(), /GPT-6-Luna/);
  assert.match(options(), /DeepSeek V4\.1 Flash/);
  assert.match(options(), /Muse Spark/);
  assert.equal(document.querySelector('.model-empty'), null);
});

test('an empty first answer is read again while the editor stays open', async (t) => {
  // The 30 s empty-answer retry would stall the run: shorten only that timer.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms > 20_000 ? 0 : ms, ...rest);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
  });
  const { calls, options, settle } = await openAgentPicker(t, { cached: [], answers: [[], ALL] });
  await settle(100);
  assert.equal(calls.models, 2);
  assert.match(options(), /DeepSeek V4\.1 Flash/);
  assert.match(options(), /Muse Spark/);
});

test('a provisional provider setup keeps the picker listed, then filters once the real setup arrives', async (t) => {
  // A complete catalog: nothing but the setup can make this picker change.
  const authoritative = withAuth(SETUP, true);
  authoritative.oauth[1].authenticated = false;
  const { calls, options, settle } = await openAgentPicker(t, {
    cached: [],
    answers: [ALL],
    setups: [PENDING, authoritative],
  });
  assert.equal(calls.setup, 1);
  assert.match(options(), /GPT-6-Luna/);
  assert.match(options(), /DeepSeek V4\.1 Flash/);
  assert.equal(document.querySelector('.model-empty'), null);

  await settle(2_200);
  assert.equal(calls.setup, 2);
  assert.match(options(), /GPT-6-Luna/);
  assert.match(options(), /Muse Spark/);
  assert.doesNotMatch(options(), /DeepSeek/);
});

test('a missing provider setup is read again until a real one arrives, then filters the complete catalog', async (t) => {
  const authoritative = withAuth(SETUP, true);
  authoritative.oauth[1].authenticated = false;
  // The panel holds a partial list and no setup, and the editor's own setup read comes back empty.
  const { calls, options, settle } = await openAgentPicker(t, {
    cached: OPENAI,
    answers: [ALL],
    setups: [undefined, authoritative],
    panelSetup: null,
  });
  assert.equal(calls.setup, 1);
  assert.match(options(), /GPT-6-Luna/);

  await settle(2_200);
  assert.equal(calls.setup, 2);
  assert.match(options(), /GPT-6-Luna/);
  assert.match(options(), /Muse Spark/);
  assert.doesNotMatch(options(), /DeepSeek/);
});

test('closing and reopening the editor discards a response still in flight from the previous open', async (t) => {
  let releaseStale;
  const stale = () =>
    new Promise((resolve) => (releaseStale = () => resolve(withAuth({ ...SETUP, oauth: [SETUP.oauth[0]] }, true))));
  const { calls, options, render, openPicker, settle } = await openAgentPicker(t, {
    cached: [],
    answers: [ALL],
    setups: [stale, SETUP],
  });
  assert.equal(calls.setup, 1);
  await render(false);
  await render(true);
  await openPicker();
  assert.equal(calls.setup, 2);
  assert.match(options(), /DeepSeek V4\.1 Flash/);
  // The first open's setup (without OpenCode Go) answers last and must not win.
  releaseStale();
  await settle();
  assert.match(options(), /DeepSeek V4\.1 Flash/);
});
