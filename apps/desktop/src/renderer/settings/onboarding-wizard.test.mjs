import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
  url: 'https://mixdog.test/',
  pretendToBeVisual: true,
});
for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'MutationObserver', 'CustomEvent']) {
  globalThis[name] = name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { createRoot } = await import('react-dom/client');
const { OnboardingWizard } = await import('./OnboardingWizard.tsx');

test.after(() => dom.window.close());

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const model = { provider: 'test', model: 'main', display: 'Main test', effortOptions: [], fastCapable: false };
const profile = {
  title: 'Before',
  experienceLevel: 'beginner',
  language: 'system',
  languages: [{ id: 'system', label: 'System' }, { id: 'ko', label: 'Korean' }],
};

async function mount(t, { step = 0, reads = {}, ...overrides } = {}) {
  window.localStorage.clear();
  window.localStorage.setItem('mixdog.onboarding.step', String(step));
  const calls = [];
  const values = {
    getProviderSetup: { api: [], oauth: [] },
    listWebSearchModels: [],
    listAgents: [],
    listOutputStyles: { styles: [{ id: 'simple', label: 'Simple' }, { id: 'detailed', label: 'Detailed' }], current: { id: 'simple' } },
    getProfile: profile,
    listWorkflows: [],
    getAutoClear: { enabled: true },
    getCompactionSettings: { auto: true },
    ...reads,
  };
  const api = {
    readCapabilities: async (requests) => requests.map(({ capability }) => ({ ok: true, value: values[capability] })),
    getSnapshot: async () => ({ provider: model.provider, model: model.model }),
    listProviderModels: async () => [model],
    invokeCapability: async (request) => { calls.push(request); return { value: {} }; },
    ...overrides,
  };
  window.mixdogDesktop = api;
  let completed = 0;
  const root = createRoot(document.querySelector('main'));
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(React.createElement(OnboardingWizard, { api, onDone: () => { completed += 1; } })));
  return { api, calls, completed: () => completed };
}

function button(text) {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent.trim() === text);
  assert.ok(found, `Missing button: ${text}`);
  return found;
}

async function click(element) {
  assert.ok(element);
  await act(async () => element.click());
}

async function go(step) {
  await click(document.querySelectorAll('.onboarding-progress-bar')[step]);
}

async function choose(label, option) {
  await click(document.querySelector(`[role="combobox"][aria-label="${label}"]`));
  await click([...document.querySelectorAll('[role="option"]')].find((entry) => entry.textContent.trim() === option));
}

async function typeTitle(value) {
  const input = document.querySelector('input[name="title"]');
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  return input;
}

test('profile saving blocks conflicting controls and retains the saved language after failure', async (t) => {
  const save = deferred();
  const calls = [];
  await mount(t, { invokeCapability: async (request) => { calls.push(request); return save.promise; } });
  await choose('Response language', 'Korean');
  const language = document.querySelector('[aria-label="Response language"]');
  assert.equal(language.disabled, true);
  assert.equal(language.textContent.trim(), 'System');
  assert.equal(button('Next').disabled, true);
  await act(async () => save.reject(new Error('Profile save failed')));
  assert.equal(language.textContent.trim(), 'System');
  assert.equal(language.disabled, false);
  assert.match(document.body.textContent, /Profile save failed/);
  assert.equal(calls.length, 1);
});

test('Ctrl+Enter commits the focused profile title before leaving the step', async (t) => {
  const save = deferred();
  const calls = [];
  await mount(t, { invokeCapability: async (request) => { calls.push(request); return save.promise; } });
  const input = await typeTitle('After');
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
  })));
  assert.deepEqual(calls[0], { capability: 'setProfile', args: [{ title: 'After' }] });
  assert.match(document.querySelector('h1').textContent, /Make it yours/);
  await act(async () => save.resolve({ value: {} }));
  await click(button('Next'));
  await go(0);
  assert.equal(document.querySelector('input[name="title"]').value, 'After');
});

