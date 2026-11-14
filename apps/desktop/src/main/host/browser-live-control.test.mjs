import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerBrowserLiveControlHost } from './browser-live-control.ts';

function setup() {
  const handlers = new Map();
  const calls = [];
  const connection = { handleRequest: (method, handler) => handlers.set(method, handler) };
  registerBrowserLiveControlHost(connection, () => ({
    resize: async (sessionId, request) => void calls.push(['resize', sessionId, request]),
    widenVideo: (sessionId, limit) => void calls.push(['widen', sessionId, limit]),
  }));
  const call = (params) => handlers.get('host/browser/liveControl')(params, new AbortController().signal);
  return { call, calls };
}

const invalid = (error) => error.code === -32602;

test('resize is forwarded', async () => {
  const { call, calls } = setup();
  const fit = { mode: 'fit-client', cssWidth: 390, cssHeight: 800, deviceScaleFactor: 3 };
  assert.equal(await call({ sessionId: 's1', kind: 'resize', request: fit }), null);
  assert.equal(await call({ sessionId: 's1', kind: 'resize', request: { mode: 'page' } }), null);
  assert.deepEqual(calls, [['resize', 's1', fit], ['resize', 's1', { mode: 'page' }]]);
});

test('videoLimit is forwarded', async () => {
  const { call, calls } = setup();
  assert.equal(await call({ sessionId: 's1', kind: 'videoLimit', request: { maxWidth: 2048, maxHeight: 1024 } }), null);
  assert.deepEqual(calls, [['widen', 's1', { maxWidth: 2048, maxHeight: 1024 }]]);
});

test('bad params are -32602', async () => {
  const { call, calls } = setup();
  const good = { mode: 'page' };
  for (const params of [
    { sessionId: 's1', kind: 'zoom', request: good },
    { kind: 'resize', request: good },
    { sessionId: '', kind: 'resize', request: good },
    { sessionId: 's1', kind: 'resize', request: { mode: 'other' } },
    { sessionId: 's1', kind: 'resize', request: { mode: 'fit-client', cssWidth: 0, cssHeight: 1, deviceScaleFactor: 1 } },
    { sessionId: 's1', kind: 'videoLimit', request: { maxWidth: -1, maxHeight: 10 } },
    { sessionId: 's1', kind: 'videoLimit', request: { maxWidth: Infinity, maxHeight: 10 } },
    { sessionId: 's1', kind: 'videoLimit', request: null },
    [],
    null,
  ]) await assert.rejects(call(params), invalid, JSON.stringify(params));
  assert.deepEqual(calls, []);
});
