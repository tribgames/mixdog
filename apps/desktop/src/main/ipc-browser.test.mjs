import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerBrowserIpc } from './ipc-browser.ts';

function setup(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const browserHost = {
    releaseSession: (id) => calls.push(['release', id]),
    browserPageFrame: async (id) => {
      calls.push(['frame', id]);
      return { id };
    },
    browserPageControl: async (id) => {
      calls.push(['control', id]);
    },
    browserPageMetadata: async (id) => ({ id }),
    ...overrides,
  };
  registerBrowserIpc({ handle: (channel, fn) => handlers.set(channel, fn), browserHost });
  return { call: (channel, ...args) => handlers.get(channel)({}, ...args), calls };
}

test('a released main page is never recreated by a late frame, control or metadata request', async () => {
  const { call, calls } = setup();
  const id = 'main-browser-a';
  await call(DESKTOP_IPC.browserPageFrame, id);
  await call(DESKTOP_IPC.browserReleasePage, id);
  for (const channel of [DESKTOP_IPC.browserPageFrame, DESKTOP_IPC.browserPageMetadata]) {
    await assert.rejects(async () => call(channel, id), /closed/);
  }
  await assert.rejects(
    async () => call(DESKTOP_IPC.browserPageControl, id, { type: 'reload', documentId: 'd' }),
    /closed/
  );
  assert.deepEqual(calls, [
    ['frame', id],
    ['release', id],
  ]);
  // Other pages are unaffected.
  await call(DESKTOP_IPC.browserPageFrame, 'main-browser-b');
});

test('a request that was creating the page when it was released drops the page it made', async () => {
  let finish;
  const gate = new Promise((resolve) => (finish = resolve));
  const { call, calls } = setup({
    browserPageFrame: async (id) => {
      await gate;
      calls.push(['frame', id]);
    },
  });
  const id = 'main-browser-c';
  const pending = call(DESKTOP_IPC.browserPageFrame, id);
  await call(DESKTOP_IPC.browserReleasePage, id);
  finish();
  await assert.rejects(pending, /closed/);
  assert.deepEqual(calls, [
    ['release', id],
    ['frame', id],
    ['release', id],
  ]);
});