test('failed output saves leave the selected style unchanged and allow retry', async (t) => {
  const save = deferred();
  let attempts = 0;
  await mount(t, { step: 7, invokeCapability: async () => {
    attempts += 1;
    return attempts === 1 ? save.promise : { value: {} };
  } });
  const choices = [...document.querySelectorAll('.onboarding-choice-grid button')];
  await click(choices[1]);
  assert.equal(choices[1].disabled, true);
  assert.equal(choices[0].classList.contains('selected'), true);
  await act(async () => save.reject(new Error('Style save failed')));
  assert.equal(choices[0].classList.contains('selected'), true);
  await click(choices[1]);
  assert.equal(choices[1].classList.contains('selected'), true);
  assert.equal(attempts, 2);
});

test('saved agent models are visible and Same as Main explicitly clears the override on finish', async (t) => {
  const { calls, completed } = await mount(t, {
    step: 2,
    reads: { listAgents: [{ id: 'explore', label: 'Explore', workflowSlot: true, route: { provider: 'test', model: 'saved' } }] },
  });
  assert.match(document.querySelector('[aria-label="Explore model"]').textContent, /saved/);
  await choose('Explore model', 'Same as Main');
  await go(9);
  await click(button('Finish'));
  assert.deepEqual(calls.at(-1), { capability: 'completeOnboarding', args: [{ agentRoutes: { explore: null } }] });
  assert.equal(completed(), 1);
});

test('model catalog errors are visible and retry replaces the empty catalog', async (t) => {
  let attempts = 0;
  await mount(t, { step: 2, listProviderModels: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Catalog offline');
    return [model];
  } });
  assert.match(document.body.textContent, /Catalog offline/);
  await click(button('Retry'));
  assert.doesNotMatch(document.body.textContent, /Catalog offline/);
  await click(document.querySelector('[aria-label="Main model"]'));
  assert.ok([...document.querySelectorAll('[role="option"]')].some((entry) => /Main test/.test(entry.textContent)));
  assert.equal(attempts, 2);
});

test('providers explain the supported local-model installation path', async (t) => {
  await mount(t, { step: 1 });
  assert.match(document.body.textContent, /Local models/);
  assert.match(document.body.textContent, /local-provider skill checks your PC/);
  assert.doesNotMatch(document.body.textContent, /local endpoint/);
});

test('Git identity failure is visible, never reports ready, and can be retried', async (t) => {
  let fail = true;
  const writes = [];
  const account = { login: 'tester', name: 'Test User', email: 'test@example.com' };
  await mount(t, {
    step: 4,
    githubCliStatus: async () => ({ installed: true, authenticated: true, login: 'tester' }),
    githubCliAccount: async () => account,
    gitGlobalConfig: async () => ({ name: '', email: '', defaultBranch: '' }),
    setGitGlobalConfig: async (key, value) => {
      writes.push([key, value]);
      if (key === 'user.email' && fail) throw new Error('Git config denied');
      return { name: account.name, email: account.email, defaultBranch: '' };
    },
  });
  assert.doesNotMatch(document.body.textContent, /Commits and pull requests are ready to go/);
  await click(button('Set up commit identity'));
  assert.match(document.body.textContent, /Git config denied/);
  assert.doesNotMatch(document.body.textContent, /Commits and pull requests are ready to go/);
  fail = false;
  await click(button('Set up commit identity'));
  assert.match(document.body.textContent, /Commits and pull requests are ready to go/);
  assert.doesNotMatch(document.body.textContent, /Git config denied/);
  assert.equal(writes.length, 4);
});

test('remote pairing explains a stalled relay instead of leaving a permanent loading card', async (t) => {
  const scheduled = [];
  const original = window.setTimeout;
  window.setTimeout = (callback, delay, ...args) => {
    if (delay > 1000 && delay <= 2000) {
      scheduled.push(() => callback(...args));
      return 0;
    }
    return original.call(window, callback, delay, ...args);
  };
  t.after(() => { window.setTimeout = original; });
  await mount(t, { step: 8, getRemoteAccessInfo: async () => null });
  for (let i = 0; i < 4; i += 1) {
    assert.ok(scheduled.length, 'Expected a bounded retry interval');
    await act(async () => scheduled.shift()());
  }
  assert.match(document.body.textContent, /check this PC’s internet connection/);
  assert.equal(document.querySelector('[aria-label="Preparing pairing code"]'), null);
});
