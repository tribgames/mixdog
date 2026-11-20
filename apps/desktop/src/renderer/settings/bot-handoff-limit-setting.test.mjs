// Settings → Bots → Bot handoff limit: the real settings api over a fake core that keeps one config document, so a
// change in the field is a `config/value/write` of `desktop.botHandoffLimit` and the stored value is what the field shows.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from '../test-support/test-dom.mjs';
import { createSettingsApi } from '../core-direct/api-settings.ts';
import { BotHandoffLimitRow } from './bot-handoff-limit-setting.tsx';

const DOM = {
  rootId: 'root',
  expose: ['HTMLElement', 'Node', 'KeyboardEvent', 'Event', 'CustomEvent', 'HTMLInputElement'],
};
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

// `hold`: the first write waits for it. The core answers a connection's calls in the order sent, so later writes queue behind.
function fakeCore(stored, hold) {
  const config = { agent: {}, desktop: stored === undefined ? {} : { botHandoffLimit: stored } };
  const writes = [];
  let queue = Promise.resolve();
  let first = true;
  const call = async (method, params) => {
    if (method === 'config/value/write') {
      writes.push(params);
      const wait = first ? hold : undefined;
      first = false;
      const done = queue.then(async () => {
        await wait;
        config.desktop.botHandoffLimit = params.value;
      });
      queue = done;
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
  return { api, writes, config };
}

async function mount(t, api) {
  const dom = installTestDom(t, DOM);
  dom.window.mixdogDesktop = api;
  await act(async () => dom.root.render(React.createElement(BotHandoffLimitRow, {})));
  await settle();
  return dom.window;
}

const type = (window, input, text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

for (const [stored, shown] of [
  [undefined, '3'],
  [12, '12'],
  [99, '3'],
]) {
  test(`the field shows ${shown} when the stored limit is ${stored}`, async (t) => {
    const { api } = fakeCore(stored);
    const window = await mount(t, api);
    assert.equal(window.document.querySelector('input[aria-label="Bot handoff limit"]').value, shown);
  });
}

test('changing the field stores desktop.botHandoffLimit and the stored value is shown back', async (t) => {
  const { api, writes, config } = fakeCore(undefined);
  const window = await mount(t, api);
  const input = () => window.document.querySelector('input[aria-label="Bot handoff limit"]');
  await type(window, input(), '7');
  await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  assert.deepEqual(writes, [{ path: 'desktop.botHandoffLimit', value: 7, announce: 'desktop' }]);
  assert.equal(config.desktop.botHandoffLimit, 7);
  assert.equal(input().value, '7');
});

test('going back to the confirmed value while a save is still in flight is written, so the last edit wins', async (t) => {
  let release;
  const { api, writes, config } = fakeCore(3, new Promise((resolve) => (release = resolve)));
  const window = await mount(t, api);
  const input = () => window.document.querySelector('input[aria-label="Bot handoff limit"]');
  await type(window, input(), '7');
  await act(async () => input().dispatchEvent(new window.Event('focusout', { bubbles: true })));
  // The field keeps the committed 7 while its save is in flight; typed over, as a person edits the digits.
  assert.equal(input().value, '7');
  await type(window, input(), '30');
  await type(window, input(), '3');
  await act(async () => input().dispatchEvent(new window.Event('focusout', { bubbles: true })));
  await settle();
  assert.deepEqual(
    writes.map((write) => write.value),
    [7, 3]
  );
  assert.equal(input().value, '3');
  await act(async () => release());
  await settle();
  assert.equal(config.desktop.botHandoffLimit, 3);
  assert.equal(input().value, '3');
});

test('an entry typed while a save is pending survives that save and is written when the field is left', async (t) => {
  let release;
  const { api, writes, config } = fakeCore(3, new Promise((resolve) => (release = resolve)));
  const window = await mount(t, api);
  const input = () => window.document.querySelector('input[aria-label="Bot handoff limit"]');
  await type(window, input(), '7');
  await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await type(window, input(), '12');
  await act(async () => release());
  await settle();
  assert.equal(input().value, '12');
  await act(async () => input().dispatchEvent(new window.Event('focusout', { bubbles: true })));
  await settle();
  assert.deepEqual(
    writes.map((write) => write.value),
    [7, 12]
  );
  assert.equal(config.desktop.botHandoffLimit, 12);
});

test('the error goes away once a valid value is entered', async (t) => {
  const { api, writes } = fakeCore(5);
  const window = await mount(t, api);
  const input = () => window.document.querySelector('input[aria-label="Bot handoff limit"]');
  const enter = async (text) => {
    await type(window, input(), text);
    await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
  };
  await enter('21');
  assert.ok(window.document.querySelector('[role="alert"]'));
  await enter('5');
  assert.equal(window.document.querySelector('[role="alert"]'), null);
  assert.equal(input().value, '5');
  assert.deepEqual(writes, []);
});

test('a value outside 1 to 20 is never written', async (t) => {
  const { api, writes } = fakeCore(5);
  const window = await mount(t, api);
  const input = () => window.document.querySelector('input[aria-label="Bot handoff limit"]');
  for (const text of ['0', '21', '2.5']) {
    await type(window, input(), text);
    await act(async () => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
  }
  assert.deepEqual(writes, []);
  await assert.rejects(api.setBotHandoffLimit(21), /invalid/);
});
