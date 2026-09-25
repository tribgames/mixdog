import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
  url: 'https://mixdog.test/',
  pretendToBeVisual: true,
});
const domGlobals = { window: dom.window, document: dom.window.document };
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'Node',
  'MutationObserver',
  'CustomEvent',
]) {
  globalThis[name] = domGlobals[name] ?? dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { createRoot } = await import('react-dom/client');
const { OnboardingWizard } = await import('./OnboardingWizard.tsx');

test.after(() => dom.window.close());

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const profile = {
  title: 'Before',
  experienceLevel: 'beginner',
  language: 'system',
  languages: [
    { id: 'system', label: 'System' },
    { id: 'ko', label: 'Korean' },
  ],
};

async function mount(t, { step = 0, reads = {}, ...overrides } = {}) {
  window.localStorage.clear();
  window.localStorage.setItem('mixdog.onboarding.step', String(step));
  const calls = [];
  const values = {
    getProviderSetup: { api: [], oauth: [] },
    getProfile: profile,
    ...reads,
  };
  const api = {
    readCapabilities: async (requests) => requests.map(({ capability }) => ({ ok: true, value: values[capability] })),
    invokeCapability: async (request) => {
      calls.push(request);
      return { value: {} };
    },
    ...overrides,
  };
  window.mixdogDesktop = api;
  let completed = 0;
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      React.createElement(OnboardingWizard, {
        api,
        onDone: () => {
          completed += 1;
        },
      })
    )
  );
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
  await mount(t, {
    invokeCapability: async (request) => {
      calls.push(request);
      return save.promise;
    },
  });
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
  await mount(t, {
    invokeCapability: async (request) => {
      calls.push(request);
      return save.promise;
    },
  });
  const input = await typeTitle('After');
  await act(async () =>
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    )
  );
  assert.deepEqual(calls[0], { capability: 'setProfile', args: [{ title: 'After' }] });
  assert.match(document.querySelector('h1').textContent, /Make it yours/);
  await act(async () => save.resolve({ value: {} }));
  await click(button('Next'));
  await go(0);
  assert.equal(document.querySelector('input[name="title"]').value, 'After');
});

test('the wizard is profile, providers, Git, and star, and Finish marks onboarding done', async (t) => {
  const { calls, completed } = await mount(t);
  assert.equal(document.querySelectorAll('.onboarding-progress-bar').length, 4);
  await go(3);
  assert.match(document.querySelector('h1').textContent, /One last thing/);
  await click(button('Finish'));
  assert.deepEqual(calls.at(-1), { capability: 'skipOnboarding', args: [] });
  assert.equal(completed(), 1);
});

test('providers explain the supported local-model installation path', async (t) => {
  await mount(t, { step: 1 });
  assert.match(document.body.textContent, /Local models/);
  assert.match(document.body.textContent, /local-provider skill checks your PC/);
  assert.doesNotMatch(document.body.textContent, /local endpoint/);
});

test('a finished GitHub sign-in shows the account at once instead of offering Sign in again', async (t) => {
  const intervals = [];
  const original = window.setInterval;
  window.setInterval = (callback) => {
    intervals.push(callback);
    return 0;
  };
  t.after(() => {
    window.setInterval = original;
  });
  let statusCalls = 0;
  const account = { login: 'tester', name: 'Test User', email: 'test@example.com' };
  await mount(t, {
    step: 2,
    // First probe: signed out. The post-login refresh probe never settles, so
    // only the flow's own success can flip the card.
    githubCliStatus: () =>
      ++statusCalls === 1 ? Promise.resolve({ installed: true, authenticated: false }) : new Promise(() => {}),
    githubCliLoginStart: async () => ({ flowId: 'f1', state: 'code', code: 'ABCD-1234' }),
    githubCliLoginStatus: async () => ({ flowId: 'f1', state: 'success', login: 'tester' }),
    githubCliAccount: async () => account,
    gitGlobalConfig: async () => ({ name: account.name, email: account.email, defaultBranch: '' }),
    setGitGlobalConfig: async () => ({ name: account.name, email: account.email, defaultBranch: '' }),
  });
  await click(button('Sign in with GitHub'));
  assert.match(document.body.textContent, /ABCD-1234/);
  await act(async () => {
    intervals.at(-1)();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(![...document.querySelectorAll('button')].some((entry) => entry.textContent.trim() === 'Sign in with GitHub'));
  assert.doesNotMatch(document.body.textContent, /ABCD-1234/);
  assert.match(document.querySelector('.onboarding-card-title').textContent, /tester/);
});

test('Git identity failure is visible, never reports ready, and can be retried', async (t) => {
  let fail = true;
  const writes = [];
  const account = { login: 'tester', name: 'Test User', email: 'test@example.com' };
  await mount(t, {
    step: 2,
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
