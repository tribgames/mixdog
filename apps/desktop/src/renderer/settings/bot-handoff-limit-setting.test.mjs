// Settings → Bots → Bot handoff limit: the real settings api over a fake core that keeps one config document, so a
// choice in the row is a `config/value/write` of `desktop.botHandoffLimit` and the stored value is what the row shows.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { createSettingsApi } from '../core-direct/api-settings.ts';
import { BotHandoffLimitRow } from './bot-handoff-limit-setting.tsx';

const DOM = {
  rootId: 'root',
  expose: [
    'MouseEvent',
    'Event',
    'CustomEvent',
    'HTMLElement',
    'Node',
    'MutationObserver',
    'KeyboardEvent',
    'FocusEvent',
  ],
};
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

// `gated`: each write waits until `finish(index)` lets it through. `fails`: every write is refused. The core answers a
// connection's calls in the order sent, so later writes queue behind.
function fakeCore(stored, { gated = false, fails = false } = {}) {
  const config = { agent: {}, desktop: stored === undefined ? {} : { botHandoffLimit: stored } };
  const writes = [];
  const gates = [];
  let queue = Promise.resolve();
  const call = async (method, params) => {
    if (method === 'config/value/write') {
      writes.push(params);
      const gate = gated ? new Promise((resolve) => gates.push(resolve)) : undefined;
      const done = queue.then(async () => {
        await gate;
        if (fails) throw new Error('refused');
        config.desktop.botHandoffLimit = params.value;
      });
      queue = done.catch(() => {});
      await done;
      return { values: [params.value] };
    }
    if (method === 'config/read') return { config };
    return undefined;
  };
  const connection = {
    call,
    notify() {},
    attach: () => () => undefined,
    watchFiles: async () => undefined,
    unwatchFiles: async () => undefined,
    // readSettings reads the held `config` sections, the core's pushed copy of the document.
    snapshot: () => ({
      status: 'ready',
      entries: Object.entries(config).map(([key, value]) => ({ section: 'config', key, revision: 1, value })),
    }),
    whenSynced: async () => undefined,
    onEvent: () => () => undefined,
    onStoreChange: () => () => undefined,
    client: () => ({ store: {} }),
  };
  const api = createSettingsApi({ connection, window: () => undefined, pcClient: () => null, call, setSender() {} });
  return { api, writes, config, finish: (index) => gates[index]() };
}

async function mount(t, api) {
  const dom = installTestDom(t, DOM);
  dom.window.mixdogDesktop = api;
  await act(async () => dom.root.render(React.createElement(BotHandoffLimitRow, {})));
  await settle();
  return dom.window;
}

const select = (window) => window.document.querySelector('button[role="combobox"][aria-label="Bot handoff limit"]');
const shown = (window) => select(window).textContent.trim();
const options = (window) => [...window.document.querySelectorAll('[role="listbox"] [role="option"]')];

/** Opens the select and picks `limit`, as a person does. */
async function choose(window, limit) {
  await act(async () => select(window).click());
  const option = options(window).find((entry) => entry.textContent.trim() === String(limit));
  await act(async () => option.click());
}

for (const [stored, expected] of [
  [undefined, '3'],
  [12, '12'],
  [99, '3'],
]) {
  test(`the row shows ${expected} when the stored limit is ${stored}`, async (t) => {
    const { api } = fakeCore(stored);
    const window = await mount(t, api);
    assert.equal(shown(window), expected);
  });
}

test('the row is a settings select like its neighbours, offering 1 to 20', async (t) => {
  const { api } = fakeCore(5);
  const window = await mount(t, api);
  assert.ok(select(window).closest('.settings-select'), 'the shared settings select');
  assert.equal(window.document.querySelector('input'), null, 'no free entry');
  await act(async () => select(window).click());
  assert.deepEqual(
    options(window).map((entry) => entry.textContent.trim()),
    Array.from({ length: 20 }, (_, index) => String(index + 1))
  );
  await assert.rejects(api.setBotHandoffLimit(21), /invalid/);
});

test('choosing a limit stores desktop.botHandoffLimit and the stored value is shown back', async (t) => {
  const { api, writes, config } = fakeCore(undefined);
  const window = await mount(t, api);
  await choose(window, 7);
  await settle();
  assert.deepEqual(writes, [{ path: 'desktop.botHandoffLimit', value: 7, announce: 'desktop' }]);
  assert.equal(config.desktop.botHandoffLimit, 7);
  assert.equal(shown(window), '7');
});

test('going back to the confirmed value while a save is still in flight is written, so the last choice wins', async (t) => {
  const { api, writes, config, finish } = fakeCore(3, { gated: true });
  const window = await mount(t, api);
  await choose(window, 7);
  // The row shows the chosen 7 while its save is in flight.
  assert.equal(shown(window), '7');
  await choose(window, 3);
  await settle();
  assert.deepEqual(
    writes.map((write) => write.value),
    [7, 3]
  );
  assert.equal(shown(window), '3');
  for (const write of [0, 1]) {
    await act(async () => finish(write));
    await settle();
  }
  assert.equal(config.desktop.botHandoffLimit, 3);
  assert.equal(shown(window), '3');
});

test('the row keeps the last choice while earlier saves of other limits settle', async (t) => {
  const { api, config, finish } = fakeCore(3, { gated: true });
  const window = await mount(t, api);
  for (const limit of [7, 12, 7]) await choose(window, limit);
  // The first 7 and the 12 are stored in turn: the row stays on the last choice, whose save is still to come.
  for (const [write, stored] of [
    [0, 7],
    [1, 12],
  ]) {
    await act(async () => finish(write));
    await settle();
    assert.equal(config.desktop.botHandoffLimit, stored);
    assert.equal(shown(window), '7');
  }
  await act(async () => finish(2));
  await settle();
  assert.equal(config.desktop.botHandoffLimit, 7);
  assert.equal(shown(window), '7');
});

test('choices that could not be saved leave the row on the stored limit, and can be made again', async (t) => {
  const { api, writes, config, finish } = fakeCore(3, { gated: true, fails: true });
  const window = await mount(t, api);
  await choose(window, 7);
  await choose(window, 12);
  for (const write of [0, 1]) {
    await act(async () => finish(write));
    await settle();
  }
  assert.equal(config.desktop.botHandoffLimit, 3);
  assert.equal(shown(window), '3');
  assert.ok(window.document.querySelector('[role="alert"]'), 'the failure is told');
  await choose(window, 7);
  assert.equal(writes.length, 3, 'the same limit can be chosen again');
});
