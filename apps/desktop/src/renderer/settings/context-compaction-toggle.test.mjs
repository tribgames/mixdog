import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { CategoryPanel } = await import('./capability-panels.tsx');

const LABEL = 'Compaction summary model';

async function renderContext(compaction, run, extraData = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(CategoryPanel, {
        category: 'context',
        context: {
          api: {},
          data: { compaction, autoClear: {}, sessionTitles: {}, ...extraData },
          snapshot: null,
          pending: '',
          run,
        },
      })
    );
  });
  return {
    select: () => document.querySelector(`button[role="combobox"][aria-label="${LABEL}"]`),
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('compaction summary select renders the saved mode, Smart by default, and saves summaryMode', async () => {
  const calls = [];
  const view = await renderContext({}, async (capability, args) => {
    calls.push([capability, args]);
    return {};
  });
  try {
    const select = view.select();
    assert.ok(select);
    assert.equal(select.querySelector('.mx-select-value').textContent, 'Smart');
    assert.equal(document.querySelector('input[aria-label="Use the Maintainer model for compaction"]'), null);
    await act(async () => select.click());
    const options = [...document.querySelectorAll('[role="option"]')];
    assert.deepEqual(
      options.map((option) => option.textContent),
      ['Smart', 'Maintainer', 'Conversation model']
    );
    await act(async () => options[2].click());
    assert.deepEqual(calls, [['setCompactionSettings', [{ summaryMode: 'self' }]]]);
  } finally {
    await view.cleanup();
  }
});

test('auto-clear idle windows name a custom provider by its registered name, built-ins by their label', async () => {
  const custom = 'custom-c07a1b4c-4df1-4f8a-9c10-2e5b8d9f0117';
  const view = await renderContext({}, async () => ({}), {
    autoClear: {
      providerDefaults: [{ provider: 'openai-oauth' }, { provider: custom }, { provider: 'custom-noname' }],
    },
    providerSetup: {
      api: [{ id: custom, name: 'Team Gateway', custom: true }],
      oauth: [{ id: 'openai-oauth', name: 'Renamed OAuth' }],
      local: [],
    },
  });
  try {
    const text = document.body.textContent;
    assert.match(text, /Team Gateway/);
    assert.equal(text.includes(custom), false);
    assert.match(text, /OpenAI OAuth/);
    assert.equal(text.includes('Renamed OAuth'), false);
    assert.match(text, /custom-noname/);
    assert.equal(text.includes('idle window'), false);
    assert.deepEqual(
      [...document.querySelectorAll('.settings-group > header h3')].map((h) => h.textContent),
      ['Session names', 'Compaction', 'Cache warming', 'Idle session cleanup']
    );
  } finally {
    await view.cleanup();
  }
});

const WARM_ROWS = [
  'Before scheduled runs',
  'Bot chats (idle)',
  'Bot rooms (idle)',
  'Favorite conversations (idle)',
  'Other conversations (idle)',
];
const warmBoxes = () => WARM_ROWS.map((name) => document.querySelector(`input[type="checkbox"][aria-label="${name}"]`));

test('cache warming: one check box per target, only scheduled runs by default, saves the chosen list', async () => {
  const calls = [];
  const run = async (capability, args) => {
    calls.push([capability, args]);
    return {};
  };
  let view = await renderContext({}, run);
  try {
    const boxes = warmBoxes();
    assert.ok(boxes.every(Boolean), 'a row per target');
    assert.deepEqual(
      boxes.map((box) => box.checked),
      [true, false, false, false, false],
      'absent setting: before scheduled runs only'
    );
    assert.match(document.body.textContent, /only while the next turn is likely enough to pay for it/);
    assert.match(document.body.textContent, /only when auto-clear is off or longer than the cache lifetime/);
    // A burst: each click builds on the last intended list.
    await act(async () => boxes[3].click());
    await act(async () => boxes[0].click());
    assert.deepEqual(calls, [
      ['setCacheWarmingTargets', [['scheduled', 'favorites']]],
      ['setCacheWarmingTargets', [['favorites']]],
    ]);
    assert.deepEqual(
      warmBoxes().map((box) => box.checked),
      [false, false, false, true, false]
    );
  } finally {
    await view.cleanup();
  }
  for (const [saved, checked] of [
    ['off', [false, false, false, false, false]],
    ['routine', [true, false, false, false, false]],
    [[], [false, false, false, false, false]],
    [['bot-rooms', 'conversations'], [false, false, true, false, true]],
  ]) {
    view = await renderContext({}, run, { cacheWarming: { cacheWarming: saved } });
    try {
      assert.deepEqual(
        warmBoxes().map((box) => box.checked),
        checked,
        `saved ${JSON.stringify(saved)}`
      );
    } finally {
      await view.cleanup();
    }
  }
});

test('cache warming: a failed save falls back to the saved list; a newer queued edit keeps its own', async () => {
  // `run` resolves undefined when the save failed (it already showed the
  // page's error) and the settings value when it succeeded.
  const pending = [];
  const run = (capability, args) =>
    new Promise((resolve) => pending.push({ capability, args, resolve }));
  const view = await renderContext({}, run, { cacheWarming: { cacheWarming: ['scheduled'] } });
  const checked = () => warmBoxes().map((box) => box.checked);
  try {
    await act(async () => warmBoxes()[0].click());
    assert.deepEqual(checked(), [false, false, false, false, false], 'optimistic while saving');
    await act(async () => pending[0].resolve(undefined));
    assert.deepEqual(checked(), [true, false, false, false, false], 'failed: the persisted list shows again');

    // Two queued edits: the older one failing leaves the newer intent alone.
    await act(async () => warmBoxes()[1].click());
    await act(async () => warmBoxes()[2].click());
    assert.deepEqual(pending.slice(1).map((call) => call.args[0]), [
      ['scheduled', 'bot-chats'],
      ['scheduled', 'bot-chats', 'bot-rooms'],
    ]);
    await act(async () => pending[1].resolve(undefined));
    assert.deepEqual(checked(), [true, true, true, false, false], 'the newer edit still shows');
    await act(async () => pending[2].resolve(undefined));
    assert.deepEqual(checked(), [true, false, false, false, false], 'the newest failing reconciles');
  } finally {
    await view.cleanup();
  }
});

test('compaction summary select shows each saved mode', async () => {
  for (const [summaryMode, label] of [
    ['smart', 'Smart'],
    ['maintainer', 'Maintainer'],
    ['self', 'Conversation model'],
  ]) {
    const view = await renderContext({ summaryMode }, async () => ({}));
    try {
      assert.equal(view.select().querySelector('.mx-select-value').textContent, label);
    } finally {
      await view.cleanup();
    }
  }
});
